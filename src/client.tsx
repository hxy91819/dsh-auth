/** Browser half: Settings password-reset and sign-out rows. */
import { useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
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
  'password.description': '更新管理员密码。成功后，其他会话将退出。',
  'password.action': '重设',
} as const

type AuthLocaleKey = keyof typeof zh

const en = {
  'logout.label': 'Current session',
  'logout.description': 'End the current session. Sign in again when you need access.',
  'logout.action': 'Sign out',
  'logout.pending': 'Signing out…',
  'logout.error': 'Could not sign out. Try again.',
  'password.label': 'Reset password',
  'password.description': 'Update the administrator password. Other sessions will be signed out after a successful change.',
  'password.action': 'Reset',
} as const satisfies Record<AuthLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Authentication actions owned by dsh-auth. */
    'dsh-auth': AuthLocaleKey
  }
}

interface CsrfDocument {
  readonly csrf: string
}

interface LogoutSettingsInjected {
  readonly beginLogout: () => Promise<void>
}

export type LogoutSettingsRowProps = PropsLocale<'dsh-auth'> & LogoutSettingsInjected

interface PasswordSettingsInjected {
  readonly beginPasswordChange: () => void
}

export type PasswordSettingsRowProps = PropsLocale<'dsh-auth'> & PasswordSettingsInjected

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
`

function parseCsrf(value: unknown): CsrfDocument {
  if (typeof value !== 'object' || value === null || !('csrf' in value) || typeof value.csrf !== 'string' || value.csrf.length === 0) {
    throw new Error('invalid CSRF response')
  }
  return { csrf: value.csrf }
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

/** Services required by the settings rows and bilingual copy. */
export const inject = ['slots', 'locale']

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
}
