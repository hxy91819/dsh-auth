/** Browser half: Settings password-reset and sign-out rows. */
import { useEffect, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

const NS = 'dsh-auth'
const STYLE_PLUGIN_ID = 'dsh-auth'
const AUTH_BASE_PATH_META = 'dsh-auth-base-path'

const zh = {
  'logout.label': '当前会话',
  'logout.description': '结束当前会话。需要时重新登录即可。',
  'logout.action': '退出登录',
  'logout.pending': '正在退出…',
  'logout.error': '退出登录失败，请重试',
  'password.label': '重设密码',
  'password.description': '更新当前账号密码。成功后，此账号的其他会话将退出。',
  'password.action': '重设',
  'account.loading': '正在读取账号…',
  'account.unknown': '未登录',
  'account.open': '账号',
  'account.admin': '管理员',
  'account.member': '成员',
  'account.preview': '共享权限预览',
  'account.authorPrefix': '发言人',
} as const

type AuthLocaleKey = keyof typeof zh

const en = {
  'logout.label': 'Current session',
  'logout.description': 'End the current session. Sign in again when you need access.',
  'logout.action': 'Sign out',
  'logout.pending': 'Signing out…',
  'logout.error': 'Could not sign out. Try again.',
  'password.label': 'Reset password',
  'password.description': 'Update the current account password. Other sessions for this account will be signed out.',
  'password.action': 'Reset',
  'account.loading': 'Loading account…',
  'account.unknown': 'Not signed in',
  'account.open': 'Account',
  'account.admin': 'Admin',
  'account.member': 'Member',
  'account.preview': 'Shared-authority preview',
  'account.authorPrefix': 'Author',
} as const satisfies Record<AuthLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Authentication actions owned by dsh-auth. */
    'dsh-auth': AuthLocaleKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser connection service provided by @deepseek-ai/dsh-client-connection. */
    connection: ConnectionHandle
  }
}

interface CsrfDocument {
  readonly csrf: string
}

interface CurrentAccountDocument {
  readonly authenticated: true
  readonly user: {
    readonly userId: string
    readonly username: string
    readonly roles: readonly string[]
  }
  readonly trustedTeamPreview?: boolean
}

interface CurrentAccountInjected {
  readonly fetchAccount: () => Promise<CurrentAccountDocument | undefined>
  readonly openAccount: () => void
}

interface LogoutSettingsInjected {
  readonly beginLogout: () => Promise<void>
}

