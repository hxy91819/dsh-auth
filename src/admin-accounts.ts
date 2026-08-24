import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedConfig } from './config.js'
import { accountManagementPage, type AccountManagementMessage } from './html.js'
import {
  hasSameOrigin,
  HttpError,
  readForm,
  redirect,
  write,
  writeHtml,
} from './http.js'
import { assertAdministratorPassword, hashPassword, parseAccountUsername } from './password.js'
import { resolveUiPreferences } from './preferences.js'
import type { HarnessUiSettings, UiPreferences } from './preferences.js'
import type { SessionAuthentication, SessionStore } from './session.js'
import type { AccountId } from './auth-state.js'
import type { AuthEventLogger } from './logging.js'

/** Shared HTTP helpers owned by the authentication application. */
export interface AdminAccountsContext {
  readonly config: ResolvedConfig
  readonly sessions: SessionStore
  readonly now: () => number
  readonly readHarnessUiSettings: () => HarnessUiSettings
  readonly cookieNames: { readonly session: string; readonly csrf: string }
  readonly issueCsrf: () => { readonly token: string; readonly value: string }
  readonly validCsrf: (req: IncomingMessage, submitted: string | null) => boolean
  readonly cookie: (name: string, value: string, maxAgeSeconds: number) => string
  readonly renewalCookies: (authenticated: SessionAuthentication) => readonly string[]
  readonly renewalHeaders: (authenticated: SessionAuthentication) => Record<string, string | string[]>
  readonly clientId: (req: IncomingMessage) => string
  readonly logger: AuthEventLogger
}

export async function handleAdminAccounts(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminAccountsContext,
): Promise<void> {
  const preferences = resolveUiPreferences(req, ctx.readHarnessUiSettings())
  if (req.method === 'GET' || req.method === 'HEAD') {
    accountGet(req, res, preferences, ctx)
    return
  }
  if (req.method !== 'POST') {
    write(res, 405, 'method not allowed', { allow: 'GET, HEAD, POST', 'cache-control': 'no-store' })
    return
  }
  await accountPost(req, res, preferences, ctx)
}

function loginRedirect(ctx: AdminAccountsContext): string {
  return `${ctx.config.basePath}/login?returnTo=${encodeURIComponent(`${ctx.config.basePath}/admin/accounts`)}`
}

function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  preferences: UiPreferences,
  ctx: AdminAccountsContext,
): SessionAuthentication | undefined {
  const authenticated = ctx.sessions.authenticate(req, ctx.now())
  if (authenticated === undefined) {
    redirect(res, loginRedirect(ctx))
    return undefined
  }
  if (!authenticated.session.user.roles.includes('admin')) {
    renderAccountManagement(res, 403, preferences, authenticated, ctx, 'forbidden')
    return undefined
  }
  return authenticated
}

function accountGet(
  req: IncomingMessage,
  res: ServerResponse,
  preferences: UiPreferences,
  ctx: AdminAccountsContext,
  message?: AccountManagementMessage,
): void {
  const authenticated = requireAdmin(req, res, preferences, ctx)
  if (authenticated === undefined) return
  renderAccountManagement(res, 200, preferences, authenticated, ctx, message)
}

async function accountPost(
  req: IncomingMessage,
  res: ServerResponse,
  preferences: UiPreferences,
  ctx: AdminAccountsContext,
): Promise<void> {
  if (!hasSameOrigin(req, ctx.config)) throw new HttpError(403, 'cross-origin request denied')
  const form = await readForm(req)
  if (!ctx.validCsrf(req, form.get('csrf'))) throw new HttpError(403, 'invalid CSRF token')
  const authenticated = requireAdmin(req, res, preferences, ctx)
  if (authenticated === undefined) return
  const message = await applyAction(form, authenticated, ctx.clientId(req), ctx)
  renderAccountManagement(res, message === 'passwordInvalid' || message === 'passwordMismatch' || message === 'usernameInvalid' || message === 'usernameWhitespace' ? 400 : 200, preferences, authenticated, ctx, message)
}

