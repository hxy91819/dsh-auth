import type { IncomingMessage } from 'node:http'
import { CookieSigner } from './crypto.js'
import { cookieNames, parseCookies } from './cookies.js'
import type { ResolvedConfig } from './config.js'

/** Public single-account identity returned by authenticated endpoints. */
export interface AuthUser {
  readonly userId: string
  readonly username: string
  readonly roles: readonly string[]
}

/** Authenticated session view. */
export interface AuthSession {
  readonly token: string
  readonly user: AuthUser
  readonly createdAt: number
  readonly expiresAt: number
  lastSeenAt: number
}

/** Signed-cookie session store with server-side revocation and absolute plus idle expiry. */
export class SessionStore {
  private readonly sessions = new Map<string, AuthSession>()
  private readonly signer: CookieSigner
  private readonly cookieName: string

  constructor(private readonly config: ResolvedConfig) {
    this.signer = new CookieSigner(config.sessionSecret)
    this.cookieName = cookieNames(config.secureCookies).session
  }

  /** Create one session and evict the oldest when the configured cap is reached. */
  create(now: number): { readonly cookieValue: string; readonly session: AuthSession } {
    this.prune(now)
    while (this.sessions.size >= this.config.maxSessions) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    const signed = this.signer.issue()
    const session: AuthSession = {
      token: signed.token,
      user: this.config.user,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.config.sessionTtlSeconds * 1000,
    }
    this.sessions.set(signed.token, session)
    return { cookieValue: signed.value, session }
  }

  /** Authenticate a request and update idle activity for a live session. */
  authenticate(req: IncomingMessage, now: number): AuthSession | undefined {
    const raw = parseCookies(req.headers.cookie).get(this.cookieName)
    const token = this.signer.verify(raw)
    if (token === undefined) return undefined
    const session = this.sessions.get(token)
    if (session === undefined) return undefined
    if (session.expiresAt <= now || session.lastSeenAt + this.config.idleTtlSeconds * 1000 <= now) {
      this.sessions.delete(token)
      return undefined
    }
    session.lastSeenAt = now
    return session
  }

  /** Revoke the session named by a request cookie. */
  revoke(req: IncomingMessage): void {
    const raw = parseCookies(req.headers.cookie).get(this.cookieName)
    const token = this.signer.verify(raw)
    if (token !== undefined) this.sessions.delete(token)
  }

  private prune(now: number): void {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now || session.lastSeenAt + this.config.idleTtlSeconds * 1000 <= now) {
        this.sessions.delete(token)
      }
    }
  }
}
