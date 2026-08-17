import { TLSSocket } from 'node:tls'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { constantTimeTextEqual, CookieSigner } from './crypto.js'
import { authCookie, cookieNames, parseCookies } from './cookies.js'
import { accountPage, loginPage } from './html.js'
import type { AuthMessage } from './html.js'
import { BROWSER_BOOTSTRAP_FILE, browserBootstrapSource } from './browser-bootstrap.js'
import { LoginLimiter } from './limiter.js'
import { verifyPassword } from './password.js'
import { resolveUiPreferences } from './preferences.js'
import type { HarnessUiSettings, UiPreferences } from './preferences.js'
import { SessionStore } from './session.js'
import type { SessionAuthentication } from './session.js'
import type { ResolvedConfig } from './config.js'

const MAX_FORM_BYTES = 20 * 1024
const HTML_SECURITY_HEADERS = {
  'cache-control': 'no-store, max-age=0',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function normalizeRemoteAddress(value: string | undefined): string {
  if (value?.startsWith('::ffff:') === true) return value.slice('::ffff:'.length)
  return value ?? 'unknown'
}

function firstForwarded(value: string | undefined): string | undefined {
  return value?.split(',', 1)[0]?.trim()
}

function isTrustedProxy(req: IncomingMessage, config: ResolvedConfig): boolean {
  return config.trustedProxyAddresses.has(normalizeRemoteAddress(req.socket.remoteAddress))
}

function clientAddress(req: IncomingMessage, config: ResolvedConfig): string {
  if (!isTrustedProxy(req, config)) return normalizeRemoteAddress(req.socket.remoteAddress)
  return firstForwarded(headerValue(req, 'x-real-ip'))
    ?? firstForwarded(headerValue(req, 'x-forwarded-for'))
    ?? normalizeRemoteAddress(req.socket.remoteAddress)
}

function publicOrigin(req: IncomingMessage, config: ResolvedConfig): string | undefined {
  const proxy = isTrustedProxy(req, config)
  const protocol = proxy
    ? firstForwarded(headerValue(req, 'x-forwarded-proto'))
    : req.socket instanceof TLSSocket ? 'https' : 'http'
  const host = proxy
    ? firstForwarded(headerValue(req, 'x-forwarded-host')) ?? req.headers.host
    : req.headers.host
  if ((protocol !== 'http' && protocol !== 'https') || host === undefined || /[\s\\/]/u.test(host)) return undefined
  try {
    return new URL(`${protocol}://${host}`).origin
  } catch {
    return undefined
  }
}

function hasSameOrigin(req: IncomingMessage, config: ResolvedConfig): boolean {
  const expected = publicOrigin(req, config)
  if (expected === undefined) return false
  const supplied = headerValue(req, 'origin') ?? headerValue(req, 'referer')
  if (supplied === undefined) return false
  try {
    return new URL(supplied).origin === expected
  } catch {
    return false
  }
}

function protectedRequestOriginAllowed(req: IncomingMessage, config: ResolvedConfig): boolean {
  const originalMethod = headerValue(req, 'x-original-method') ?? 'GET'
  const originalUpgrade = headerValue(req, 'x-original-upgrade')
  if ((originalMethod === 'GET' || originalMethod === 'HEAD') && originalUpgrade === undefined) return true
  const fetchSite = headerValue(req, 'sec-fetch-site')
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  return hasSameOrigin(req, config)
}

/** Keep redirects on this origin and preserve only an absolute path/query. */
export function safeReturnTarget(value: string | null | undefined): string {
  if (value === undefined || value === null || value.length === 0 || value.length > 4096) return '/'
  let hasControl = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) {
      hasControl = true
      break
    }
  }
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || hasControl) return '/'
  try {
    const parsed = new URL(value, 'https://dsh-auth.invalid')
    if (parsed.origin !== 'https://dsh-auth.invalid') return '/'
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/'
  }
}

function write(res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(body)
}

