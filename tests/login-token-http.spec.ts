import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { authStateSecretId, createAuthStateDocument } from '../src/auth-state.js'
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/cookies.js'
import { LoginTokenStore, createNodeTokenHost } from '../src/login-token-store.js'
import { cookiePair, hiddenValue, proxyHeaders, startTestServer, testConfig, testCredentials, type TestCredentials } from './helpers.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface TokenHarness {
  readonly baseUrl: string
  readonly store: LoginTokenStore
  readonly directory: string
  readonly authStateFile: string
}

async function tokenHarness(
  credentials: TestCredentials,
  options: {
    readonly configured?: boolean
    readonly config?: Record<string, unknown>
    readonly clock?: () => number
  } = {},
): Promise<TokenHarness> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-auth-token-http-'))
  roots.push(root)
  const directory = join(root, 'login-tokens')
  mkdirSync(directory, { mode: 0o700 })
  const authStateFile = join(root, 'auth-state.json')
  const document = options.configured === false
    ? createAuthStateDocument(authStateSecretId(Buffer.from(credentials.secret)))
    : createAuthStateDocument(authStateSecretId(Buffer.from(credentials.secret)), {
      username: 'test-account',
      passwordHash: credentials.hash,
      configuredAt: Date.now(),
    })
  writeFileSync(authStateFile, `${JSON.stringify(document)}\n`, { mode: 0o600 })
  const config = testConfig(credentials, {
    authStateFile,
    loginTokenEnabled: true,
    loginTokenDirectory: directory,
    ...options.config,
  })
  const server = await startTestServer(config, options.clock)
  servers.push(server.server)
  return {
    baseUrl: server.baseUrl,
    directory,
    authStateFile,
    store: new LoginTokenStore({ host: createNodeTokenHost(), directory, ...(options.clock === undefined ? {} : { now: options.clock }) }),
  }
}

function csrfMeta(html: string): string {
  const match = /<meta name="dsh-auth-csrf" content="([^"]*)">/u.exec(html)
  if (match?.[1] === undefined) throw new Error('missing csrf meta')
  return match[1]
}

async function bridgePage(baseUrl: string): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const page = await fetch(`${baseUrl}/auth/token`, { headers: proxyHeaders() })
  if (page.status !== 200) throw new Error(`bridge page returned ${String(page.status)}`)
  return { cookie: cookiePair(page.headers, CSRF_COOKIE), csrf: csrfMeta(await page.text()) }
}

async function redeem(baseUrl: string, token: string, overrides: { readonly cookie?: string; readonly csrf?: string; readonly origin?: string } = {}): Promise<Response> {
  const { cookie, csrf } = await bridgePage(baseUrl)
  return await fetch(`${baseUrl}/auth/token`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...proxyHeaders(),
      ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
      'content-type': 'application/x-www-form-urlencoded',
      cookie: overrides.cookie ?? cookie,
    },
    body: new URLSearchParams({ csrf: overrides.csrf ?? csrf, token }).toString(),
  })
}

