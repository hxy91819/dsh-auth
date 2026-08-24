import type { IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import {
  authStateSecretId,
  loadAuthState,
  MAX_AUTH_ACCOUNTS,
  MAX_STORED_SESSIONS,
  persistAuthState,
  type AccountId,
  type AccountMode,
  type AccountRole,
  type AccountState,
  type AccountStatus,
  type AuthenticationMethod,
  type StoredSession,
} from './auth-state.js'
import type { ResolvedConfig } from './config.js'
import { constantTimeTextEqual, CookieSigner } from './crypto.js'
import { cookieNames, parseCookies } from './cookies.js'
import { parseAccountUsername, parsePasswordHash } from './password.js'

interface AuthUser {
  readonly userId: AccountId
  readonly username: string
  readonly roles: readonly AccountRole[]
}

export interface AuthSession {
  readonly token: string
  readonly accountId: AccountId
  readonly accountAuthVersion: number
  readonly authenticationMethod: AuthenticationMethod
  readonly user: AuthUser
  readonly createdAt: number
  readonly expiresAt: number
  readonly lastSeenAt: number
}

export interface SessionAuthentication {
  readonly session: AuthSession
  readonly renewalCookieValue?: string
}

export type AdministratorInitialization = 'initialized' | 'already-configured' | 'invalid-session'
export type AdministratorPasswordUpdate = 'updated' | 'not-configured' | 'invalid-session'
export type AccountModeUpdate = 'updated' | 'unchanged'
export type AccountCreation = 'created' | 'duplicate-username' | 'preview-disabled' | 'limit-reached'
export type AccountStatusUpdate = 'updated' | 'unchanged' | 'not-found' | 'admin-immutable'

export interface PublicAccount {
  readonly id: AccountId
  readonly username: string | null
  readonly role: AccountRole
  readonly status: AccountStatus
  readonly authVersion: number
  readonly createdAt: number
  readonly configuredAt: number | null
}

export interface PublicAccountActivity extends PublicAccount {
  readonly activeSessions: number
  readonly lastSeenAt: number | null
}

export interface PasswordLoginCredential {
  readonly accountId?: AccountId
  readonly username: string
  readonly passwordHash: string
}

function cloneAccount(value: AccountState): AccountState {
  return { ...value }
}

function cloneAccounts(accounts: ReadonlyMap<AccountId, AccountState>): Map<AccountId, AccountState> {
  return new Map(Array.from(accounts, ([id, account]) => [id, cloneAccount(account)]))
}

function cloneSessions(sessions: ReadonlyMap<string, StoredSession>): Map<string, StoredSession> {
  return new Map(Array.from(sessions, ([token, session]) => [token, { ...session }]))
}

function newAccountId(): AccountId {
  return `acct_${randomBytes(16).toString('base64url')}` as AccountId
}

function publicAccount(account: AccountState): PublicAccount {
  return { ...account }
}

/** Signed-cookie session store backed by the unified administrator authentication state. */
export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>()
  private readonly accounts = new Map<AccountId, AccountState>()
  private readonly signer: CookieSigner
  private readonly cookieName: string
  private readonly secretId: string
  private mode: AccountMode

  constructor(private readonly config: ResolvedConfig, now: () => number = Date.now) {
    this.signer = new CookieSigner(config.sessionSecret)
    this.cookieName = cookieNames(config.secureCookies).session
    this.secretId = authStateSecretId(config.sessionSecret)
    const loaded = loadAuthState(config.authStateFile, this.secretId)
    this.mode = loaded.document.accountMode
    for (const account of loaded.document.accounts) this.accounts.set(account.id, account)
    for (const session of loaded.document.sessions) this.sessions.set(session.token, session)
    const changed = this.prune(now()) || this.enforceCapacity()
    if (loaded.mustPersist || changed) this.persist()
  }

  create(
    now: number,
    authenticationMethod: AuthenticationMethod = 'password',
    accountId: AccountId = 'admin',
  ): { readonly cookieValue: string; readonly session: AuthSession } {
    const account = this.accounts.get(accountId)
    if (account === undefined || !this.accountCanCreateSession(account)) {
      throw new Error('account cannot create a session')
    }
    const signed = this.signer.issue()
    const stored: StoredSession = {
      token: signed.token,
      accountId,
      accountAuthVersion: account.authVersion,
      authenticationMethod,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.config.sessionTtlSeconds * 1000,
    }
    this.mutate(() => {
      this.prune(now)
      while (this.accountSessionCount(accountId) >= this.config.maxSessions) this.deleteOldest(accountId)
      while (this.sessions.size >= MAX_STORED_SESSIONS) this.deleteOldest()
      this.sessions.set(signed.token, stored)
    })
    return { cookieValue: signed.value, session: this.view(stored) }
  }

  authenticate(req: IncomingMessage, now: number): SessionAuthentication | undefined {
    const raw = parseCookies(req.headers.cookie).get(this.cookieName)
    if (raw === undefined) return undefined
    const token = this.signer.verify(raw)
    if (token === undefined) return undefined
    const session = this.sessions.get(token)
    if (session === undefined) return undefined
    if (this.expired(session, now) || this.sessionInvalid(session)) {
      this.mutate(() => { this.sessions.delete(token) })
      return undefined
    }

    const nextLastSeenAt = Math.max(session.lastSeenAt, now)
    const renewalDueAt = session.expiresAt - this.config.sessionTtlSeconds * 1000
      + this.config.sessionRenewalSeconds * 1000
    if (now < renewalDueAt) {
      session.lastSeenAt = nextLastSeenAt
      return { session: this.view(session) }
    }

    this.mutate(() => {
      session.lastSeenAt = nextLastSeenAt
      session.expiresAt = Math.max(session.expiresAt, now + this.config.sessionTtlSeconds * 1000)
    })
    return { session: this.view(session), renewalCookieValue: raw }
  }

  revoke(req: IncomingMessage): void {
    const raw = parseCookies(req.headers.cookie).get(this.cookieName)
    const token = this.signer.verify(raw)
    if (token !== undefined && this.sessions.has(token)) {
      this.mutate(() => { this.sessions.delete(token) })
    }
  }

  passwordCredentials(): { readonly username: string; readonly passwordHash: string } | undefined {
    return this.accountPasswordCredentials('admin')
  }

  administratorConfigured(): boolean {
    return this.passwordCredentials() !== undefined
  }

  accountMode(): AccountMode {
    return this.mode
  }

  listAccounts(): readonly PublicAccount[] {
    return Array.from(this.accounts.values(), publicAccount)
  }

  listAccountActivity(now: number): readonly PublicAccountActivity[] {
    const changed = this.prune(now) || this.enforceCapacity()
    if (changed) this.persist()
    const activity = new Map<AccountId, { activeSessions: number; lastSeenAt: number | null }>()
    for (const accountId of this.accounts.keys()) {
      activity.set(accountId, { activeSessions: 0, lastSeenAt: null })
    }
    for (const session of this.sessions.values()) {
      const account = activity.get(session.accountId)
      if (account === undefined) continue
      account.activeSessions += 1
      account.lastSeenAt = account.lastSeenAt === null
        ? session.lastSeenAt
        : Math.max(account.lastSeenAt, session.lastSeenAt)
    }
    return Array.from(this.accounts.values(), account => ({
      ...publicAccount(account),
      ...(activity.get(account.id) ?? { activeSessions: 0, lastSeenAt: null }),
    }))
  }

  accountPasswordCredentials(accountId: AccountId): { readonly username: string; readonly passwordHash: string } | undefined {
    const account = this.accounts.get(accountId)
    if (account?.username === undefined || account.username === null || account.passwordHash === null) return undefined
    return { username: account.username, passwordHash: account.passwordHash }
  }

  passwordLoginCredential(username: string, secret: Buffer): PasswordLoginCredential | undefined {
    let fallback: PasswordLoginCredential | undefined
    let selected: PasswordLoginCredential | undefined
    for (const account of this.accounts.values()) {
      if (!this.accountCanPasswordLogin(account)) continue
      if (account.username === null || account.passwordHash === null) continue
      const candidate: PasswordLoginCredential = {
        accountId: account.id,
        username: account.username,
        passwordHash: account.passwordHash,
      }
      fallback ??= candidate
      if (constantTimeTextEqual(username, account.username, secret)) selected = candidate
    }
    if (selected !== undefined) return selected
    return fallback === undefined ? undefined : { username: fallback.username, passwordHash: fallback.passwordHash }
  }

  initializeAdministrator(
    currentSessionToken: string,
    username: string,
    passwordHash: string,
    now: number,
  ): AdministratorInitialization {
    parsePasswordHash(passwordHash)
    const normalized = parseAccountUsername(username)
    const admin = this.accounts.get('admin')
    if (admin === undefined) return 'invalid-session'
    if (admin.username !== null) return 'already-configured'
    const current = this.sessions.get(currentSessionToken)
    if (current?.accountId !== 'admin') return 'invalid-session'
    this.mutate(() => {
      admin.username = normalized
      admin.passwordHash = passwordHash
      admin.status = 'active'
      admin.configuredAt = now
      admin.authVersion += 1
      for (const token of this.sessions.keys()) {
        if (token !== currentSessionToken) this.sessions.delete(token)
      }
      const retained = this.sessions.get(currentSessionToken)
      if (retained !== undefined) {
        retained.accountAuthVersion = admin.authVersion
        retained.lastSeenAt = Math.max(retained.lastSeenAt, now)
      }
    })
    return 'initialized'
  }

  /** Replace the current account password hash and revoke that account's other sessions. */
  updateCurrentAccountPassword(
    currentSessionToken: string,
    passwordHash: string,
    now: number,
  ): AdministratorPasswordUpdate {
    parsePasswordHash(passwordHash)
    const current = this.sessions.get(currentSessionToken)
    if (current === undefined) return 'invalid-session'
    const account = this.accounts.get(current.accountId)
    if (account === undefined || this.sessionInvalid(current)) return 'invalid-session'
    if (account.username === null || account.passwordHash === null) return 'not-configured'
    this.mutate(() => {
      account.passwordHash = passwordHash
      account.configuredAt = now
      account.status = 'active'
      account.authVersion += 1
      for (const [token, session] of this.sessions) {
        if (session.accountId === account.id && token !== currentSessionToken) this.sessions.delete(token)
      }
      const retained = this.sessions.get(currentSessionToken)
      if (retained !== undefined) {
        retained.accountAuthVersion = account.authVersion
        retained.lastSeenAt = Math.max(retained.lastSeenAt, now)
      }
    })
    return 'updated'
  }

  updateAdministratorPassword(
    currentSessionToken: string,
    passwordHash: string,
    now: number,
  ): AdministratorPasswordUpdate {
    return this.updateCurrentAccountPassword(currentSessionToken, passwordHash, now)
  }

  setTrustedTeamPreview(enabled: boolean): AccountModeUpdate {
    const next: AccountMode = enabled ? 'trusted-team-preview' : 'single'
    if (this.mode === next) return 'unchanged'
    this.mutate(() => {
      this.mode = next
      if (!enabled) {
        for (const [token, session] of this.sessions) {
          if (session.accountId !== 'admin') this.sessions.delete(token)
        }
      }
    })
    return 'updated'
  }

  createMemberAccount(username: string, passwordHash: string, now: number): {
    readonly result: AccountCreation
    readonly account?: PublicAccount
  } {
    parsePasswordHash(passwordHash)
    if (this.mode !== 'trusted-team-preview') return { result: 'preview-disabled' }
    if (this.accounts.size >= MAX_AUTH_ACCOUNTS) return { result: 'limit-reached' }
    const normalized = parseAccountUsername(username)
    if (this.usernameExists(normalized)) return { result: 'duplicate-username' }
    let account: AccountState | undefined
    this.mutate(() => {
      let next: AccountState
      do {
        next = {
          id: newAccountId(),
          username: normalized,
          passwordHash,
          role: 'member',
          status: 'active',
          authVersion: 1,
          createdAt: now,
          configuredAt: now,
        }
      } while (this.accounts.has(next.id))
      account = next
      this.accounts.set(next.id, next)
    })
    return account === undefined ? { result: 'limit-reached' } : { result: 'created', account: publicAccount(account) }
  }

  setMemberStatus(accountId: AccountId, status: Exclude<AccountStatus, 'pending'>): AccountStatusUpdate {
    if (accountId === 'admin') return 'admin-immutable'
    const account = this.accounts.get(accountId)
    if (account?.role !== 'member') return 'not-found'
    if (account.status === status) return 'unchanged'
    this.mutate(() => {
      account.status = status
      account.authVersion += 1
      if (status === 'disabled') {
        for (const [token, session] of this.sessions) {
          if (session.accountId === accountId) this.sessions.delete(token)
        }
      }
    })
    return 'updated'
  }

  private currentUser(account: AccountState): AuthUser {
    return {
      userId: account.id,
      username: account.username ?? 'admin',
      roles: [account.role],
    }
  }

  private view(session: StoredSession): AuthSession {
    const account = this.accounts.get(session.accountId)
    if (account === undefined) throw new Error('session references an unknown account')
    return { ...session, user: this.currentUser(account) }
  }

  private expired(session: StoredSession, now: number): boolean {
    return session.expiresAt <= now || session.lastSeenAt + this.config.idleTtlSeconds * 1000 <= now
  }

  private sessionInvalid(session: StoredSession): boolean {
    const account = this.accounts.get(session.accountId)
    if (account?.authVersion !== session.accountAuthVersion) return true
    if (account.status === 'disabled') return true
    if (account.status === 'pending') return account.id !== 'admin'
    return account.role === 'member' && this.mode !== 'trusted-team-preview'
  }

  private prune(now: number): boolean {
    let changed = false
    for (const [token, session] of this.sessions) {
      if (this.expired(session, now) || this.sessionInvalid(session)) {
        this.sessions.delete(token)
        changed = true
      }
    }
    return changed
  }

  private deleteOldest(accountId?: AccountId): void {
    for (const [token, session] of this.sessions) {
      if (accountId === undefined || session.accountId === accountId) {
        this.sessions.delete(token)
        return
      }
    }
  }

  private enforceCapacity(): boolean {
    let changed = false
    for (const accountId of this.accounts.keys()) {
      while (this.accountSessionCount(accountId) > this.config.maxSessions) {
        this.deleteOldest(accountId)
        changed = true
      }
    }
    while (this.sessions.size > MAX_STORED_SESSIONS) {
      this.deleteOldest()
      changed = true
    }
    return changed
  }

  private accountSessionCount(accountId: AccountId): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.accountId === accountId) count += 1
    }
    return count
  }

  private accountCanCreateSession(account: AccountState): boolean {
    if (account.status === 'disabled') return false
    if (account.status === 'pending') return account.id === 'admin'
    if (account.role === 'member' && this.mode !== 'trusted-team-preview') return false
    return true
  }

  private accountCanPasswordLogin(account: AccountState): boolean {
    return account.status === 'active' && (account.role === 'admin' || this.mode === 'trusted-team-preview')
  }

  private usernameExists(username: string): boolean {
    const normalized = username.toLocaleLowerCase('en-US')
    return Array.from(this.accounts.values()).some(account =>
      account.username?.toLocaleLowerCase('en-US') === normalized)
  }

  private mutate<T>(operation: () => T): T {
    const mode = this.mode
    const accounts = cloneAccounts(this.accounts)
    const sessions = cloneSessions(this.sessions)
    try {
      const result = operation()
      this.persist()
      return result
    } catch (error) {
      this.mode = mode
      this.accounts.clear()
      for (const [id, account] of accounts) this.accounts.set(id, account)
      this.sessions.clear()
      for (const [token, session] of sessions) this.sessions.set(token, session)
      throw error
    }
  }

  private persist(): void {
    persistAuthState(this.config.authStateFile, {
      schemaVersion: 3,
      secretId: this.secretId,
      accountMode: this.mode,
      accounts: Array.from(this.accounts.values()),
      sessions: Array.from(this.sessions.values()),
    })
  }
}