interface PromptContentPart {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

interface PromptPayloadShape {
  readonly content?: unknown
  readonly [key: string]: unknown
}

export type LogoutSettingsRowProps = PropsLocale<'dsh-auth'> & LogoutSettingsInjected

interface PasswordSettingsInjected {
  readonly beginPasswordChange: () => void
}

export type PasswordSettingsRowProps = PropsLocale<'dsh-auth'> & PasswordSettingsInjected

export type CurrentAccountFooterProps =
  & PropsLocale<'dsh-auth'>
  & SidebarFooterActionOwnerProps
  & CurrentAccountInjected

interface SettingsActionRowProps {
  readonly title: string
  readonly description: string
  readonly actionLabel: string
  readonly actionClassName: string
  readonly pending?: boolean
  readonly error?: string
  readonly onAction: () => void
}

const CLIENT_CSS = `
.dsh-auth-settings-row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}
.dsh-auth-settings-row-text{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}
.dsh-auth-settings-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.dsh-auth-settings-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
.dsh-auth-settings-error{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}
.dsh-auth-settings-action{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}
.dsh-auth-settings-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-auth-settings-action:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsh-auth-settings-action:disabled{cursor:wait;color:var(--dsw-alias-label-tertiary)}
.dsh-auth-account-footer{width:100%;min-width:0;background:transparent;color:var(--dsw-alias-label-primary);border:0;border-radius:10px;align-items:center;gap:10px;padding:8px;display:flex;cursor:pointer;font:inherit;text-align:left}
.dsh-auth-account-footer:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-auth-account-footer:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsh-auth-account-footer-rail{justify-content:center;padding:8px 0}
.dsh-auth-account-avatar{width:28px;height:28px;border-radius:50%;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);align-items:center;justify-content:center;display:flex;font-size:12px;font-weight:600;line-height:1;flex:0 0 auto}
.dsh-auth-account-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.dsh-auth-account-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
.dsh-auth-account-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
`

function parseCsrf(value: unknown): CsrfDocument {
  if (typeof value !== 'object' || value === null || !('csrf' in value) || typeof value.csrf !== 'string' || value.csrf.length === 0) {
    throw new Error('invalid CSRF response')
  }
  return { csrf: value.csrf }
}

function parseCurrentAccount(value: unknown): CurrentAccountDocument {
  if (typeof value !== 'object' || value === null) throw new Error('invalid session response')
  const record = value as Record<string, unknown>
  const user = record.user
  if (record.authenticated !== true || typeof user !== 'object' || user === null) {
    throw new Error('invalid session response')
  }
  const userRecord = user as Record<string, unknown>
  if (
    typeof userRecord.userId !== 'string'
    || typeof userRecord.username !== 'string'
    || !Array.isArray(userRecord.roles)
    || !userRecord.roles.every(role => typeof role === 'string')
  ) {
    throw new Error('invalid session response')
  }
  return {
    authenticated: true,
    user: {
      userId: userRecord.userId,
      username: userRecord.username,
      roles: userRecord.roles,
    },
    ...(record.trustedTeamPreview === true ? { trustedTeamPreview: true } : {}),
  }
}

function authBasePath(documentRef: Document): string {
  const configured = documentRef.querySelector<HTMLMetaElement>(`meta[name="${AUTH_BASE_PATH_META}"]`)?.content
  if (configured === undefined || !/^\/[A-Za-z0-9/_-]*[A-Za-z0-9_-]$/u.test(configured) || configured.includes('//')) {
    return '/auth'
  }
  return configured
}

/** Fetch a logout token, then submit a same-origin navigational POST. */
export async function beginBrowserLogout(
  fetcher: typeof fetch = window.fetch.bind(window),
  documentRef: Document = document,
  navigate: (path: string) => void = path => { window.location.assign(path) },
): Promise<void> {
  const basePath = authBasePath(documentRef)
  const response = await fetcher(`${basePath}/csrf`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  })
  if (response.status === 401) {
    navigate(`${basePath}/login`)
    return
  }
  if (!response.ok) throw new Error(`CSRF request failed with status ${String(response.status)}`)
  const { csrf } = parseCsrf(await response.json())
  const form = documentRef.createElement('form')
  form.method = 'post'
  form.action = `${basePath}/logout`
  form.enctype = 'application/x-www-form-urlencoded'
  form.hidden = true
  const input = documentRef.createElement('input')
  input.type = 'hidden'
  input.name = 'csrf'
  input.value = csrf
  form.append(input)
  documentRef.body.append(form)
  form.submit()
}

/** Open the authenticated password-change page on this origin. */
export function beginBrowserPasswordChange(
  documentRef: Document = document,
  navigate: (path: string) => void = path => { window.location.assign(path) },
): void {
  navigate(`${authBasePath(documentRef)}/admin/password`)
}

/** Fetch the current same-origin account identity for lightweight shell UI. */
export async function fetchCurrentAccount(
  fetcher: typeof fetch = window.fetch.bind(window),
  documentRef: Document = document,
): Promise<CurrentAccountDocument | undefined> {
  const basePath = authBasePath(documentRef)
  const response = await fetcher(`${basePath}/session`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  })
  if (response.status === 401) return undefined
  if (!response.ok) throw new Error(`session request failed with status ${String(response.status)}`)
  return parseCurrentAccount(await response.json())
}

/** Open the authenticated account page on this origin. */
export function beginBrowserAccount(
  documentRef: Document = document,
  navigate: (path: string) => void = path => { window.location.assign(path) },
): void {
  navigate(`${authBasePath(documentRef)}/account`)
}

function SettingsActionRow({
  title,
  description,
  actionLabel,
  actionClassName,
  pending = false,
  error,
  onAction,
}: SettingsActionRowProps) {
  return (
    <div className="dsh-auth-settings-row">
      <div className="dsh-auth-settings-row-text">
        <div className="dsh-auth-settings-title">{title}</div>
        <div className="dsh-auth-settings-desc">{description}</div>
        {error !== undefined && <span className="dsh-auth-settings-error" role="alert">{error}</span>}
      </div>
      <button
        type="button"
        className={`dsh-auth-settings-action ${actionClassName}`}
        disabled={pending}
        onClick={() => { onAction() }}
      >
        {actionLabel}
      </button>
    </div>
  )
}

