import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { browserBootstrapSource, injectAuthBasePath, injectBrowserBootstrap } from '../src/browser-bootstrap.js'

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
