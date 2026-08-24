import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleAdminAccounts } from './admin-accounts.js'
import { handleAdminPasswordChange } from './admin-password.js'
import { BROWSER_BOOTSTRAP_FILE, browserBootstrapSource } from './browser-bootstrap.js'
import type { ResolvedConfig } from './config.js'
import { authCookie, cookieNames, parseCookies } from './cookies.js'
import { constantTimeTextEqual, CookieSigner } from './crypto.js'
import {
  accountPage,
  adminSetupCompletePage,
  adminSetupForbiddenPage,
  adminSetupPage,
  loginPage,
  tokenBridgePage,
  tokenDeniedPage,
  tokenFailurePage,
  tokenRateLimitedPage,
  type AuthMessage,
  type SetupMessage,
  type TokenFailureMessages,
} from './html.js'
import {
  clientAddress,
  hasSameOrigin,
  headerValue,
  HttpError,
  protectedRequestOriginAllowed,
  readForm,
  redirect,
  safeReturnTarget,
  write,
  writeHtml,
  writeJson,
  writeTokenHtml,
} from './http.js'
import { LoginLimiter } from './limiter.js'
import { LoginTokenStore, createNodeTokenHost } from './login-token-store.js'
import { clientLogId, errorLogFields, silentAuthLogger } from './logging.js'
import type { AuthEventLogger } from './logging.js'
import {
  ADMIN_PASSWORD_MAX_BYTES,
  assertAdministratorPassword,
  hashPassword,
  parseAdministratorUsername,
  verifyPassword,
} from './password.js'
import { resolveUiPreferences } from './preferences.js'
import type { HarnessUiSettings, UiPreferences } from './preferences.js'
import { SessionStore } from './session.js'
import type { PublicAccountActivity, SessionAuthentication } from './session.js'
import { TOKEN_BOOTSTRAP_FILE, tokenBootstrapSource } from './token-bootstrap.js'

/** HTTP authentication application mounted into the DSH WebServer. */
export class AuthApplication {
  private readonly sessions: SessionStore
  private readonly csrfSigner: CookieSigner
  private readonly limiter: LoginLimiter
  private readonly tokenLimiter: LoginLimiter
  private readonly tokenStore: LoginTokenStore | undefined
  private readonly cookieNames: { readonly session: string; readonly csrf: string }

  constructor(
    private readonly config: ResolvedConfig,
    private readonly now: () => number = Date.now,
    private readonly readHarnessUiSettings: () => HarnessUiSettings = () => ({}),
    private readonly logger: AuthEventLogger = silentAuthLogger,
  ) {
    this.sessions = new SessionStore(config, now)
    this.csrfSigner = new CookieSigner(config.sessionSecret)
    this.cookieNames = cookieNames(config.secureCookies)
    this.limiter = new LoginLimiter(
      config.loginWindowSeconds * 1000,
      config.loginMaxAttempts,
      config.loginBlockSeconds * 1000,
    )
    this.tokenLimiter = new LoginLimiter(
      config.loginTokenWindowSeconds * 1000,
      config.loginTokenMaxAttempts,
      config.loginTokenBlockSeconds * 1000,
    )
    if (config.loginTokenEnabled && config.loginTokenDirectory !== undefined) {
      this.tokenStore = new LoginTokenStore({
        host: createNodeTokenHost(),
        directory: config.loginTokenDirectory,
        now: () => this.now(),
      })
    }
  }