/** Render the General settings row that signs the current session out. */
export function LogoutSettingsRow({ beginLogout, t }: LogoutSettingsRowProps) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const run = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setFailed(false)
    try {
      await beginLogout()
    } catch {
      setPending(false)
      setFailed(true)
    }
  }
  return (
    <SettingsActionRow
      title={t('logout.label')}
      description={t('logout.description')}
      actionLabel={pending ? t('logout.pending') : t('logout.action')}
      actionClassName="dsh-auth-logout"
      pending={pending}
      {...(failed ? { error: t('logout.error') } : {})}
      onAction={() => { void run() }}
    />
  )
}

/** Render the General settings row that opens the password-change page. */
export function PasswordSettingsRow({ beginPasswordChange, t }: PasswordSettingsRowProps) {
  return (
    <SettingsActionRow
      title={t('password.label')}
      description={t('password.description')}
      actionLabel={t('password.action')}
      actionClassName="dsh-auth-password"
      onAction={() => { beginPasswordChange() }}
    />
  )
}

function accountInitial(account: CurrentAccountDocument | undefined): string {
  const trimmed = account?.user.username.trim()
  const source = trimmed === undefined || trimmed.length === 0 ? '?' : trimmed
  return Array.from(source)[0]?.toUpperCase() ?? '?'
}

function accountRoleLabel(account: CurrentAccountDocument | undefined, t: PropsLocale<'dsh-auth'>['t']): string {
  if (account === undefined) return t('account.unknown')
  return account.user.roles.includes('admin') ? t('account.admin') : t('account.member')
}

function shouldAttributePrompt(channel: string, endpoint: string): boolean {
  return channel === '/api' && (endpoint === 'session.prompt' || endpoint === 'subagent.prompt')
}

function isPromptContentPart(value: unknown): value is PromptContentPart {
  return typeof value === 'object' && value !== null && typeof (value as { readonly type?: unknown }).type === 'string'
}

function promptContentParts(value: unknown): readonly PromptContentPart[] | undefined {
  return Array.isArray(value) && value.every(isPromptContentPart) ? value : undefined
}

function firstText(content: readonly PromptContentPart[]): string {
  return content.find(part => part.type === 'text' && typeof part.text === 'string')?.text ?? ''
}

function isSlashCommandPrompt(content: readonly PromptContentPart[]): boolean {
  return firstText(content).trimStart().startsWith('/')
}

function authorLine(account: CurrentAccountDocument): string {
  const role = account.user.roles.includes('admin') ? 'admin' : 'member'
  return `👤 ${account.user.username} · ${role}`
}

const AUTHOR_LINE_PATTERN = /^👤 .+(?: · (?:admin|member))?\n\n/u

/** Add a visible, durable author label to browser-submitted prompts. */
export function attributePromptPayload(payload: unknown, account: CurrentAccountDocument | undefined): unknown {
  if (account?.trustedTeamPreview !== true || typeof payload !== 'object' || payload === null) return payload
  const prompt = payload as PromptPayloadShape
  const content = promptContentParts(prompt.content)
  if (content === undefined || isSlashCommandPrompt(content)) return payload
  const prefix = `${authorLine(account)}\n\n`
  const textIndex = content.findIndex(part => part.type === 'text' && typeof part.text === 'string')
  const nextContent = textIndex === -1
    ? [{ type: 'text', text: prefix.trimEnd() }, ...content]
    : content.map((part, index) => index === textIndex
      ? { ...part, text: `${prefix}${(part.text ?? '').replace(AUTHOR_LINE_PATTERN, '')}` }
      : part)
  return {
    ...prompt,
    content: nextContent,
  }
}

/**
 * Wrap Harness prompt RPC calls so the submitted message carries the current
 * dsh-auth account identity. rc.7 has no server-side principal seam for prompt
 * metadata yet, so this preview deliberately uses visible text.
 */