async function applyAction(
  form: URLSearchParams,
  authenticated: SessionAuthentication,
  clientId: string,
  ctx: AdminAccountsContext,
): Promise<AccountManagementMessage | undefined> {
  const action = form.get('action')
  if (action === 'enable-preview') {
    if (form.get('ack') !== 'trusted-team-preview') return 'teamPreviewRequired'
    const result = ctx.sessions.setTrustedTeamPreview(true)
    ctx.logger.info({
      event: 'auth.account-mode.updated',
      actorUserId: authenticated.session.user.userId,
      mode: 'trusted-team-preview',
      changed: result === 'updated',
      clientId,
    })
    return 'teamEnabled'
  }
  if (action === 'disable-preview') {
    const result = ctx.sessions.setTrustedTeamPreview(false)
    ctx.logger.info({
      event: 'auth.account-mode.updated',
      actorUserId: authenticated.session.user.userId,
      mode: 'single',
      changed: result === 'updated',
      clientId,
    })
    return 'teamDisabled'
  }
  if (action === 'disable-member') {
    const accountId = form.get('accountId')
    if (accountId === null) return 'forbidden'
    const result = ctx.sessions.setMemberStatus(accountId as AccountId, 'disabled')
    if (result === 'updated' || result === 'unchanged') {
      ctx.logger.info({
        event: 'auth.member-account.disabled',
        actorUserId: authenticated.session.user.userId,
        targetAccountId: accountId,
        changed: result === 'updated',
        clientId,
      })
    } else {
      ctx.logger.warn({
        event: 'auth.member-account.disable.failed',
        actorUserId: authenticated.session.user.userId,
        reason: result,
        clientId,
      })
    }
    return result === 'updated' || result === 'unchanged' ? 'teamMemberDisabled' : 'forbidden'
  }
  if (action !== 'create-member') return 'forbidden'
  if (ctx.sessions.accountMode() !== 'trusted-team-preview') return 'teamPreviewRequired'
  const submitted = readMemberCredentials(form)
  if (submitted.message !== undefined) return submitted.message
  const result = ctx.sessions.createMemberAccount(
    submitted.username,
    await hashPassword(submitted.password),
    ctx.now(),
  )
  if (result.result === 'duplicate-username') {
    ctx.logger.warn({
      event: 'auth.member-account.create.failed',
      actorUserId: authenticated.session.user.userId,
      reason: 'duplicate-username',
      clientId,
    })
    return 'teamDuplicate'
  }
  if (result.result === 'preview-disabled') return 'teamPreviewRequired'
  if (result.result !== 'created' || result.account === undefined) {
    ctx.logger.warn({
      event: 'auth.member-account.create.failed',
      actorUserId: authenticated.session.user.userId,
      reason: result.result,
      clientId,
    })
    return 'forbidden'
  }
  ctx.logger.info({
    event: 'auth.member-account.created',
    actorUserId: authenticated.session.user.userId,
    targetAccountId: result.account.id,
    clientId,
  })
  return 'teamCreated'
}

function readMemberCredentials(form: URLSearchParams): {
  readonly username: string
  readonly password: string
  readonly message?: AccountManagementMessage
} {
  let username = ''
  try {
    username = parseAccountUsername(form.get('username') ?? '')
  } catch (error) {
    const detail = error instanceof Error ? error.message : ''
    return { username, password: '', message: detail.includes('whitespace') ? 'usernameWhitespace' : 'usernameInvalid' }
  }
  const password = form.get('password') ?? ''
  const confirmPassword = form.get('confirmPassword') ?? ''
  if (password !== confirmPassword) return { username, password, message: 'passwordMismatch' }
  try {
    assertAdministratorPassword(password)
  } catch {
    return { username, password, message: 'passwordInvalid' }
  }
  return { username, password }
}

function renderAccountManagement(
  res: ServerResponse,
  status: number,
  preferences: UiPreferences,
  authenticated: SessionAuthentication,
  ctx: AdminAccountsContext,
  message?: AccountManagementMessage,
): void {
  const csrf = ctx.issueCsrf()
  writeHtml(res, status, accountManagementPage(
    ctx.config.basePath,
    csrf.token,
    preferences,
    ctx.sessions.accountMode(),
    ctx.sessions.listAccounts(),
    message,
  ), {
    'set-cookie': [
      ...ctx.renewalCookies(authenticated),
      ctx.cookie(ctx.cookieNames.csrf, csrf.value, 10 * 60),
    ],
  })
}
