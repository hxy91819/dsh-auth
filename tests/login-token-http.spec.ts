import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
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
    readonly inspect?: (req: IncomingMessage) => void
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
  const server = await startTestServer(config, options.clock, undefined, options.inspect)
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

async function redeem(baseUrl: string, token: string, overrides: {
  readonly cookie?: string
  readonly csrf?: string
  readonly origin?: string | false
  readonly fetchSite?: string
} = {}): Promise<Response> {
  const { cookie, csrf } = await bridgePage(baseUrl)
  const headers: Record<string, string> = {
    ...proxyHeaders(),
    'content-type': 'application/x-www-form-urlencoded',
    cookie: overrides.cookie ?? cookie,
  }
  if (overrides.origin === false) delete headers.origin
  else if (overrides.origin !== undefined) headers.origin = overrides.origin
  if (overrides.fetchSite !== undefined) headers['sec-fetch-site'] = overrides.fetchSite
  return await fetch(`${baseUrl}/auth/token`, {
    method: 'POST',
    redirect: 'manual',
    headers,
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
      expect(page.headers.get('referrer-policy')).toBe('same-origin')
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

  it('rejects missing, null, and cross-origin token posts while CSRF remains valid', async () => {
    const credentials = await testCredentials()
    const harness = await tokenHarness(credentials, { configured: false })
    const issued = harness.store.issue({ ttlSeconds: 300 })

    expect((await redeem(harness.baseUrl, issued.token, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await redeem(harness.baseUrl, issued.token, { origin: 'null' })).status).toBe(403)
    expect((await redeem(harness.baseUrl, issued.token, { origin: 'null', fetchSite: 'same-origin' })).status).toBe(403)
    expect((await redeem(harness.baseUrl, issued.token, { origin: false })).status).toBe(403)
    expect(readdirSync(harness.directory)).toHaveLength(1)
    expect((await redeem(harness.baseUrl, issued.token)).status).toBe(303)
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

describe('token Chrome origin', () => {
  it('redeems a fragment URL from Chrome with a real same-origin header', async () => {
    const chrome = chromeExecutable()
    if (chrome === undefined) return
    const credentials = await testCredentials()
    const posted: { origin?: string, fetchSite?: string } = {}
    const harness = await tokenHarness(credentials, {
      configured: false,
      config: { secureCookies: false, trustedProxyAddresses: ['192.0.2.1'] },
      inspect(req) {
        if (req.method === 'POST' && req.url?.startsWith('/auth/token') === true) {
          const origin = singleHeader(req.headers.origin)
          const fetchSite = singleHeader(req.headers['sec-fetch-site'])
          if (origin !== undefined) posted.origin = origin
          if (fetchSite !== undefined) posted.fetchSite = fetchSite
        }
      },
    })
    const issued = harness.store.issue({ ttlSeconds: 300 })
    const browser = await openChrome(chrome, `${harness.baseUrl}/auth/token#token=${issued.token}`)
    try {
      const deadline = Date.now() + 12_000
      while (posted.origin === undefined && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(posted.origin).toBe(new URL(harness.baseUrl).origin)
      expect(posted.origin).not.toBe('null')
      expect(posted.fetchSite).toBe('same-origin')
      expect(readdirSync(harness.directory)).toHaveLength(0)
    } finally {
      browser.kill('SIGKILL')
    }
  }, 20_000)
})

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function chromeExecutable(): string | undefined {
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

async function allocatePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  server.close()
  await once(server, 'close')
  return address.port
}

async function openChrome(chrome: string, targetUrl: string): Promise<ReturnType<typeof spawn>> {
  const debugPort = await allocatePort()
  const profile = mkdtempSync(join(tmpdir(), 'dsh-auth-chrome-origin-'))
  roots.push(profile)
  const child = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${String(debugPort)}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${String(debugPort)}/json/version`)).ok) break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  const targetResponse = await fetch(`http://127.0.0.1:${String(debugPort)}/json/new?${encodeURIComponent(targetUrl)}`, {
    method: 'PUT',
  })
  if (!targetResponse.ok) {
    child.kill('SIGKILL')
    throw new Error(`Chrome target creation failed with status ${String(targetResponse.status)}`)
  }
  return child
}
