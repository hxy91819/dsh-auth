import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedConfig } from './config.js'
import { passwordChangeCompletePage, passwordChangePage, type PasswordChangeMessage } from './html.js'
import {
  clientAddress,
  CsrfError,
  type CsrfFailureReason,
  hasSameOrigin,
  HttpError,
  readForm,
  redirect,
  safeReturnTarget,
  write,
  writeHtml,
} from './http.js'
import type { LoginLimiter } from './limiter.js'
import type { AuthEventLogger } from './logging.js'
import {
  ADMIN_PASSWORD_MAX_BYTES,
  assertAdministratorPassword,
  hashPassword,
  verifyPassword,
} from './password.js'
import { resolveUiPreferences } from './preferences.js'
import type { HarnessUiSettings, UiPreferences } from './preferences.js'
import type { SessionAuthentication, SessionStore } from './session.js'

/** Cookie, CSRF, and session helpers owned by the HTTP application. */
export interface AdminPasswordContext {
  readonly config: ResolvedConfig
  readonly sessions: SessionStore
  readonly limiter: LoginLimiter
  readonly now: () => number
  readonly readHarnessUiSettings: () => HarnessUiSettings
  readonly cookieNames: { readonly session: string; readonly csrf: string }
  readonly issueCsrf: () => { readonly token: string; readonly value: string }
  readonly csrfFailureReason: (req: IncomingMessage, submitted: string | null) => CsrfFailureReason | undefined
  readonly cookie: (name: string, value: string, maxAgeSeconds: number) => string
  readonly renewalCookies: (authenticated: SessionAuthentication) => readonly string[]
  readonly renewalHeaders: (authenticated: SessionAuthentication) => Record<string, string | string[]>
  readonly logger: AuthEventLogger
  readonly clientId: (req: IncomingMessage) => string
}

/** Authenticated password change for the single administrator identity. */
export async function handleAdminPasswordChange(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: AdminPasswordContext,
): Promise<void> {
  const preferences = resolveUiPreferences(req, ctx.readHarnessUiSettings())
  const returnTo = safeReturnTarget(url.searchParams.get('returnTo'))
  if (req.method === 'GET' || req.method === 'HEAD') {
    passwordChangeGet(req, res, returnTo, preferences, ctx)
    return
  }
  if (req.method !== 'POST') {
    write(res, 405, 'method not allowed', { allow: 'GET, HEAD, POST', 'cache-control': 'no-store' })
    return
  }
  await passwordChangePost(req, res, preferences, ctx)
}

function loginRedirect(ctx: AdminPasswordContext, returnTo: string): string {
  const target = `${ctx.config.basePath}/admin/password?returnTo=${encodeURIComponent(returnTo)}`
  return `${ctx.config.basePath}/login?returnTo=${encodeURIComponent(target)}`
}

function passwordChangeGet(
  req: IncomingMessage,
  res: ServerResponse,
  returnTo: string,
  preferences: UiPreferences,
  ctx: AdminPasswordContext,
): void {
  const authenticated = ctx.sessions.authenticate(req, ctx.now())
  if (authenticated === undefined) {
    redirect(res, loginRedirect(ctx, returnTo))
    return
  }
  if (ctx.sessions.passwordCredentials() === undefined) {
    const setup = `${ctx.config.basePath}/admin/setup?returnTo=${encodeURIComponent(returnTo)}`
    redirect(res, setup, ctx.renewalHeaders(authenticated))
    return
  }
  renderPasswordChange(res, 200, returnTo, preferences, authenticated, ctx)
}