export function installPromptAttribution(
  connection: ConnectionHandle,
  fetchAccount: () => Promise<CurrentAccountDocument | undefined> = () => fetchCurrentAccount(),
): () => void {
  const sessions = connection.api.sessions as { prompt: ConnectionHandle['api']['sessions']['prompt'] }
  const subagents = connection.api.subagents as { prompt: ConnectionHandle['api']['subagents']['prompt'] }
  const originalSessionPrompt = sessions.prompt.bind(connection.api.sessions)
  const originalSubagentPrompt = subagents.prompt.bind(connection.api.subagents)
  const attributedPayload = async <Payload,>(payload: Payload): Promise<Payload> => {
    let account: CurrentAccountDocument | undefined
    try {
      account = await fetchAccount()
    } catch {
      account = undefined
    }
    return attributePromptPayload(payload, account) as Payload
  }
  const wrappedSessionPrompt: ConnectionHandle['api']['sessions']['prompt'] = async (payload, signal) => originalSessionPrompt(await attributedPayload(payload), signal)
  const wrappedSubagentPrompt: ConnectionHandle['api']['subagents']['prompt'] = async (payload, signal) => originalSubagentPrompt(await attributedPayload(payload), signal)
  sessions.prompt = wrappedSessionPrompt
  subagents.prompt = wrappedSubagentPrompt
  const rpc = connection.rpc
  const original = rpc.call.bind(rpc)
  const wrapped: ConnectionHandle['rpc']['call'] = async (channel, endpoint, payload, signal) => {
    if (!shouldAttributePrompt(channel, endpoint)) {
      return original(channel, endpoint, payload, signal)
    }
    let account: CurrentAccountDocument | undefined
    try {
      account = await fetchAccount()
    } catch {
      account = undefined
    }
    return original(channel, endpoint, attributePromptPayload(payload, account), signal)
  }
  rpc.call = wrapped
  return () => {
    if (sessions.prompt === wrappedSessionPrompt) sessions.prompt = originalSessionPrompt
    if (subagents.prompt === wrappedSubagentPrompt) subagents.prompt = originalSubagentPrompt
    if (rpc.call === wrapped) rpc.call = original
  }
}

/** Render the sidebar footer account affordance beside Settings. */
export function CurrentAccountFooter({
  wide,
  fetchAccount,
  openAccount,
  t,
}: CurrentAccountFooterProps) {
  const [account, setAccount] = useState<CurrentAccountDocument | undefined>()
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchAccount()
      .then(value => {
        if (!cancelled) setAccount(value)
      })
      .catch(() => {
        if (!cancelled) setAccount(undefined)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [fetchAccount])
  const label = loading ? t('account.loading') : (account?.user.username ?? t('account.unknown'))
  const meta = [
    accountRoleLabel(account, t),
    account?.trustedTeamPreview === true ? t('account.preview') : undefined,
  ].filter((value): value is string => value !== undefined).join(' · ')
  return (
    <button
      type="button"
      className={`dsh-auth-account-footer ${wide ? '' : 'dsh-auth-account-footer-rail'}`}
      title={t('account.open')}
      aria-label={label}
      onClick={() => { openAccount() }}
    >
      <span className="dsh-auth-account-avatar" aria-hidden="true">{accountInitial(account)}</span>
      {wide && (
        <span className="dsh-auth-account-copy">
          <span className="dsh-auth-account-name">{label}</span>
          <span className="dsh-auth-account-meta">{meta}</span>
        </span>
      )}
    </button>
  )
}

/** Services required by the settings rows, account affordances, and prompt attribution. */
export const inject = ['slots', 'locale', 'connection']

/** Register the client-side stylesheet, dictionaries, and Settings account rows. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = STYLE_PLUGIN_ID
    style.textContent = CLIENT_CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'dsh-auth: settings styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-auth: dictionaries')
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'dsh-auth-password',
    order: 30,
    locale: NS,
    inject: (): PasswordSettingsInjected => ({ beginPasswordChange: () => { beginBrowserPasswordChange() } }),
  }, PasswordSettingsRow))
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'dsh-auth-logout',
    order: 40,
    locale: NS,
    inject: (): LogoutSettingsInjected => ({ beginLogout: () => beginBrowserLogout() }),
  }, LogoutSettingsRow))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-auth-current-account',
    order: 10,
    locale: NS,
    inject: (): CurrentAccountInjected => ({
      fetchAccount: () => fetchCurrentAccount(),
      openAccount: () => { beginBrowserAccount() },
    }),
  }, CurrentAccountFooter))
  ctx.effect(
    () => installPromptAttribution(ctx.connection, () => fetchCurrentAccount()),
    'dsh-auth: trusted-team prompt attribution',
  )
}
