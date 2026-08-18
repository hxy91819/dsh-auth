import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { authStateSecretId, createAuthStateDocument } from '../src/auth-state.js'
import {
  CSRF_COOKIE,
  INSECURE_CSRF_COOKIE,
  INSECURE_SESSION_COOKIE,
  SESSION_COOKIE,
} from '../src/cookies.js'
import type { HarnessUiSettings } from '../src/preferences.js'
import type { TestCredentials, TestServer } from './helpers.js'
import {
  cookiePair,
  hiddenValue,
  proxyHeaders,
  startTestServer,
  testConfig,
  testCredentials,
} from './helpers.js'

let credentials: TestCredentials
let running: TestServer
let harnessUiSettings: HarnessUiSettings = {}

beforeAll(async () => {
  credentials = await testCredentials()
  running = await startTestServer(testConfig(credentials), undefined, () => harnessUiSettings)
}, 30_000)

beforeEach(() => {
  harnessUiSettings = {}
})

afterAll(async () => {
  running.server.close()
  await once(running.server, 'close')
})

async function loginPage(returnTo = '/'): Promise<{ csrfCookie: string; csrf: string; html: string }> {
  const response = await fetch(`${running.baseUrl}/auth/login?returnTo=${encodeURIComponent(returnTo)}`, {
    redirect: 'manual',
  })
  const html = await response.text()
  expect(response.headers.get('referrer-policy')).toBe('same-origin')
  return {
    csrfCookie: cookiePair(response.headers, CSRF_COOKIE),
    csrf: hiddenValue(html, 'csrf'),
    html,
  }
}

