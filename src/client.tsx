/** Browser half: a Harness-native sign-out action in the sidebar footer. */
import { useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

const NS = 'dsh-auth'
const STYLE_PLUGIN_ID = 'dsh-auth'
const AUTH_BASE_PATH_META = 'dsh-auth-base-path'

const zh = {
  'logout.label': '退出登录',
  'logout.pending': '正在退出…',
  'logout.error': '退出登录失败，请重试',
} as const

type AuthLocaleKey = keyof typeof zh

const en = {
  'logout.label': 'Sign out',
  'logout.pending': 'Signing out…',
  'logout.error': 'Could not sign out. Try again.',
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

interface LogoutActionInjected {
  readonly beginLogout: () => Promise<void>
}

export type LogoutActionProps =
  { readonly wide: boolean } & PropsLocale<'dsh-auth'> & LogoutActionInjected

const CLIENT_CSS = `
.dsh-auth-logout-wrap{display:flex;flex-direction:column;width:100%;min-width:0}
.dsh-auth-logout{display:flex;align-items:center;gap:8px;width:100%;height:42px;padding:0 8px 0 6px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;cursor:pointer;overflow:hidden}
.dsh-auth-logout:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.dsh-auth-logout:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dsh-auth-logout:disabled{cursor:wait;color:var(--dsw-alias-label-tertiary)}
.dsh-auth-logout-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-auth-logout-wrap[data-rail]{align-items:center;width:36px}
.dsh-auth-logout-wrap[data-rail] .dsh-auth-logout{justify-content:center;gap:0;width:36px;height:36px;padding:0;border-radius:50%}
.dsh-auth-logout-wrap[data-rail] .dsh-auth-logout:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-auth-logout-error{padding:0 8px 4px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}
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

function LogoutIcon({ pending }: { readonly pending: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" width="18" height="18" fill="none">
      <path d="M8.25 3.25H5.5A1.75 1.75 0 0 0 3.75 5v10A1.75 1.75 0 0 0 5.5 16.75h2.75M12.25 6.25 16 10l-3.75 3.75M7.25 10H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity={pending ? 0.5 : 1} />
    </svg>
  )
}

/** Render the wide-row or collapsed-rail sign-out control. */
export function LogoutAction({ wide, beginLogout, t }: LogoutActionProps) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const label = pending ? t('logout.pending') : t('logout.label')
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
    <div className="dsh-auth-logout-wrap" data-rail={!wide || undefined}>
      <Tooltip label={label} delayMs={500} disabled={wide}>
        <button
          type="button"
          className="dsh-auth-logout"
          aria-label={label}
          disabled={pending}
          onClick={() => { void run() }}
        >
          <LogoutIcon pending={pending} />
          {wide && <span className="dsh-auth-logout-label">{label}</span>}
        </button>
      </Tooltip>
      {wide && failed && <span className="dsh-auth-logout-error" role="alert">{t('logout.error')}</span>}
    </div>
  )
}

/** Services required by the sidebar action and its bilingual copy. */
export const inject = ['slots', 'locale']

/** Register the client-side stylesheet, dictionaries, and footer action. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = STYLE_PLUGIN_ID
    style.textContent = CLIENT_CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'dsh-auth: sidebar styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-auth: dictionaries')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-auth-logout',
    order: 100,
    locale: NS,
    inject: (): LogoutActionInjected => ({ beginLogout: () => beginBrowserLogout() }),
  }, LogoutAction))
}
