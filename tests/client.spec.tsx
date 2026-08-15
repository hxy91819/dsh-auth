/** @vitest-environment jsdom */
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginBrowserLogout, LogoutAction } from '../src/client.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ children }: { readonly children: ReactElement }) => children,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const copy = {
  'logout.label': '退出登录',
  'logout.pending': '正在退出…',
  'logout.error': '退出登录失败，请重试',
} as const

const t = (key: string): string => key in copy ? copy[key as keyof typeof copy] : key

describe('Harness sidebar sign-out action', () => {
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

  it('renders Harness wide and rail variants with accessible bilingual copy', () => {
    const beginLogout = vi.fn(() => Promise.resolve())
    act(() => {
      root.render(<LogoutAction wide beginLogout={beginLogout} t={t} />)
    })
    const wide = container.querySelector('button')
    expect(wide?.textContent).toBe('退出登录')
    expect(wide?.getAttribute('aria-label')).toBe('退出登录')

    act(() => {
      root.render(<LogoutAction wide={false} beginLogout={beginLogout} t={t} />)
    })
    const rail = container.querySelector('button')
    expect(rail?.textContent).toBe('')
    expect(rail?.getAttribute('aria-label')).toBe('退出登录')
    expect(container.querySelector('[data-rail]')).not.toBeNull()
  })

  it('prevents duplicate clicks and exposes a localized failure', async () => {
    let rejectLogout: ((error: Error) => void) | undefined
    const beginLogout = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectLogout = reject }))
    act(() => {
      root.render(<LogoutAction wide beginLogout={beginLogout} t={t} />)
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