async function submitLogin(
  csrfCookie: string,
  csrf: string,
  password: string,
  returnTo = '/',
  username = 'test-account',
): Promise<Response> {
  return fetch(`${running.baseUrl}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...proxyHeaders(), cookie: csrfCookie },
    body: new URLSearchParams({ csrf, returnTo, username, password }),
  })
}

// eslint-disable-next-line max-lines-per-function -- 行为场景按真实认证旅程排序，断言依赖顺序；阈值 2026-08 新增，待 token 登录场景并入本文件时再拆分（STORY-05/06）。
describe('observable authentication flow', () => {
  it('keeps password login unavailable while administrator credentials are unset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-unconfigured-'))
    const authStateFile = join(root, 'auth-state.json')
    const sessionSecretFile = join(root, 'session-secret')
    writeFileSync(sessionSecretFile, `${credentials.secret}\n`, { mode: 0o600 })
    writeFileSync(authStateFile, `${JSON.stringify(createAuthStateDocument(authStateSecretId(Buffer.from(credentials.secret))))}\n`, { mode: 0o600 })
    const unconfigured = await startTestServer(testConfig(credentials, { authStateFile, sessionSecretFile }))
    try {
      const page = await fetch(`${unconfigured.baseUrl}/auth/login`)
      const html = await page.text()
      expect(html).not.toContain('name="password"')
      expect(html).toMatch(/cloud console|云控制台/u)
      const denied = await fetch(`${unconfigured.baseUrl}/auth/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { ...proxyHeaders(), cookie: cookiePair(page.headers, CSRF_COOKIE) },
        body: new URLSearchParams({
          csrf: 'unused', returnTo: '/', username: 'test-account', password: credentials.password,
        }),
      })
      expect(denied.status).toBeGreaterThanOrEqual(400)
      expect(denied.headers.getSetCookie().some(value => value.startsWith(`${SESSION_COOKIE}=`))).toBe(false)
    } finally {
      unconfigured.server.close()
      await once(unconfigured.server, 'close')
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('uses a generic failure, issues hardened cookies, exposes identity, and revokes on logout', async () => {
    const first = await loginPage('/workspace?tab=recent')
    expect(first.html).toContain('Sign in to DeepSeek Harness')
    expect(first.html).not.toContain('Continue with the account configured by this deployment.')
    expect(first.html).not.toContain('Credentials are verified by this deployment')
    const denied = await submitLogin(first.csrfCookie, first.csrf, randomBytes(24).toString('base64url'))
    expect(denied.status).toBe(401)
    expect(await denied.text()).toContain('username or password is incorrect')

    const deniedHtml = await (async () => {
      const fresh = await loginPage('/workspace?tab=recent')
      return fresh
    })()
    const accepted = await submitLogin(deniedHtml.csrfCookie, deniedHtml.csrf, credentials.password, '/workspace?tab=recent')
    expect(accepted.status).toBe(303)
    expect(accepted.headers.get('location')).toBe('/workspace?tab=recent')
    const sessionField = accepted.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`))
    expect(sessionField).toContain('HttpOnly')
    expect(sessionField).toContain('Secure')
    expect(sessionField).toContain('SameSite=Lax')
    expect(sessionField).toContain('Path=/')
    const sessionCookie = cookiePair(accepted.headers, SESSION_COOKIE)

    const session = await fetch(`${running.baseUrl}/auth/session`, { headers: { cookie: sessionCookie } })
    expect(session.status).toBe(200)
    await expect(session.json()).resolves.toMatchObject({
      authenticated: true,
      user: { userId: 'admin', username: 'test-account', roles: ['admin'] },
    })
    const verified = await fetch(`${running.baseUrl}/auth/verify`, { headers: { cookie: sessionCookie } })
    expect(verified.status).toBe(204)

    const csrfResponse = await fetch(`${running.baseUrl}/auth/csrf`, { headers: { cookie: sessionCookie } })
    expect(csrfResponse.status).toBe(200)
    expect(csrfResponse.headers.get('cache-control')).toContain('no-store')
    const csrfCookie = cookiePair(csrfResponse.headers, CSRF_COOKIE)
    const csrfBody = await csrfResponse.json() as { csrf: string }
    expect(csrfBody.csrf).toEqual(expect.any(String))

    harnessUiSettings = { locale: { preference: 'zh' }, theme: { preference: 'dark' } }
    const account = await fetch(`${running.baseUrl}/auth/account`, {
      headers: { 'accept-language': 'en-US', cookie: sessionCookie },
    })
    const accountHtml = await account.text()
    expect(accountHtml).toContain('<html lang="zh-CN">')
    expect(accountHtml).toContain('<body data-theme="dark">')
    expect(accountHtml).toContain('<h1>账户</h1>')
    expect(accountHtml).not.toContain('class="preferences"')
    const logout = await fetch(`${running.baseUrl}/auth/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: `${sessionCookie}; ${csrfCookie}` },
      body: new URLSearchParams({ csrf: csrfBody.csrf }),
    })
    expect(logout.status).toBe(303)
    expect(logout.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`))).toContain('Max-Age=0')
    expect((await fetch(`${running.baseUrl}/auth/verify`, { headers: { cookie: sessionCookie } })).status).toBe(401)
  }, 30_000)

  it('rejects cross-origin protected mutations and WebSocket handshakes at the auth subrequest', async () => {
    const page = await loginPage()
    const accepted = await submitLogin(page.csrfCookie, page.csrf, credentials.password)
    const sessionCookie = cookiePair(accepted.headers, SESSION_COOKIE)

    const sameOriginMutation = await fetch(`${running.baseUrl}/auth/verify`, {
      headers: {
        ...proxyHeaders(),
        cookie: sessionCookie,
        'sec-fetch-site': 'same-origin',
        'x-original-method': 'POST',
      },
    })
    expect(sameOriginMutation.status).toBe(204)
    const sameOriginWebSocket = await fetch(`${running.baseUrl}/auth/verify`, {
      headers: {
        ...proxyHeaders(),
        cookie: sessionCookie,
        'sec-fetch-site': 'same-origin',
        'x-original-method': 'GET',
        'x-original-upgrade': 'websocket',
      },
    })
    expect(sameOriginWebSocket.status).toBe(204)

    const emptyUpgrade = await fetch(`${running.baseUrl}/auth/verify`, {
      headers: {
        cookie: sessionCookie,
        'x-original-method': 'GET',
        'x-original-upgrade': '',
      },
    })
    expect(emptyUpgrade.status).toBe(204)

    const missingOrigin = await fetch(`${running.baseUrl}/auth/verify`, {
      headers: {
        cookie: sessionCookie,
        'x-forwarded-host': 'auth.test',
        'x-forwarded-proto': 'https',
        'x-original-method': 'POST',
      },
    })
    expect(missingOrigin.status).toBe(403)

    for (const originalHeaders of [
      { origin: 'https://sibling.auth.test', 'sec-fetch-site': 'same-site', 'x-original-method': 'POST' },
      { origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site', 'x-original-method': 'POST' },
      { origin: 'https://sibling.auth.test', 'sec-fetch-site': 'same-site', 'x-original-method': 'GET', 'x-original-upgrade': 'websocket' },
    ]) {
      const denied = await fetch(`${running.baseUrl}/auth/verify`, {
        headers: { ...proxyHeaders(), ...originalHeaders, cookie: sessionCookie },
      })
      expect(denied.status).toBe(403)
      expect(denied.headers.get('cache-control')).toBe('no-store')
    }
  }, 30_000)

  it('rejects open redirects, tampered sessions, untrusted origins, and bad CSRF tokens', async () => {
    const anonymousCsrf = await fetch(`${running.baseUrl}/auth/csrf`)
    expect(anonymousCsrf.status).toBe(401)
    await expect(anonymousCsrf.json()).resolves.toEqual({ authenticated: false })
    expect(anonymousCsrf.headers.getSetCookie()).toHaveLength(0)

    const page = await loginPage('//example.invalid/path')
    expect(hiddenValue(page.html, 'returnTo')).toBe('/')
    const noOrigin = await fetch(`${running.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { cookie: page.csrfCookie },
      body: new URLSearchParams({ csrf: page.csrf, returnTo: '/', username: 'test-account', password: credentials.password }),
    })
    expect(noOrigin.status).toBe(403)

    const nullOrigin = await fetch(`${running.baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        cookie: page.csrfCookie,
        origin: 'null',
        'x-forwarded-host': 'auth.test',
        'x-forwarded-proto': 'https',
      },
      body: new URLSearchParams({ csrf: page.csrf, returnTo: '/', username: 'test-account', password: credentials.password }),
    })
    expect(nullOrigin.status).toBe(403)

    const crossSite = await fetch(`${running.baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        cookie: page.csrfCookie,
        origin: 'https://attacker.invalid',
        'x-forwarded-host': 'auth.test',
        'x-forwarded-proto': 'https',
      },
      body: new URLSearchParams({ csrf: page.csrf, returnTo: '/', username: 'test-account', password: credentials.password }),
    })
    expect(crossSite.status).toBe(403)

    const badCsrf = await submitLogin(page.csrfCookie, randomBytes(24).toString('base64url'), credentials.password)
    expect(badCsrf.status).toBe(403)
    const tampered = await fetch(`${running.baseUrl}/auth/verify`, {
      headers: { cookie: `${SESSION_COOKIE}=tampered.value`, 'x-original-uri': '//example.invalid' },
    })
    expect(tampered.status).toBe(401)
    expect(tampered.headers.get('x-dsh-auth-login')).toBe('/auth/login?returnTo=%2F')
  }, 30_000)

  it('supports explicitly configured plain HTTP cookies without weakening the default', async () => {
    const insecure = await startTestServer(testConfig(credentials, { secureCookies: false }))
    try {
      const page = await fetch(`${insecure.baseUrl}/auth/login`)
      const html = await page.text()
      const csrfField = page.headers.getSetCookie().find(value => value.startsWith(`${INSECURE_CSRF_COOKIE}=`))
      expect(csrfField).toContain('HttpOnly')
      expect(csrfField).toContain('SameSite=Lax')
      expect(csrfField).not.toContain('Secure')
      expect(csrfField).not.toContain('__Host-')

      const publicAuthority = new URL(insecure.baseUrl).host
      const accepted = await fetch(`${insecure.baseUrl}/auth/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          cookie: cookiePair(page.headers, INSECURE_CSRF_COOKIE),
          origin: insecure.baseUrl,
          'x-forwarded-host': publicAuthority,
          'x-forwarded-proto': 'http',
          'x-real-ip': '192.0.2.13',
        },
        body: new URLSearchParams({
          csrf: hiddenValue(html, 'csrf'), returnTo: '/', username: 'test-account', password: credentials.password,
        }),
      })
      expect(accepted.status).toBe(303)
      const sessionField = accepted.headers.getSetCookie().find(value => value.startsWith(`${INSECURE_SESSION_COOKIE}=`))
      expect(sessionField).toContain('HttpOnly')
      expect(sessionField).toContain('SameSite=Lax')
      expect(sessionField).not.toContain('Secure')
      const sessionCookie = cookiePair(accepted.headers, INSECURE_SESSION_COOKIE)
      expect((await fetch(`${insecure.baseUrl}/auth/verify`, { headers: { cookie: sessionCookie } })).status).toBe(204)

      const ignoredPreferences = await fetch(`${insecure.baseUrl}/auth/login?lang=zh&theme=dark`, {
        headers: {
          'accept-language': 'en-US',
          cookie: 'dsh_auth_language=zh; dsh_auth_theme=dark',
        },
      })
      const ignoredHtml = await ignoredPreferences.text()
      expect(ignoredHtml).toContain('<html lang="en">')
      expect(ignoredHtml).toContain('<body data-theme="system">')
      expect(ignoredPreferences.headers.getSetCookie().some(value => value.startsWith('dsh_auth_language='))).toBe(false)
      expect(ignoredPreferences.headers.getSetCookie().some(value => value.startsWith('dsh_auth_theme='))).toBe(false)

      const bootstrap = await fetch(`${insecure.baseUrl}/auth/browser-bootstrap.js`)
      expect(bootstrap.status).toBe(200)
      expect(bootstrap.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      expect(await bootstrap.text()).toContain('getRandomValues')
    } finally {
      insecure.server.close()
      await once(insecure.server, 'close')
    }
  }, 30_000)

  it('follows live Harness locale and theme settings without owning preference controls', async () => {
    harnessUiSettings = { locale: { preference: 'zh' }, theme: { preference: 'dark' } }
    const localized = await fetch(`${running.baseUrl}/auth/login?returnTo=%2Fworkspaces&lang=en&theme=light`, {
      headers: {
        'accept-language': 'en-US,en;q=0.9',
        cookie: '__Host-dsh_auth_language=en; __Host-dsh_auth_theme=light',
      },
    })
    const html = await localized.text()
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<body data-theme="dark">')
    expect(html).toContain('登录 DeepSeek Harness')
    expect(html).not.toContain('使用此部署配置的账户继续。')
    expect(html).not.toContain('凭据仅由此部署验证')
    expect(html).not.toContain('class="preferences"')
    expect(html).not.toContain('aria-label="外观"')
    expect(html).not.toContain('dsh_auth_language')
    expect(html).not.toContain('dsh_auth_theme')
    expect(html).not.toContain('<script')

    harnessUiSettings = { locale: { preference: 'en' }, theme: { preference: 'light' } }
    const updated = await fetch(`${running.baseUrl}/auth/login`)
    const updatedHtml = await updated.text()
    expect(updatedHtml).toContain('<html lang="en">')
    expect(updatedHtml).toContain('<body data-theme="light">')

    harnessUiSettings = { locale: {}, theme: { preference: 'system' } }
    const browserDefault = await fetch(`${running.baseUrl}/auth/login`, {
      headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.5' },
    })
    const defaultHtml = await browserDefault.text()
    expect(defaultHtml).toContain('<html lang="zh-CN">')
    expect(defaultHtml).toContain('<body data-theme="system">')
    expect(browserDefault.headers.getSetCookie()).toHaveLength(1)
  })

  it('expires sessions and blocks repeated login attempts per forwarded client', async () => {
    let now = Date.now()
    const expiring = await startTestServer(testConfig(credentials, { sessionTtlSeconds: 60, idleTtlSeconds: 60 }), () => now)
    const pageResponse = await fetch(`${expiring.baseUrl}/auth/login`)
    const html = await pageResponse.text()
    const accepted = await fetch(`${expiring.baseUrl}/auth/login`, {
      method: 'POST', redirect: 'manual',
      headers: { ...proxyHeaders('192.0.2.11'), cookie: cookiePair(pageResponse.headers, CSRF_COOKIE) },
      body: new URLSearchParams({
        csrf: hiddenValue(html, 'csrf'), returnTo: '/', username: 'test-account', password: credentials.password,
      }),
    })
    const cookie = cookiePair(accepted.headers, SESSION_COOKIE)
    now += 61_000
    expect((await fetch(`${expiring.baseUrl}/auth/verify`, { headers: { cookie } })).status).toBe(401)
    expiring.server.close()
    await once(expiring.server, 'close')

    const limited = await startTestServer(testConfig(credentials, { loginMaxAttempts: 1 }))
    const firstPage = await fetch(`${limited.baseUrl}/auth/login`)
    const firstHtml = await firstPage.text()
    const wrong = randomBytes(24).toString('base64url')
    const firstAttempt = await fetch(`${limited.baseUrl}/auth/login`, {
      method: 'POST', headers: { ...proxyHeaders('192.0.2.12'), cookie: cookiePair(firstPage.headers, CSRF_COOKIE) },
      body: new URLSearchParams({ csrf: hiddenValue(firstHtml, 'csrf'), returnTo: '/', username: 'test-account', password: wrong }),
    })
    expect(firstAttempt.status).toBe(401)
    const nextPage = await fetch(`${limited.baseUrl}/auth/login`)
    const nextHtml = await nextPage.text()
    const blocked = await fetch(`${limited.baseUrl}/auth/login`, {
      method: 'POST', headers: { ...proxyHeaders('192.0.2.12'), cookie: cookiePair(nextPage.headers, CSRF_COOKIE) },
      body: new URLSearchParams({ csrf: hiddenValue(nextHtml, 'csrf'), returnTo: '/', username: 'test-account', password: wrong }),
    })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    limited.server.close()
    await once(limited.server, 'close')
  }, 30_000)
})