async function passwordChangePost(
  req: IncomingMessage,
  res: ServerResponse,
  preferences: UiPreferences,
  ctx: AdminPasswordContext,
): Promise<void> {
  if (!hasSameOrigin(req, ctx.config)) throw new HttpError(403, 'cross-origin request denied')
  const form = await readForm(req)
  const returnTo = safeReturnTarget(form.get('returnTo'))
  const csrfFailure = ctx.csrfFailureReason(req, form.get('csrf'))
  if (csrfFailure !== undefined) throw new CsrfError(csrfFailure)
  const authenticated = ctx.sessions.authenticate(req, ctx.now())
  if (authenticated === undefined) {
    redirect(res, loginRedirect(ctx, returnTo))
    return
  }
  if (ctx.sessions.passwordCredentials() === undefined) {
    const setup = `${ctx.config.basePath}/admin/setup?returnTo=${encodeURIComponent(returnTo)}`
    redirect(res, setup, ctx.renewalHeaders(authenticated))
    return
  }
  const submitted = readPasswordChange(form)
  if (submitted.message !== undefined) {
    renderPasswordChange(res, 400, returnTo, preferences, authenticated, ctx, submitted.message)
    return
  }
  const limiterKey = clientAddress(req, ctx.config)
  const retryAfter = ctx.limiter.consume(limiterKey, ctx.now())
  if (retryAfter !== undefined) {
    ctx.logger.warn({ event: 'auth.password-change.failed', reason: 'rate_limited', clientId: ctx.clientId(req) })
    renderPasswordChange(res, 429, returnTo, preferences, authenticated, ctx, 'rateLimited', {
      'retry-after': String(retryAfter),
    })
    return
  }
  const credentials = ctx.sessions.passwordCredentials()
  const currentBytes = Buffer.byteLength(submitted.currentPassword, 'utf8')
  const current = currentBytes <= ADMIN_PASSWORD_MAX_BYTES ? submitted.currentPassword : ''
  const currentMatches = credentials === undefined
    ? false
    : await verifyPassword(current, credentials.passwordHash)
  if (credentials === undefined || !currentMatches || currentBytes > ADMIN_PASSWORD_MAX_BYTES) {
    ctx.logger.warn({ event: 'auth.password-change.failed', reason: 'invalid_current_password', clientId: ctx.clientId(req) })
    renderPasswordChange(res, 401, returnTo, preferences, authenticated, ctx, 'currentPasswordInvalid')
    return
  }
  ctx.limiter.reset(limiterKey)
  const passwordHash = await hashPassword(submitted.password)
  const result = ctx.sessions.updateAdministratorPassword(authenticated.session.token, passwordHash, ctx.now())
  if (result === 'not-configured') {
    const setup = `${ctx.config.basePath}/admin/setup?returnTo=${encodeURIComponent(returnTo)}`
    redirect(res, setup, ctx.renewalHeaders(authenticated))
    return
  }
  if (result !== 'updated') {
    redirect(res, loginRedirect(ctx, returnTo))
    return
  }
  ctx.logger.info({ event: 'auth.password-change.succeeded', clientId: ctx.clientId(req) })
  writeHtml(res, 200, passwordChangeCompletePage(preferences, returnTo), {
    'set-cookie': [
      ...ctx.renewalCookies(authenticated),
      ctx.cookie(ctx.cookieNames.csrf, '', 0),
    ],
  })
}

function readPasswordChange(form: URLSearchParams): {
  readonly currentPassword: string
  readonly password: string
  readonly message?: Exclude<PasswordChangeMessage, 'currentPasswordInvalid' | 'rateLimited'>
} {
  const currentPassword = form.get('currentPassword') ?? ''
  const password = form.get('password') ?? ''
  const confirmPassword = form.get('confirmPassword') ?? ''
  if (password !== confirmPassword) return { currentPassword, password, message: 'passwordMismatch' }
  try {
    assertAdministratorPassword(password)
  } catch {
    return { currentPassword, password, message: 'passwordInvalid' }
  }
  return { currentPassword, password }
}

function renderPasswordChange(
  res: ServerResponse,
  status: number,
  returnTo: string,
  preferences: UiPreferences,
  authenticated: SessionAuthentication,
  ctx: AdminPasswordContext,
  message?: PasswordChangeMessage,
  headers: Record<string, string | string[]> = {},
): void {
  const csrf = ctx.issueCsrf()
  writeHtml(res, status, passwordChangePage(ctx.config.basePath, returnTo, csrf.token, preferences, message), {
    ...headers,
    'set-cookie': [
      ...ctx.renewalCookies(authenticated),
      ctx.cookie(ctx.cookieNames.csrf, csrf.value, 10 * 60),
    ],
  })
}