  /** Handle one request under the configured auth prefix. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let route = 'unknown'
    try {
      const url = new URL(req.url ?? '/', 'http://dsh-auth.invalid')
      const path = url.pathname
      route = this.routeName(path)
      if (path === this.config.basePath && req.method === 'GET') {
        redirect(res, `${this.config.basePath}/login`)
        return
      }
      if (path === `${this.config.basePath}/login`) {
        await this.login(req, res, url)
        return
      }
      if (path === `${this.config.basePath}/${TOKEN_BOOTSTRAP_FILE}`) {
        this.tokenBootstrap(req, res)
        return
      }
      if (path === `${this.config.basePath}/token`) {
        await this.token(req, res)
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
      if (path === `${this.config.basePath}/admin/setup`) {
        await this.adminSetup(req, res, url)
        return
      }
      if (path === `${this.config.basePath}/admin/password`) {
        await handleAdminPasswordChange(req, res, url, {
          config: this.config,
          sessions: this.sessions,
          limiter: this.limiter,
          now: this.now,
          readHarnessUiSettings: this.readHarnessUiSettings,
          cookieNames: this.cookieNames,
          issueCsrf: () => this.issueCsrf(),
          validCsrf: (request, submitted) => this.validCsrf(request, submitted),
          cookie: (name, value, maxAgeSeconds) => this.cookie(name, value, maxAgeSeconds),
          renewalCookies: authenticated => this.renewalCookies(authenticated),
          renewalHeaders: authenticated => this.renewalHeaders(authenticated),
          logger: this.logger,
          clientId: request => this.clientId(request),
        })
        return
      }
      if (path === `${this.config.basePath}/admin/accounts`) {
        await handleAdminAccounts(req, res, {
          config: this.config,
          sessions: this.sessions,
          now: this.now,
          readHarnessUiSettings: this.readHarnessUiSettings,
          cookieNames: this.cookieNames,
          issueCsrf: () => this.issueCsrf(),
          validCsrf: (request, submitted) => this.validCsrf(request, submitted),
          cookie: (name, value, maxAgeSeconds) => this.cookie(name, value, maxAgeSeconds),
          renewalCookies: authenticated => this.renewalCookies(authenticated),
          renewalHeaders: authenticated => this.renewalHeaders(authenticated),
          clientId: request => this.clientId(request),
          logger: this.logger,
        })
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
        const reason = this.httpErrorReason(error)
        this.logger.warn({
          event: 'auth.request.denied',
          route,
          method: req.method ?? 'UNKNOWN',
          clientId: this.clientId(req),
          status: error.status,
          reason,
        })
        if (route === '/token' && (reason === 'origin_denied' || reason === 'csrf_denied')) {
          writeTokenHtml(res, error.status, tokenDeniedPage(resolveUiPreferences(req, this.readHarnessUiSettings())))
          return
        }
        write(res, error.status, error.message, { 'cache-control': 'no-store' })
        return
      }
      this.logger.error({
        event: 'auth.request.error',
        route,
        method: req.method ?? 'UNKNOWN',
        clientId: this.clientId(req),
        ...errorLogFields(error),
      })
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
      this.logger.warn({ event: 'auth.login.failed', authMethod: 'password', reason: 'rate_limited', clientId: this.clientId(req) })
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
    const password = passwordBytes <= ADMIN_PASSWORD_MAX_BYTES ? submitted : ''
    const credentials = this.sessions.passwordLoginCredential(username, this.config.sessionSecret)
    const [passwordMatches, usernameMatches] = await Promise.all([
      credentials === undefined ? Promise.resolve(false) : verifyPassword(password, credentials.passwordHash),
      Promise.resolve(credentials?.accountId !== undefined
        && constantTimeTextEqual(username, credentials.username, this.config.sessionSecret)),
    ])
    if (
      credentials?.accountId === undefined
      || !passwordMatches
      || !usernameMatches
      || passwordBytes > ADMIN_PASSWORD_MAX_BYTES
    ) {
      this.logger.warn({ event: 'auth.login.failed', authMethod: 'password', reason: 'invalid_credentials', clientId: this.clientId(req) })
      this.renderLogin(res, 401, formReturnTo, preferences, 'invalidCredentials')
      return
    }
    this.limiter.reset(limiterKey)
    const created = this.sessions.create(this.now(), 'password', credentials.accountId)
    this.logger.info({ event: 'auth.login.succeeded', authMethod: 'password', clientId: this.clientId(req) })
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
    const now = this.now()
    const authenticated = this.sessions.authenticate(req, now)
    if (authenticated === undefined) {
      writeJson(res, 401, { authenticated: false })
      return
    }
    const { session } = authenticated
    const accountMode = this.sessions.accountMode()
    writeJson(res, 200, {
      authenticated: true,
      user: session.user,
      accountMode,
      trustedTeamPreview: accountMode === 'trusted-team-preview',
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      ...(accountMode === 'trusted-team-preview'
        ? { team: this.teamActivityDocument(session.accountId, now) }
        : {}),
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
    const now = this.now()
    const authenticated = this.sessions.authenticate(req, now)
    if (authenticated === undefined) {
      const target = encodeURIComponent(`${this.config.basePath}/account`)
      redirect(res, `${this.config.basePath}/login?returnTo=${target}`)
      return
    }
    const accountMode = this.sessions.accountMode()
    const csrf = this.issueCsrf()
    writeHtml(res, 200, accountPage(
      this.config.basePath,
      authenticated.session,
      csrf.token,
      preferences,
      authenticated.session.accountId === 'admin'
        ? this.sessions.administratorConfigured()
        : this.sessions.accountPasswordCredentials(authenticated.session.accountId) !== undefined,
      accountMode,
      accountMode === 'trusted-team-preview' ? this.sessions.listAccountActivity(now) : [],
    ), {
      'set-cookie': [
        ...this.renewalCookies(authenticated),
        this.cookie(this.cookieNames.csrf, csrf.value, 10 * 60),
      ],
    })
  }

  private teamActivityDocument(currentAccountId: string, now: number): {
    readonly accounts: readonly {
      readonly id: string
      readonly username: string
      readonly role: string
      readonly status: string
      readonly activeSessions: number
      readonly lastSeenAt: string | null
      readonly current: boolean
    }[]
  } {
    return {
      accounts: this.sessions.listAccountActivity(now).map(account =>
        this.teamAccountDocument(account, currentAccountId)),
    }
  }

  private teamAccountDocument(account: PublicAccountActivity, currentAccountId: string): {
    readonly id: string
    readonly username: string
    readonly role: string
    readonly status: string
    readonly activeSessions: number
    readonly lastSeenAt: string | null
    readonly current: boolean
  } {
    return {
      id: account.id,
      username: account.username ?? 'admin',
      role: account.role,
      status: account.status,
      activeSessions: account.activeSessions,
      lastSeenAt: account.lastSeenAt === null ? null : new Date(account.lastSeenAt).toISOString(),
      current: account.id === currentAccountId,
    }
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
    this.logger.info({ event: 'auth.logout.succeeded', clientId: this.clientId(req) })
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

  private tokenBootstrap(req: IncomingMessage, res: ServerResponse): void {
    if (!this.config.loginTokenEnabled) {
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
    res.end(req.method === 'HEAD' ? undefined : tokenBootstrapSource())
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.config.loginTokenEnabled || this.tokenStore === undefined) {
      write(res, 404, 'not found')
      return
    }
    const preferences = resolveUiPreferences(req, this.readHarnessUiSettings())
    const failures: TokenFailureMessages = {
      ...(this.config.loginTokenFailureMessageZh === undefined ? {} : { zh: this.config.loginTokenFailureMessageZh }),
      ...(this.config.loginTokenFailureMessageEn === undefined ? {} : { en: this.config.loginTokenFailureMessageEn }),
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const csrf = this.issueCsrf()
      writeTokenHtml(res, 200, tokenBridgePage(this.config.basePath, csrf.token, preferences, failures), {
        'set-cookie': this.cookie(this.cookieNames.csrf, csrf.value, 10 * 60),
      })
      return
    }
    if (req.method !== 'POST') {
      write(res, 405, 'method not allowed', { allow: 'GET, HEAD, POST', 'cache-control': 'no-store' })
      return
    }
    const form = await readForm(req)
    const limiterKey = clientAddress(req, this.config)
    const retryAfter = this.tokenLimiter.consume(limiterKey, this.now())
    if (retryAfter !== undefined) {
      this.logger.warn({ event: 'auth.login.failed', authMethod: 'login-token', reason: 'rate_limited', clientId: this.clientId(req) })
      writeTokenHtml(res, 429, tokenRateLimitedPage(preferences), { 'retry-after': String(retryAfter) })
      return
    }
    if (!hasSameOrigin(req, this.config)) throw new HttpError(403, 'cross-origin request denied')
    if (!this.validCsrf(req, form.get('csrf'))) throw new HttpError(403, 'invalid CSRF token')
    const submitted = form.get('token')
    if (submitted === null || submitted.length === 0 || submitted.length > 256
      || form.getAll('csrf').length !== 1 || form.getAll('token').length !== 1 || form.size !== 2) {
      this.logger.warn({ event: 'auth.login.failed', authMethod: 'login-token', reason: 'invalid_token', clientId: this.clientId(req) })
      this.renderTokenFailure(res, 401, preferences)
      return
    }
    let claim: ReturnType<LoginTokenStore['claim']>
    try {
      claim = this.tokenStore.claim(submitted)
    } catch (error) {
      // A damaged managed file is a denial, never an internal-detail probe.
      this.logger.error({ event: 'auth.token-store.error', operation: 'claim', ...errorLogFields(error) })
      claim = { status: 'invalid' }
    }
    if (claim.status !== 'claimed') {
      this.logger.warn({ event: 'auth.login.failed', authMethod: 'login-token', reason: 'invalid_token', clientId: this.clientId(req) })
      this.renderTokenFailure(res, 401, preferences)
      return
    }
    try {
      const created = this.sessions.create(this.now(), 'login-token', 'admin')
      this.tokenStore.releaseClaim(claim)
      this.tokenLimiter.reset(limiterKey)
      this.logger.info({ event: 'auth.login.succeeded', authMethod: 'login-token', clientId: this.clientId(req) })
      const target = this.sessions.administratorConfigured()
        ? '/'
        : `${this.config.basePath}/admin/setup?returnTo=%2F`
      redirect(res, target, {
        'set-cookie': [
          this.cookie(this.cookieNames.session, created.cookieValue, this.config.sessionTtlSeconds),
          this.cookie(this.cookieNames.csrf, '', 0),
        ],
      })
    } catch (error) {
      // The claim is never restored; the user must request a fresh token.
      this.logger.error({
        event: 'auth.login.failed',
        authMethod: 'login-token',
        reason: 'session_persistence',
        clientId: this.clientId(req),
        ...errorLogFields(error),
      })
      this.renderTokenFailure(res, 401, preferences)
    }
  }

  private async adminSetup(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const preferences = resolveUiPreferences(req, this.readHarnessUiSettings())
    const returnTo = safeReturnTarget(url.searchParams.get('returnTo'))
    if (req.method === 'GET' || req.method === 'HEAD') {
      this.adminSetupGet(req, res, returnTo, preferences)
      return
    }
    if (req.method !== 'POST') {
      write(res, 405, 'method not allowed', { allow: 'GET, HEAD, POST', 'cache-control': 'no-store' })
      return
    }
    await this.adminSetupPost(req, res, preferences)
  }

  private adminSetupGet(
    req: IncomingMessage,
    res: ServerResponse,
    returnTo: string,
    preferences: UiPreferences,
  ): void {
    const authenticated = this.sessions.authenticate(req, this.now())
    if (authenticated === undefined) {
      const target = `${this.config.basePath}/admin/setup?returnTo=${encodeURIComponent(returnTo)}`
      redirect(res, `${this.config.basePath}/login?returnTo=${encodeURIComponent(target)}`)
      return
    }
    if (this.sessions.administratorConfigured()) {
      redirect(res, `${this.config.basePath}/account`, this.renewalHeaders(authenticated))
      return
    }
    if (authenticated.session.authenticationMethod !== 'login-token') {
      writeHtml(res, 403, adminSetupForbiddenPage(preferences), this.renewalHeaders(authenticated))
      return
    }
    const csrf = this.issueCsrf()
    writeHtml(res, 200, adminSetupPage(this.config.basePath, returnTo, csrf.token, preferences), {
      'set-cookie': [
        ...this.renewalCookies(authenticated),
        this.cookie(this.cookieNames.csrf, csrf.value, 10 * 60),
      ],
    })
  }

  private async adminSetupPost(req: IncomingMessage, res: ServerResponse, preferences: UiPreferences): Promise<void> {
    if (!hasSameOrigin(req, this.config)) throw new HttpError(403, 'cross-origin request denied')
    const form = await readForm(req)
    const returnTo = safeReturnTarget(form.get('returnTo'))
    if (!this.validCsrf(req, form.get('csrf'))) throw new HttpError(403, 'invalid CSRF token')
    const authenticated = this.sessions.authenticate(req, this.now())
    if (authenticated === undefined) {
      const target = `${this.config.basePath}/admin/setup?returnTo=${encodeURIComponent(returnTo)}`
      redirect(res, `${this.config.basePath}/login?returnTo=${encodeURIComponent(target)}`)
      return
    }
    if (this.sessions.administratorConfigured()) {
      writeHtml(res, 200, adminSetupCompletePage(preferences, returnTo), this.renewalHeaders(authenticated))
      return
    }
    if (authenticated.session.authenticationMethod !== 'login-token') {
      writeHtml(res, 403, adminSetupForbiddenPage(preferences), this.renewalHeaders(authenticated))
      return
    }
    const submitted = this.readSetupCredentials(form)
    if (submitted.message !== undefined) {
      this.renderAdminSetup(res, 400, returnTo, preferences, authenticated, submitted.message)
      return
    }
    const passwordHash = await hashPassword(submitted.password)
    const result = this.sessions.initializeAdministrator(
      authenticated.session.token,
      submitted.username,
      passwordHash,
      this.now(),
    )
    if (result === 'already-configured') {
      writeHtml(res, 200, adminSetupCompletePage(preferences, returnTo), this.renewalHeaders(authenticated))
      return
    }
    if (result !== 'initialized') {
      const target = `${this.config.basePath}/admin/setup?returnTo=${encodeURIComponent(returnTo)}`
      redirect(res, `${this.config.basePath}/login?returnTo=${encodeURIComponent(target)}`)
      return
    }
    this.logger.info({ event: 'auth.admin.initialized', clientId: this.clientId(req) })
    redirect(res, returnTo, {
      'set-cookie': [
        ...this.renewalCookies(authenticated),
        this.cookie(this.cookieNames.csrf, '', 0),
      ],
    })
  }

  private readSetupCredentials(form: URLSearchParams): {
    readonly username: string
    readonly password: string
    readonly message?: SetupMessage
  } {
    try {
      const username = parseAdministratorUsername(form.get('username') ?? '')
      const password = form.get('password') ?? ''
      const confirmPassword = form.get('confirmPassword') ?? ''
      if (password !== confirmPassword) return { username, password, message: 'passwordMismatch' }
      assertAdministratorPassword(password)
      return { username, password }
    } catch (error) {
      const detail = error instanceof Error ? error.message : ''
      if (detail.includes('whitespace')) return { username: '', password: '', message: 'usernameWhitespace' }
      if (detail.includes('15-128') || detail.includes('1024')) {
        return { username: '', password: '', message: 'passwordInvalid' }
      }
      return { username: '', password: '', message: 'usernameInvalid' }
    }
  }

  private renderAdminSetup(
    res: ServerResponse,
    status: number,
    returnTo: string,
    preferences: UiPreferences,
    authenticated: SessionAuthentication,
    message?: SetupMessage,
  ): void {
    const csrf = this.issueCsrf()
    writeHtml(res, status, adminSetupPage(this.config.basePath, returnTo, csrf.token, preferences, message), {
      'set-cookie': [
        ...this.renewalCookies(authenticated),
        this.cookie(this.cookieNames.csrf, csrf.value, 10 * 60),
      ],
    })
  }

  private renderTokenFailure(res: ServerResponse, status: number, preferences: UiPreferences): void {
    writeTokenHtml(res, status, tokenFailurePage(preferences, {
      ...(this.config.loginTokenFailureMessageZh === undefined ? {} : { zh: this.config.loginTokenFailureMessageZh }),
      ...(this.config.loginTokenFailureMessageEn === undefined ? {} : { en: this.config.loginTokenFailureMessageEn }),
    }))
  }

  private clientId(req: IncomingMessage): string {
    return clientLogId(this.config.sessionSecret, clientAddress(req, this.config))
  }

  private routeName(path: string): string {
    const suffix = path.startsWith(this.config.basePath) ? path.slice(this.config.basePath.length) : path
    return new Set([
      '', '/login', `/${TOKEN_BOOTSTRAP_FILE}`, '/token', `/${BROWSER_BOOTSTRAP_FILE}`,
      '/session', '/csrf', '/account', '/admin/setup', '/admin/password', '/logout', '/verify',
    ]).has(suffix) ? suffix || '/' : 'unknown'
  }

  private httpErrorReason(error: HttpError): string {
    if (error.message === 'cross-origin request denied') return 'origin_denied'
    if (error.message === 'invalid CSRF token') return 'csrf_denied'
    if (error.status === 413) return 'request_too_large'
    if (error.status === 415) return 'content_type_denied'
    if (error.message === 'request aborted') return 'request_aborted'
    return 'http_error'
  }

  private renderLogin(
    res: ServerResponse,
    status: number,
    returnTo: string,
    preferences: UiPreferences,
    message?: AuthMessage,
  ): void {
    const csrf = this.issueCsrf()
    writeHtml(res, status, loginPage(
      this.config.basePath,
      returnTo,
      csrf.token,
      preferences,
      message,
      this.sessions.administratorConfigured(),
    ), {
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
