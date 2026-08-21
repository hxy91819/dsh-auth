/** @vitest-environment jsdom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  attributePromptPayload,
  beginBrowserAccount,
  beginBrowserLogout,
  beginBrowserPasswordChange,
  CurrentAccountFooter,
  fetchCurrentAccount,
  installPromptAttribution,
  LogoutSettingsRow,
  PasswordSettingsRow,
} from '../src/client.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const copy = {
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

const t = (key: string): string => key in copy ? copy[key as keyof typeof copy] : key

describe('Harness settings sign-out row', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    vi.restoreAllMocks()
  })

  it('renders the General settings row with accessible bilingual copy', () => {
    const beginLogout = vi.fn(() => Promise.resolve())
    act(() => {
      root.render(<LogoutSettingsRow beginLogout={beginLogout} t={t} />)
    })
    expect(container.querySelector('.dsh-auth-settings-title')?.textContent).toBe('当前会话')
    expect(container.querySelector('.dsh-auth-settings-desc')?.textContent).toBe('结束当前会话。需要时重新登录即可。')
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('退出登录')
    expect(button?.classList.contains('dsh-auth-logout')).toBe(true)
  })

  it('prevents duplicate clicks and exposes a localized failure', async () => {
    let rejectLogout: ((error: Error) => void) | undefined
    const beginLogout = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectLogout = reject }))
    act(() => {
      root.render(<LogoutSettingsRow beginLogout={beginLogout} t={t} />)
    })
    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(beginLogout).toHaveBeenCalledTimes(1)
    expect(button?.disabled).toBe(true)
    expect(button?.textContent).toBe('正在退出…')
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(beginLogout).toHaveBeenCalledTimes(1)

    await act(async () => {
      rejectLogout?.(new Error('network unavailable'))
      await Promise.resolve()
    })
    expect(button?.disabled).toBe(false)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('退出登录失败，请重试')
  })
})

describe('Harness settings password-reset row', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('renders the General settings row and opens the password-change page', () => {
    const beginPasswordChange = vi.fn()
    act(() => {
      root.render(<PasswordSettingsRow beginPasswordChange={beginPasswordChange} t={t} />)
    })
    expect(container.querySelector('.dsh-auth-settings-title')?.textContent).toBe('重设密码')
    expect(container.querySelector('.dsh-auth-settings-desc')?.textContent).toBe('更新当前账号密码。成功后，此账号的其他会话将退出。')
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('重设')
    expect(button?.classList.contains('dsh-auth-password')).toBe(true)
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(beginPasswordChange).toHaveBeenCalledTimes(1)
  })
})

describe('browser logout protocol', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('fetches an authenticated CSRF token and submits a same-origin POST', async () => {
    const meta = document.createElement('meta')
    meta.name = 'dsh-auth-base-path'
    meta.content = '/identity'
    document.head.append(meta)
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ csrf: 'test-token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
    await beginBrowserLogout(fetcher)

    expect(fetcher).toHaveBeenCalledWith('/identity/csrf', expect.objectContaining({
      credentials: 'same-origin',
      cache: 'no-store',
    }))
    expect(submit).toHaveBeenCalledTimes(1)
    const form = document.querySelector('form[action$="/identity/logout"]')
    expect(form?.getAttribute('method')).toBe('post')
    expect(form?.querySelector<HTMLInputElement>('input[name="csrf"]')?.value).toBe('test-token')
    form?.remove()
    meta.remove()
  })

  it('returns an expired browser session to login without posting', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ authenticated: false }), {
      status: 401,
    })))
    const navigate = vi.fn()
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
    await beginBrowserLogout(fetcher, document, navigate)
    expect(navigate).toHaveBeenCalledWith('/auth/login')
    expect(submit).not.toHaveBeenCalled()
  })

  it('rejects malformed token responses instead of sending an unprotected logout', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 })))
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
    await expect(beginBrowserLogout(fetcher)).rejects.toThrow('invalid CSRF response')
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('browser password-change navigation', () => {
  it('opens the authenticated password-change route on the configured auth prefix', () => {
    const meta = document.createElement('meta')
    meta.name = 'dsh-auth-base-path'
    meta.content = '/identity'
    document.head.append(meta)
    const navigate = vi.fn()
    beginBrowserPasswordChange(document, navigate)
    expect(navigate).toHaveBeenCalledWith('/identity/admin/password')
    meta.remove()
  })
})

describe('browser account identity affordance', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    vi.restoreAllMocks()
  })

  it('fetches the current account session with no-store credentials', async () => {
    const meta = document.createElement('meta')
    meta.name = 'dsh-auth-base-path'
    meta.content = '/identity'
    document.head.append(meta)
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({
      authenticated: true,
      user: { userId: 'acct_test', username: 'teammate', roles: ['member'] },
      trustedTeamPreview: true,
    }), { status: 200 })))

    await expect(fetchCurrentAccount(fetcher)).resolves.toMatchObject({
      user: { userId: 'acct_test', username: 'teammate', roles: ['member'] },
      trustedTeamPreview: true,
    })
    expect(fetcher).toHaveBeenCalledWith('/identity/session', expect.objectContaining({
      credentials: 'same-origin',
      cache: 'no-store',
    }))
    meta.remove()
  })

  it('renders the sidebar footer account row in wide and rail states', async () => {
    const fetchAccount = vi.fn(() => Promise.resolve({
      authenticated: true as const,
      user: { userId: 'acct_test', username: 'teammate', roles: ['member'] },
      trustedTeamPreview: true,
    }))
    const openAccount = vi.fn()
    await act(async () => {
      root.render(<CurrentAccountFooter wide fetchAccount={fetchAccount} openAccount={openAccount} t={t} />)
      await Promise.resolve()
    })
    expect(container.querySelector('.dsh-auth-account-name')?.textContent).toBe('teammate')
    expect(container.querySelector('.dsh-auth-account-meta')?.textContent).toContain('成员')
    expect(container.querySelector('.dsh-auth-account-meta')?.textContent).toContain('共享权限预览')
    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(openAccount).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(<CurrentAccountFooter wide={false} fetchAccount={fetchAccount} openAccount={openAccount} t={t} />)
      await Promise.resolve()
    })
    expect(container.querySelector('.dsh-auth-account-footer-rail')).not.toBeNull()
    expect(container.querySelector('.dsh-auth-account-copy')).toBeNull()
  })

  it('opens the authenticated account route on the configured auth prefix', () => {
    const meta = document.createElement('meta')
    meta.name = 'dsh-auth-base-path'
    meta.content = '/identity'
    document.head.append(meta)
    const navigate = vi.fn()
    beginBrowserAccount(document, navigate)
    expect(navigate).toHaveBeenCalledWith('/identity/account')
    meta.remove()
  })
})

describe('trusted-team prompt attribution', () => {
  const account = {
    authenticated: true as const,
    user: { userId: 'acct_test', username: 'mason', roles: ['member'] },
    trustedTeamPreview: true,
  }

  it('adds a durable visible author line to ordinary session prompts', () => {
    expect(attributePromptPayload({
      sessionId: 'session-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'please review this' }],
    }, account)).toMatchObject({
      content: [{ type: 'text', text: '👤 mason · member\n\nplease review this' }],
    })
  })

  it('does not annotate slash commands or anonymous prompts', () => {
    const command = {
      sessionId: 'session-1',
      mode: 'queue',
      content: [{ type: 'text', text: '/compact' }],
    }
    expect(attributePromptPayload(command, account)).toBe(command)
    const message = {
      sessionId: 'session-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    }
    expect(attributePromptPayload(message, undefined)).toBe(message)
  })

  it('wraps typed prompt API calls used by the Harness composer', async () => {
    const sessionPrompt = vi.fn(() => Promise.resolve({ rpcId: 'rpc_session', result: { ok: true as const, value: { accepted: true } } }))
    const subagentPrompt = vi.fn(() => Promise.resolve({ rpcId: 'rpc_subagent', result: { ok: true as const, value: { accepted: true } } }))
    const connection = {
      api: {
        sessions: { prompt: sessionPrompt },
        subagents: { prompt: subagentPrompt },
      },
      rpc: { call: vi.fn() },
    } as unknown as ConnectionHandle
    const dispose = installPromptAttribution(connection, () => Promise.resolve(account))
    await connection.api.sessions.prompt({
      sessionId: 'session-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    } as Parameters<ConnectionHandle['api']['sessions']['prompt']>[0])
    await connection.api.subagents.prompt({
      parentSessionId: 'parent-session',
      childSessionId: 'child-session',
      mode: 'continuable',
      content: [{ type: 'text', text: 'review this' }],
    } as Parameters<ConnectionHandle['api']['subagents']['prompt']>[0])
    dispose()

    expect(sessionPrompt).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: '👤 mason · member\n\nhello' }],
    }), undefined)
    expect(subagentPrompt).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: '👤 mason · member\n\nreview this' }],
    }), undefined)
  })

  it('still wraps generic prompt RPC calls and leaves other endpoints unchanged', async () => {
    const call = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true } }))
    const connection = {
      api: {
        sessions: { prompt: vi.fn() },
        subagents: { prompt: vi.fn() },
      },
      rpc: { call },
    } as unknown as ConnectionHandle
    const dispose = installPromptAttribution(connection, () => Promise.resolve(account))
    await connection.rpc.call('/api', 'session.prompt', {
      sessionId: 'session-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    })
    await connection.rpc.call('/api', 'session.list', {})
    dispose()

    expect(call).toHaveBeenNthCalledWith(1, '/api', 'session.prompt', expect.objectContaining({
      content: [{ type: 'text', text: '👤 mason · member\n\nhello' }],
    }), undefined)
    expect(call).toHaveBeenNthCalledWith(2, '/api', 'session.list', {}, undefined)
  })
})