function writeHtml(res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { ...HTML_SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(body)
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(303, { ...HTML_SECURITY_HEADERS, location, ...headers })
  res.end()
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(status, {
    'cache-control': 'no-store, max-age=0',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const mediaType = headerValue(req, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/x-www-form-urlencoded') {
    return Promise.reject(new HttpError(415, 'form content type required'))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      req.removeAllListeners('data')
      req.removeAllListeners('end')
      req.resume()
      reject(error)
    }
    req.on('error', fail)
    req.on('aborted', () => { fail(new HttpError(400, 'request aborted')) })
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_FORM_BYTES) {
        fail(new HttpError(413, 'form too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
    })
  })
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** HTTP authentication application mounted into the DSH WebServer. */
export class AuthApplication {
  private readonly sessions: SessionStore
  private readonly csrfSigner: CookieSigner
  private readonly limiter: LoginLimiter
  private readonly cookieNames: { readonly session: string; readonly csrf: string }

  constructor(
    private readonly config: ResolvedConfig,
    private readonly now: () => number = Date.now,
    private readonly readHarnessUiSettings: () => HarnessUiSettings = () => ({}),
  ) {
    this.sessions = new SessionStore(config, now)
    this.csrfSigner = new CookieSigner(config.sessionSecret)
    this.cookieNames = cookieNames(config.secureCookies)
    this.limiter = new LoginLimiter(
      config.loginWindowSeconds * 1000,
      config.loginMaxAttempts,
      config.loginBlockSeconds * 1000,
    )
  }

  /** Handle one request under the configured auth prefix. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh-auth.invalid')
      const path = url.pathname
      if (path === this.config.basePath && req.method === 'GET') {
        redirect(res, `${this.config.basePath}/login`)
        return
      }
      if (path === `${this.config.basePath}/login`) {
        await this.login(req, res, url)
        return
      }
      if (path === `${this.config.basePath}/${BROWSER_BOOTSTRAP_FILE}`) {
        this.browserBootstrap(req, res)
        return
      }
      if (path === `${this.config.basePath}/session`) {
        this.session(req, res)
        return
      }
      if (path === `${this.config.basePath}/csrf`) {
        this.csrf(req, res)
        return
      }
      if (path === `${this.config.basePath}/account`) {
        this.account(req, res)
        return
      }
      if (path === `${this.config.basePath}/logout`) {
        await this.logout(req, res)
        return
      }
      if (path === `${this.config.basePath}/verify`) {
        this.verify(req, res)
        return
      }
      write(res, 404, 'not found')
    } catch (error) {
      if (error instanceof HttpError) {
        write(res, error.status, error.message, { 'cache-control': 'no-store' })
        return
      }
      throw error
    }
  }

  private async login(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const returnTo = safeReturnTarget(url.searchParams.get('returnTo'))
    const preferences = resolveUiPreferences(req, this.readHarnessUiSettings())
    if (req.method === 'GET') {
      const authenticated = this.sessions.authenticate(req, this.now())
      if (authenticated !== undefined) {
        redirect(res, returnTo, this.renewalHeaders(authenticated))
        return
      }
      this.renderLogin(res, 200, returnTo, preferences)
      return
    }
    if (req.method !== 'POST') {
      write(res, 405, 'method not allowed', { allow: 'GET, POST', 'cache-control': 'no-store' })
      return
    }
    if (!hasSameOrigin(req, this.config)) throw new HttpError(403, 'cross-origin request denied')
    const form = await readForm(req)
    const formReturnTo = safeReturnTarget(form.get('returnTo'))
    if (!this.validCsrf(req, form.get('csrf'))) throw new HttpError(403, 'invalid CSRF token')
    const limiterKey = clientAddress(req, this.config)
    const retryAfter = this.limiter.consume(limiterKey, this.now())
    if (retryAfter !== undefined) {
      const csrf = this.issueCsrf()
      writeHtml(res, 429, loginPage(this.config.basePath, formReturnTo, csrf.token, preferences, 'rateLimited'), {
        'retry-after': String(retryAfter),
        'set-cookie': this.cookie(this.cookieNames.csrf, csrf.value, 10 * 60),
      })
      return
    }
    const username = form.get('username') ?? ''
    const submitted = form.get('password') ?? ''
    const passwordBytes = Buffer.byteLength(submitted, 'utf8')
    const password = passwordBytes <= this.config.maxPasswordBytes ? submitted : ''
    const [passwordMatches, usernameMatches] = await Promise.all([
      verifyPassword(password, this.config.passwordHash),
      Promise.resolve(constantTimeTextEqual(username, this.config.user.username, this.config.sessionSecret)),
    ])
    if (!passwordMatches || !usernameMatches || passwordBytes > this.config.maxPasswordBytes) {
      this.renderLogin(res, 401, formReturnTo, preferences, 'invalidCredentials')
      return
    }
    this.limiter.reset(limiterKey)
    const created = this.sessions.create(this.now())
    redirect(res, formReturnTo, {
      'set-cookie': [
        this.cookie(this.cookieNames.session, created.cookieValue, this.config.sessionTtlSeconds),
        this.cookie(this.cookieNames.csrf, '', 0),
      ],
    })
  }

  private browserBootstrap(req: IncomingMessage, res: ServerResponse): void {
    if (this.config.secureCookies) {
      write(res, 404, 'not found')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      write(res, 405, 'method not allowed', { allow: 'GET, HEAD', 'cache-control': 'no-store' })
      return
    }
    res.writeHead(200, {
      'cache-control': 'no-store, max-age=0',
      'content-type': 'text/javascript; charset=utf-8',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : browserBootstrapSource())
  }

  private session(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      write(res, 405, 'method not allowed', { allow: 'GET', 'cache-control': 'no-store' })
      return
    }
    const authenticated = this.sessions.authenticate(req, this.now())
    if (authenticated === undefined) {
      writeJson(res, 401, { authenticated: false })
      return
    }
    const { session } = authenticated
    writeJson(res, 200, {
      authenticated: true,
      user: session.user,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
    }, this.renewalHeaders(authenticated))
  }

  private csrf(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      write(res, 405, 'method not allowed', { allow: 'GET', 'cache-control': 'no-store' })
      return
    }
    const authenticated = this.sessions.authenticate(req, this.now())
    if (authenticated === undefined) {
      writeJson(res, 401, { authenticated: false })
      return
    }
    const csrf = this.issueCsrf()
    writeJson(res, 200, { csrf: csrf.token }, {
      'set-cookie': [
        ...this.renewalCookies(authenticated),
        this.cookie(this.cookieNames.csrf, csrf.value, 10 * 60),
      ],
    })
  }

  private account(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      write(res, 405, 'method not allowed', { allow: 'GET', 'cache-control': 'no-store' })
      return
    }
    const preferences = resolveUiPreferences(req, this.readHarnessUiSettings())
    const authenticated = this.sessions.authenticate(req, this.now())
    if (authenticated === undefined) {
      const target = encodeURIComponent(`${this.config.basePath}/account`)
      redirect(res, `${this.config.basePath}/login?returnTo=${target}`)
      return
    }
    const csrf = this.issueCsrf()
    writeHtml(res, 200, accountPage(this.config.basePath, authenticated.session, csrf.token, preferences), {
      'set-cookie': [
        ...this.renewalCookies(authenticated),
        this.cookie(this.cookieNames.csrf, csrf.value, 10 * 60),
      ],
    })
  }

  private async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      write(res, 405, 'method not allowed', { allow: 'POST', 'cache-control': 'no-store' })
      return
    }
    if (!hasSameOrigin(req, this.config)) throw new HttpError(403, 'cross-origin request denied')
    const form = await readForm(req)
    if (!this.validCsrf(req, form.get('csrf'))) throw new HttpError(403, 'invalid CSRF token')
    this.sessions.revoke(req)
    redirect(res, `${this.config.basePath}/login`, {
      'set-cookie': [this.cookie(this.cookieNames.session, '', 0), this.cookie(this.cookieNames.csrf, '', 0)],
    })
  }

  private verify(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      write(res, 405, 'method not allowed', { allow: 'GET, HEAD', 'cache-control': 'no-store' })
      return
    }
    if (!protectedRequestOriginAllowed(req, this.config)) {
      write(res, 403, 'cross-origin request denied', { 'cache-control': 'no-store' })
      return
    }
    const authenticated = this.sessions.authenticate(req, this.now())
    if (authenticated === undefined) {
      const original = safeReturnTarget(headerValue(req, 'x-original-uri'))
      const login = `${this.config.basePath}/login?returnTo=${encodeURIComponent(original)}`
      res.writeHead(401, {
        'cache-control': 'no-store, max-age=0',
        'vary': 'Cookie',
        'www-authenticate': 'Session realm="DeepSeek Harness"',
        'x-dsh-auth-login': login,
      })
      res.end()
      return
    }
    res.writeHead(204, {
      'cache-control': 'no-store, max-age=0',
      'vary': 'Cookie',
      'x-dsh-auth-user-id': authenticated.session.user.userId,
      'x-dsh-auth-username': encodeURIComponent(authenticated.session.user.username),
      'x-dsh-auth-roles': authenticated.session.user.roles.join(','),
      ...this.renewalHeaders(authenticated),
    })
    res.end()
  }

  private renderLogin(
    res: ServerResponse,
    status: number,
    returnTo: string,
    preferences: UiPreferences,
    message?: AuthMessage,
  ): void {
    const csrf = this.issueCsrf()
    writeHtml(res, status, loginPage(this.config.basePath, returnTo, csrf.token, preferences, message), {
      'set-cookie': this.cookie(this.cookieNames.csrf, csrf.value, 10 * 60),
    })
  }

  private issueCsrf(): { readonly token: string; readonly value: string } {
    return this.csrfSigner.issue()
  }

  private validCsrf(req: IncomingMessage, submitted: string | null): boolean {
    if (submitted === null) return false
    const signed = parseCookies(req.headers.cookie).get(this.cookieNames.csrf)
    const token = this.csrfSigner.verify(signed)
    return token !== undefined && constantTimeTextEqual(token, submitted, this.config.sessionSecret)
  }

  private renewalCookies(authenticated: SessionAuthentication): readonly string[] {
    return authenticated.renewalCookieValue === undefined
      ? []
      : [this.cookie(this.cookieNames.session, authenticated.renewalCookieValue, this.config.sessionTtlSeconds)]
  }

  private renewalHeaders(authenticated: SessionAuthentication): Record<string, string | string[]> {
    const cookies = this.renewalCookies(authenticated)
    return cookies.length === 0 ? {} : { 'set-cookie': [...cookies] }
  }

  private cookie(name: string, value: string, maxAgeSeconds: number): string {
    return authCookie(name, value, maxAgeSeconds, this.config.secureCookies)
  }
}

/** Public helper for tests and non-Cordis Node hosts. */
export function createAuthApplication(config: ResolvedConfig, now?: () => number): AuthApplication {
  return new AuthApplication(config, now)
}