describe('token bridge page', () => {
  it('serves a no-store bridge page with strict headers and never consumes a token', async () => {
    const credentials = await testCredentials()
    const harness = await tokenHarness(credentials)
    const issued = harness.store.issue({ ttlSeconds: 300 })

    for (const method of ['GET', 'HEAD'] as const) {
      const page = await fetch(`${harness.baseUrl}/auth/token`, { method, headers: proxyHeaders() })
      expect(page.status).toBe(200)
      expect(page.headers.get('cache-control')).toBe('no-store, max-age=0')
      expect(page.headers.get('referrer-policy')).toBe('no-referrer')
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
      expect(page.headers.get('content-security-policy')).toContain("form-action 'self'")
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(page.headers.getSetCookie().some(value => value.startsWith(`${CSRF_COOKIE}=`))).toBe(true)
      if (method === 'GET') {
        const html = await page.text()
        expect(html).toContain('/auth/token-bootstrap.js')
        expect(html).toContain('<noscript>')
        expect(html).toContain('dsh-auth-token-error')
        expect(html).not.toContain(issued.token)
        expect(html).not.toContain('#token=')
      }
    }

    expect((await redeem(harness.baseUrl, issued.token)).status).toBe(303)
  })

  it('ignores tokens placed in the query string and keeps them redeemable', async () => {
    const credentials = await testCredentials()
    const harness = await tokenHarness(credentials)
    const issued = harness.store.issue({ ttlSeconds: 300 })

    const probed = await fetch(`${harness.baseUrl}/auth/token?token=${issued.token}`, { headers: proxyHeaders() })
    expect(probed.status).toBe(200)
    expect(await probed.text()).not.toContain(issued.token)
    expect(readdirSync(harness.directory)).toHaveLength(1)

    expect((await redeem(harness.baseUrl, issued.token)).status).toBe(303)
  })

  it('serves the same-origin bridge script only with safe methods', async () => {
    const credentials = await testCredentials()
    const harness = await tokenHarness(credentials)
    const script = await fetch(`${harness.baseUrl}/auth/token-bootstrap.js`, { headers: proxyHeaders() })
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(script.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(script.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await script.text()).toContain('history.replaceState')
    expect((await fetch(`${harness.baseUrl}/auth/token-bootstrap.js`, { method: 'POST', headers: proxyHeaders() })).status).toBe(405)
  })

  it('returns 404 for the whole token surface when tokens are disabled', async () => {
    const credentials = await testCredentials()
    const config = testConfig(credentials, { loginTokenEnabled: false })
    const server = await startTestServer(config)
    servers.push(server.server)
    expect((await fetch(`${server.baseUrl}/auth/token`, { headers: proxyHeaders() })).status).toBe(404)
    expect((await fetch(`${server.baseUrl}/auth/token-bootstrap.js`, { headers: proxyHeaders() })).status).toBe(404)
    expect((await fetch(`${server.baseUrl}/auth/token`, {
      method: 'POST',
      headers: { ...proxyHeaders(), 'content-type': 'application/x-www-form-urlencoded' },
      body: 'csrf=x&token=y',
    })).status).toBe(404)
  })
})

describe('token redemption', () => {
  it('establishes a normal administrator session with password-parity cookies', async () => {
    const credentials = await testCredentials()
    const harness = await tokenHarness(credentials)
    const issued = harness.store.issue({ ttlSeconds: 300 })

    const accepted = await redeem(harness.baseUrl, issued.token)

    expect(accepted.status).toBe(303)
    expect(accepted.headers.get('location')).toBe('/')
    const sessionField = accepted.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`))
    expect(sessionField).toContain('Path=/')
    expect(sessionField).toContain('SameSite=Lax')
    expect(sessionField).toContain('HttpOnly')
    expect(sessionField).toContain('Secure')
    expect(sessionField).toContain('Max-Age=259200')
    const session = cookiePair(accepted.headers, SESSION_COOKIE)
    const verified = await fetch(`${harness.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: session } })
    expect(verified.status).toBe(204)
    expect(verified.headers.get('x-dsh-auth-user-id')).toBe('admin')
    expect(readdirSync(harness.directory)).toHaveLength(0)
  })

  it('redirects an unconfigured administrator to first-time setup', async () => {
    const credentials = await testCredentials()
    const harness = await tokenHarness(credentials, { configured: false })
    const issued = harness.store.issue({ ttlSeconds: 300 })

    const accepted = await redeem(harness.baseUrl, issued.token)

    expect(accepted.status).toBe(303)
    expect(accepted.headers.get('location')).toBe('/auth/admin/setup?returnTo=%2F')
    const session = cookiePair(accepted.headers, SESSION_COOKIE)
    const view = await fetch(`${harness.baseUrl}/auth/session`, { headers: { ...proxyHeaders(), cookie: session } })
    const body = (await view.json()) as { user: { username: string } }
    expect(body.user.username).toBe('admin')
  })

  it('answers every token failure with one identical no-store page', async () => {
    const credentials = await testCredentials()
    const harness = await tokenHarness(credentials, { config: { loginTokenFailureMessageEn: 'Custom <b>unavailable</b> message' } })
    let clock = Date.UTC(2026, 0, 1)
    const expired = new LoginTokenStore({ host: createNodeTokenHost(), directory: harness.directory, now: () => clock }).issue({ ttlSeconds: 60 })
    clock += 61_000

    const bodies: string[] = []
    for (const token of ['missing', 'not-a-token', `dsh_otl_v1_${'A'.repeat(43)}`, expired.token]) {
      const denied = await redeem(harness.baseUrl, token)
      expect(denied.status, token).toBe(401)
      expect(denied.headers.get('cache-control')).toBe('no-store, max-age=0')
      const body = await denied.text()
      expect(body, token).toContain('Custom &lt;b&gt;unavailable&lt;/b&gt; message')
      expect(body, token).not.toContain('<b>unavailable</b>')
      expect(body, token).not.toContain(token)
      bodies.push(body)
    }
    expect(new Set(bodies).size).toBe(1)
    expect(readdirSync(harness.directory)).toHaveLength(0)
  })

  it('keeps cross-origin, bad-CSRF, wrong-type, oversized, and wrong-method requests unconsumed', async () => {
    const credentials = await testCredentials()
    const harness = await tokenHarness(credentials)
    const issued = harness.store.issue({ ttlSeconds: 300 })

    expect((await redeem(harness.baseUrl, issued.token, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await fetch(`${harness.baseUrl}/auth/token`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders(), 'content-type': 'application/json', cookie: '' },
      body: '{}',
    })).status).toBe(415)
    const page = await fetch(`${harness.baseUrl}/auth/token`, { headers: proxyHeaders() })
    const cookie = cookiePair(page.headers, CSRF_COOKIE)
    const csrf = csrfMeta(await page.text())
    expect((await fetch(`${harness.baseUrl}/auth/token`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders(), 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf: 'wrong', token: issued.token }).toString(),
    })).status).toBe(403)
    expect((await fetch(`${harness.baseUrl}/auth/token`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders(), 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf, token: issued.token, extra: 'x'.repeat(21 * 1024) }).toString(),
    })).status).toBe(413)
    expect((await fetch(`${harness.baseUrl}/auth/token`, { method: 'PUT', headers: proxyHeaders() })).status).toBe(405)

    expect((await redeem(harness.baseUrl, issued.token)).status).toBe(303)
  })

  it('accepts Chrome Origin null after replaceState when CSRF is valid', async () => {
    const credentials = await testCredentials()
    const harness = await tokenHarness(credentials, { configured: false })
    const issued = harness.store.issue({ ttlSeconds: 300 })
    expect((await redeem(harness.baseUrl, issued.token, { origin: 'null' })).status).toBe(303)
  })

  it('rate-limits independently from the password limiter', async () => {
    const credentials = await testCredentials()
    const harness = await tokenHarness(credentials, { config: { loginTokenWindowSeconds: 60, loginTokenMaxAttempts: 2, loginTokenBlockSeconds: 300 } })
    const issued = harness.store.issue({ ttlSeconds: 300 })
    await redeem(harness.baseUrl, 'probe')
    await redeem(harness.baseUrl, 'probe')

    const limited = await redeem(harness.baseUrl, issued.token)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/u)
    expect(await limited.text()).not.toContain(issued.token)

    const loginPage = await fetch(`${harness.baseUrl}/auth/login`, { headers: proxyHeaders() })
    const loginDenied = await fetch(`${harness.baseUrl}/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...proxyHeaders(),
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookiePair(loginPage.headers, CSRF_COOKIE),
      },
      body: new URLSearchParams({
        csrf: hiddenValue(await loginPage.text(), 'csrf'),
        returnTo: '/',
        username: 'test-account',
        password: 'wrong-password-value',
      }).toString(),
    })
    expect(loginDenied.status).toBe(401)

    expect((await fetch(`${harness.baseUrl}/auth/token`, { headers: proxyHeaders() })).status).toBe(200)
  })

  it('lets exactly one of two concurrent redemptions succeed', async () => {
    const credentials = await testCredentials()
    const harness = await tokenHarness(credentials)
    const issued = harness.store.issue({ ttlSeconds: 300 })
    const { cookie, csrf } = await bridgePage(harness.baseUrl)

    const posts = [0, 1].map(() => fetch(`${harness.baseUrl}/auth/token`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, token: issued.token }).toString(),
    }))
    const statuses = (await Promise.all(posts)).map(result => result.status)

    expect(new Set(statuses)).toEqual(new Set([303, 401]))
    expect((await redeem(harness.baseUrl, issued.token)).status).toBe(401)
    expect(readdirSync(harness.directory)).toHaveLength(0)
  })

  it('never restores a consumed token when session persistence fails', async () => {
    const credentials = await testCredentials()
    const harness = await tokenHarness(credentials)
    const issued = harness.store.issue({ ttlSeconds: 300 })
    const original = (await import('node:fs')).readFileSync(harness.authStateFile, 'utf8')
    rmSync(harness.authStateFile)
    mkdirSync(harness.authStateFile)

    const denied = await redeem(harness.baseUrl, issued.token)
    expect(denied.status).toBe(401)
    expect(await denied.text()).not.toContain(issued.token)

    rmSync(harness.authStateFile, { recursive: true, force: true })
    writeFileSync(harness.authStateFile, original, { mode: 0o600 })
    expect((await redeem(harness.baseUrl, issued.token)).status).toBe(401)
    expect(readdirSync(harness.directory).filter(name => name.startsWith('.dsh_otl_v1_consuming_'))).toHaveLength(1)
  })

  it('rejects an expired token and removes its file during redemption', async () => {
    const credentials = await testCredentials()
    let clock = Date.UTC(2026, 0, 1)
    const harness = await tokenHarness(credentials, { clock: () => clock })
    const issued = harness.store.issue({ ttlSeconds: 60 })
    const digest = createHash('sha256').update(issued.token).digest('hex')
    expect(readdirSync(harness.directory)).toEqual([digest])

    clock += 60_001
    expect((await redeem(harness.baseUrl, issued.token)).status).toBe(401)
    expect(readdirSync(harness.directory)).toEqual([])
  })
})
