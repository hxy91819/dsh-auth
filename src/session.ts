import type { IncomingMessage } from 'node:http'
import {
  authStateSecretId,
  loadAuthState,
  persistAuthState,
  type AdministratorState,
  type AuthenticationMethod,
  type StoredSession,
} from './auth-state.js'
import type { ResolvedConfig } from './config.js'
import { CookieSigner } from './crypto.js'
import { cookieNames, parseCookies } from './cookies.js'
import { parsePasswordHash } from './password.js'

interface AuthUser {
  readonly userId: 'admin'
  readonly username: string
  readonly roles: readonly ['admin']
}

export interface AuthSession {
  readonly token: string
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

function cloneAdministrator(value: AdministratorState): AdministratorState {
  return { ...value }
}

function cloneSessions(sessions: ReadonlyMap<string, StoredSession>): Map<string, StoredSession> {
  return new Map(Array.from(sessions, ([token, session]) => [token, { ...session }]))
}

/** Signed-cookie session store backed by the unified administrator authentication state. */
export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>()
  private readonly signer: CookieSigner
  private readonly cookieName: string
  private readonly secretId: string
  private administrator: AdministratorState

  constructor(private readonly config: ResolvedConfig, now: () => number = Date.now) {
    this.signer = new CookieSigner(config.sessionSecret)
    this.cookieName = cookieNames(config.secureCookies).session
    this.secretId = authStateSecretId(config.sessionSecret)
    const loaded = loadAuthState(config.authStateFile, this.secretId)
    this.administrator = loaded.document.administrator
    for (const session of loaded.document.sessions) this.sessions.set(session.token, session)
    const changed = this.prune(now()) || this.enforceCapacity()
    if (loaded.mustPersist || changed) this.persist()
  }

  create(
    now: number,
    authenticationMethod: AuthenticationMethod = 'password',
  ): { readonly cookieValue: string; readonly session: AuthSession } {
    const signed = this.signer.issue()
    const stored: StoredSession = {
      token: signed.token,
      authenticationMethod,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.config.sessionTtlSeconds * 1000,
    }
    this.mutate(() => {
      this.prune(now)
      while (this.sessions.size >= this.config.maxSessions) this.deleteOldest()
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
    if (this.expired(session, now)) {
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
    if (this.administrator.username === null || this.administrator.passwordHash === null) return undefined
    return { username: this.administrator.username, passwordHash: this.administrator.passwordHash }
  }

  initializeAdministrator(
    currentSessionToken: string,
    username: string,
    passwordHash: string,
    now: number,
  ): AdministratorInitialization {
    parsePasswordHash(passwordHash)
    if (username.length === 0 || /\p{C}/u.test(username)) throw new Error('administrator username is invalid')
    if (this.administrator.username !== null) return 'already-configured'
    if (!this.sessions.has(currentSessionToken)) return 'invalid-session'
    this.mutate(() => {
      this.administrator = { id: 'admin', username, passwordHash, configuredAt: now }
      for (const token of this.sessions.keys()) {
        if (token !== currentSessionToken) this.sessions.delete(token)
      }
    })
    return 'initialized'
  }

  private currentUser(): AuthUser {
    return { userId: 'admin', username: this.administrator.username ?? 'admin', roles: ['admin'] }
  }

  private view(session: StoredSession): AuthSession {
    return { ...session, user: this.currentUser() }
  }

  private expired(session: StoredSession, now: number): boolean {
    return session.expiresAt <= now || session.lastSeenAt + this.config.idleTtlSeconds * 1000 <= now
  }

  private prune(now: number): boolean {
    let changed = false
    for (const [token, session] of this.sessions) {
      if (this.expired(session, now)) {
        this.sessions.delete(token)
        changed = true
      }
    }
    return changed
  }

  private deleteOldest(): void {
    const oldest = this.sessions.keys().next().value
    if (oldest !== undefined) this.sessions.delete(oldest)
  }

  private enforceCapacity(): boolean {
    const changed = this.sessions.size > this.config.maxSessions
    while (this.sessions.size > this.config.maxSessions) this.deleteOldest()
    return changed
  }

  private mutate<T>(operation: () => T): T {
    const administrator = cloneAdministrator(this.administrator)
    const sessions = cloneSessions(this.sessions)
    try {
      const result = operation()
      this.persist()
      return result
    } catch (error) {
      this.administrator = administrator
      this.sessions.clear()
      for (const [token, session] of sessions) this.sessions.set(token, session)
      throw error
    }
  }

  private persist(): void {
    persistAuthState(this.config.authStateFile, {
      schemaVersion: 2,
      secretId: this.secretId,
      administrator: this.administrator,
      sessions: Array.from(this.sessions.values()),
    })
  }
}
