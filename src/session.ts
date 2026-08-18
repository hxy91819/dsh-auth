import { createHmac, randomBytes } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { CookieSigner } from './crypto.js'
import { cookieNames, parseCookies } from './cookies.js'
import type { ResolvedConfig } from './config.js'

const SESSION_FILE_VERSION = 1
const MAX_SESSION_FILE_BYTES = 1024 * 1024
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

/** Public single-account identity returned by authenticated endpoints. */
interface AuthUser {
  readonly userId: string
  readonly username: string
  readonly roles: readonly string[]
}

/** Authenticated session view. */
export interface AuthSession {
  readonly token: string
  readonly user: AuthUser
  readonly createdAt: number
  expiresAt: number
  lastSeenAt: number
}

/** Successful authentication plus an optional renewed cookie value. */
export interface SessionAuthentication {
  readonly session: AuthSession
  readonly renewalCookieValue?: string
}

interface PersistedSession {
  readonly token: string
  readonly createdAt: number
  readonly lastSeenAt: number
  readonly expiresAt: number
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`)
  return value as number
}

function readSessionState(path: string): Record<string, unknown> | undefined {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw new Error(`sessionStoreFile cannot be inspected: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!stat.isFile()) throw new Error('sessionStoreFile must be a regular file, not a symlink or directory')
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('sessionStoreFile permissions must not allow group or other access')
  }
  if (stat.size === 0 || stat.size > MAX_SESSION_FILE_BYTES) {
    throw new Error(`sessionStoreFile must contain 1-${String(MAX_SESSION_FILE_BYTES)} bytes`)
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`sessionStoreFile is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return object(decoded, 'sessionStoreFile')
}

function persistedSession(value: unknown): PersistedSession {
  const saved = object(value, 'persisted session')
  if (typeof saved.token !== 'string' || !SESSION_TOKEN_PATTERN.test(saved.token)) {
    throw new Error('persisted session token is invalid')
  }
  const session = {
    token: saved.token,
    createdAt: timestamp(saved.createdAt, 'persisted session createdAt'),
    lastSeenAt: timestamp(saved.lastSeenAt, 'persisted session lastSeenAt'),
    expiresAt: timestamp(saved.expiresAt, 'persisted session expiresAt'),
  }
  if (session.createdAt > session.lastSeenAt || session.lastSeenAt > session.expiresAt) {
    throw new Error('persisted session timestamps are inconsistent')
  }
  return session
}

/** Signed-cookie session store with revocation, sliding renewal, and optional durable storage. */
export class SessionStore {
  private readonly sessions = new Map<string, AuthSession>()
  private readonly signer: CookieSigner
  private readonly cookieName: string
  private readonly secretId: string

  constructor(private readonly config: ResolvedConfig, now: () => number = Date.now) {
    this.signer = new CookieSigner(config.sessionSecret)
    this.cookieName = cookieNames(config.secureCookies).session
    this.secretId = createHmac('sha256', config.sessionSecret)
      .update('dsh-auth-session-store-v1')
      .digest('base64url')
    this.load(now())
  }

  /** Create one session and evict the oldest when the configured cap is reached. */
  create(now: number): { readonly cookieValue: string; readonly session: AuthSession } {
    const signed = this.signer.issue()
    const session: AuthSession = {
      token: signed.token,
      user: this.config.user,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.config.sessionTtlSeconds * 1000,
    }
    this.mutate(() => {
      this.prune(now)
      while (this.sessions.size >= this.config.maxSessions) {
        const oldest = this.sessions.keys().next().value
        if (oldest === undefined) break
        this.sessions.delete(oldest)
      }
      this.sessions.set(signed.token, session)
    })
    return { cookieValue: signed.value, session }
  }

  /** Authenticate a request, checkpoint activity, and renew the rolling expiry when due. */
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
      return { session }
    }

    this.mutate(() => {
      session.lastSeenAt = nextLastSeenAt
      session.expiresAt = Math.max(session.expiresAt, now + this.config.sessionTtlSeconds * 1000)
    })
    return { session, renewalCookieValue: raw }
  }

  /** Revoke the session named by a request cookie and persist the revocation immediately. */
  revoke(req: IncomingMessage): void {
    const raw = parseCookies(req.headers.cookie).get(this.cookieName)
    const token = this.signer.verify(raw)
    if (token !== undefined && this.sessions.has(token)) {
      this.mutate(() => { this.sessions.delete(token) })
    }
  }

  private expired(session: AuthSession, now: number): boolean {
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

  private mutate<T>(operation: () => T): T {
    const snapshot = new Map(Array.from(this.sessions, ([token, session]) => [token, { ...session }]))
    try {
      const result = operation()
      this.persist()
      return result
    } catch (error) {
      this.sessions.clear()
      for (const [token, session] of snapshot) this.sessions.set(token, session)
      throw error
    }
  }

  private load(now: number): void {
    const path = this.config.sessionStoreFile
    if (path === undefined) return
    const state = readSessionState(path)
    if (state === undefined) return
    if (state.version !== SESSION_FILE_VERSION) throw new Error('sessionStoreFile has an unsupported version')
    if (typeof state.secretId !== 'string' || typeof state.userId !== 'string' || !Array.isArray(state.sessions)) {
      throw new Error('sessionStoreFile has invalid metadata')
    }
    if (state.sessions.length > 4096) throw new Error('sessionStoreFile contains too many sessions')
    if (state.secretId !== this.secretId || state.userId !== this.config.user.userId) {
      this.persist()
      return
    }

    for (const entry of state.sessions) {
      const persisted = persistedSession(entry)
      if (this.sessions.has(persisted.token)) throw new Error('sessionStoreFile contains a duplicate session')
      this.sessions.set(persisted.token, { ...persisted, user: this.config.user })
    }

    let changed = this.prune(now)
    while (this.sessions.size > this.config.maxSessions) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
      changed = true
    }
    if (changed) this.persist()
  }

  private persist(): void {
    const path = this.config.sessionStoreFile
    if (path === undefined) return
    const state = {
      version: SESSION_FILE_VERSION,
      secretId: this.secretId,
      userId: this.config.user.userId,
      sessions: Array.from(this.sessions.values(), ({ token, createdAt, lastSeenAt, expiresAt }) => ({
        token,
        createdAt,
        lastSeenAt,
        expiresAt,
      })),
    }
    const temporary = `${path}.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      renameSync(temporary, path)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== 'ENOENT') {
          throw new AggregateError([error, cleanupError], 'sessionStoreFile update and cleanup failed')
        }
      }
      throw new Error(`sessionStoreFile cannot be updated: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
