/** @vitest-environment jsdom */
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { browserBootstrapSource, injectAuthBasePath, injectBrowserBootstrap } from '../src/browser-bootstrap.js'
import { tokenBootstrapSource } from '../src/token-bootstrap.js'
import { tokenBridgePage } from '../src/html.js'

describe('browser compatibility bootstrap', () => {
  it('loads a blocking same-origin script without moving the HTML doctype', () => {
    const html = injectBrowserBootstrap(
      '<!doctype html><html><head><title>Harness</title></head><script type="module">start()</script></html>',
      '/auth',
    )
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<head><script src="/auth/browser-bootstrap.js"></script>')
    expect(html.indexOf('browser-bootstrap.js')).toBeLessThan(html.indexOf('type="module"'))

    const bodyOnly = injectBrowserBootstrap('<!doctype html><body>Harness</body>', '/auth')
    expect(bodyOnly).toBe('<!doctype html><script src="/auth/browser-bootstrap.js"></script><body>Harness</body>')
  })

  it('publishes the configured authentication prefix before the SPA starts', () => {
    const html = injectAuthBasePath('<!doctype html><html><head></head><body></body></html>', '/identity')
    expect(html).toContain('<head><meta name="dsh-auth-base-path" content="/identity">')
  })

  it('provides RFC 4122 v4 UUIDs from Web Crypto', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array): Uint8Array => {
      bytes.forEach((_, index) => { bytes[index] = index })
      return bytes
    })
    const browserCrypto: { getRandomValues: typeof getRandomValues; randomUUID?: () => string } = { getRandomValues }

    runInNewContext(browserBootstrapSource(), { crypto: browserCrypto, Uint8Array })

    expect(browserCrypto.randomUUID?.()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
    expect(getRandomValues).toHaveBeenCalledOnce()
  })

  it('leaves a native randomUUID implementation untouched', () => {
    const native = vi.fn(() => 'native')
    const getRandomValues = vi.fn(() => { throw new Error('must not run') })
    const browserCrypto = { randomUUID: native, getRandomValues }

    runInNewContext(browserBootstrapSource(), { crypto: browserCrypto, Uint8Array })

    expect(browserCrypto.randomUUID).toBe(native)
    expect(browserCrypto.randomUUID()).toBe('native')
    expect(getRandomValues).not.toHaveBeenCalled()
  })
})

function bridgeDocument(fragment: string): void {
  window.history.replaceState(null, '', `/auth/token${fragment}`)
  const parsed = new window.DOMParser().parseFromString(
    tokenBridgePage('/auth', 'csrf-token-value', { language: 'en', theme: 'system' }, {}),
    'text/html',
  )
  window.document.head.innerHTML = parsed.head.innerHTML
  window.document.body.innerHTML = parsed.body.innerHTML
}

function submittedForm(): HTMLFormElement | null {
  const form = window.document.querySelector('form')
  if (form?.method.toLowerCase() !== 'post') return null
  return form
}

describe('token bridge bootstrap', () => {
  it('clears the fragment before any token-bearing form enters the DOM and posts csrf with token', () => {
    bridgeDocument('#token=dsh_otl_v1_example_value_for_the_bridge_test')
    const hashesAtFormAttach: string[] = []
    const originalReplaceState = window.history.replaceState.bind(window.history)
    const replaceState = vi.fn((...args: Parameters<typeof window.history.replaceState>) => {
      originalReplaceState(...args)
    })
    window.history.replaceState = replaceState
    const originalAppend = Reflect.get(window.HTMLElement.prototype, 'appendChild')
    window.HTMLElement.prototype.appendChild = function appended<T extends Node>(this: HTMLElement, node: T): T {
      if (node instanceof window.HTMLFormElement) hashesAtFormAttach.push(window.location.hash)
      return originalAppend.call(this, node) as T
    }
    const submit = vi.fn()
    window.HTMLFormElement.prototype.submit = submit

    window.eval(tokenBootstrapSource())

    expect(replaceState).toHaveBeenCalledOnce()
    expect(window.location.hash).toBe('')
    expect(hashesAtFormAttach).toEqual([''])
    expect(submit).toHaveBeenCalledOnce()
    const form = submittedForm()
    expect(form?.action).toBe(`${window.location.origin}/auth/token`)
    const fields = new FormData(form ?? new window.HTMLFormElement())
    expect(fields.get('csrf')).toBe('csrf-token-value')
    expect(fields.get('token')).toBe('dsh_otl_v1_example_value_for_the_bridge_test')
  })

  it('reveals the unified failure notice for empty, unknown, duplicate, or missing fragments', () => {
    for (const fragment of ['', '#', '#other=value', '#token=a&token=b', '#token=a&extra=1']) {
      bridgeDocument(fragment)
      const submit = vi.fn()
      window.HTMLFormElement.prototype.submit = submit
      window.eval(tokenBootstrapSource())
      const notice = window.document.getElementById('dsh-auth-token-error')
      expect(notice?.hidden, fragment).toBe(false)
      expect(submittedForm(), fragment).toBeNull()
      expect(submit, fragment).not.toHaveBeenCalled()
      expect(window.document.body.textContent).not.toContain('dsh_otl_v1_')
    }
  })

  it('renders the bridge page with a noscript fallback and no token-sensitive CSP conflict', () => {
    const html = tokenBridgePage('/auth', 'csrf-token-value', { language: 'zh', theme: 'dark' }, { zh: '自定义<b>失败</b>' })
    expect(html).toContain('<meta name="dsh-auth-csrf" content="csrf-token-value">')
    expect(html).toContain('<script src="/auth/token-bootstrap.js" defer></script>')
    expect(html).toContain('<noscript>')
    expect(html).toContain('自定义&lt;b&gt;失败&lt;/b&gt;')
    expect(html).not.toContain('#token=')
  })
})
