import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { authStateSecretId, createAuthStateDocument } from '../src/auth-state.js'
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/cookies.js'
import { SessionStore } from '../src/session.js'
import {
  cookiePair,
  hiddenValue,
  proxyHeaders,
  startTestServer,
  testConfig,
  testCredentials,
  type TestCredentials,
} from './helpers.js'

const roots: string[] = []
const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function configuredServer(overrides: { readonly loginMaxAttempts?: number } = {}): Promise<{
  readonly baseUrl: string
  readonly credentials: TestCredentials
  readonly authStateFile: string
}> {
  const credentials = await testCredentials()
  const config = testConfig(credentials, overrides)
  const server = await startTestServer(config)
  servers.push(server.server)
  return { baseUrl: server.baseUrl, credentials, authStateFile: config.authStateFile }
}

async function login(baseUrl: string, credentials: TestCredentials): Promise<string> {
  const page = await fetch(`${baseUrl}/auth/login`)
  const accepted = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...proxyHeaders(), cookie: cookiePair(page.headers, CSRF_COOKIE) },
    body: new URLSearchParams({
      csrf: hiddenValue(await page.text(), 'csrf'),
      returnTo: '/',
      username: 'test-account',
      password: credentials.password,
    }),
  })
  expect(accepted.status).toBe(303)
  return cookiePair(accepted.headers, SESSION_COOKIE)
}

async function openPasswordPage(baseUrl: string, session: string, returnTo = '/'): Promise<{
  readonly status: number
  readonly html: string
  readonly location: string | null
  readonly csrfCookie: string
}> {
  const page = await fetch(`${baseUrl}/auth/admin/password?returnTo=${encodeURIComponent(returnTo)}`, {
    redirect: 'manual',
    headers: { ...proxyHeaders(), cookie: session },
  })
  const html = await page.text()
  return {
    status: page.status,
    html,
    location: page.headers.get('location'),
    csrfCookie: page.status === 200 ? cookiePair(page.headers, CSRF_COOKIE) : '',
  }
}

function submitPasswordChange(
  baseUrl: string,
  session: string,
  csrfCookie: string,
  html: string,
  values: { readonly currentPassword: string; readonly password: string; readonly confirmPassword?: string },
): Promise<Response> {
  return fetch(`${baseUrl}/auth/admin/password`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...proxyHeaders(), cookie: `${session}; ${csrfCookie}` },
    body: new URLSearchParams({
      csrf: hiddenValue(html, 'csrf'),
      returnTo: hiddenValue(html, 'returnTo'),
      currentPassword: values.currentPassword,
      password: values.password,
      confirmPassword: values.confirmPassword ?? values.password,
    }),
  })
}

describe('authenticated administrator password change', () => {
  it('requires a session, Origin, CSRF, and the current password before replacing the hash', async () => {
    const harness = await configuredServer()
    const anonymous = await fetch(`${harness.baseUrl}/auth/admin/password?returnTo=%2Fworkspace`, { redirect: 'manual' })
    expect(anonymous.status).toBe(303)
    expect(anonymous.headers.get('location')).toBe(
      '/auth/login?returnTo=%2Fauth%2Fadmin%2Fpassword%3FreturnTo%3D%252Fworkspace',
    )
    expect((await fetch(`${harness.baseUrl}/auth/admin/password`, { method: 'PUT' })).status).toBe(405)

    const session = await login(harness.baseUrl, harness.credentials)
    const page = await openPasswordPage(harness.baseUrl, session, '/workspace')
    expect(page.status).toBe(200)
    expect(page.html).toContain('<h1>Reset password</h1>')
    expect(page.html).toContain('autocomplete="current-password"')
    expect(page.html).toContain('autocomplete="new-password"')
    expect(page.html).toContain('name="currentPassword"')

    const account = await fetch(`${harness.baseUrl}/auth/account`, { headers: { cookie: session } })
    const accountHtml = await account.text()
    expect(accountHtml).toContain('href="/auth/admin/password"')
    expect(accountHtml).toMatch(/Reset password|重设密码/u)

    const noOrigin = await fetch(`${harness.baseUrl}/auth/admin/password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: `${session}; ${page.csrfCookie}` },
      body: new URLSearchParams({ csrf: hiddenValue(page.html, 'csrf'), returnTo: '/', currentPassword: 'x', password: 'y', confirmPassword: 'y' }),
    })
    expect(noOrigin.status).toBe(403)

    const next = await openPasswordPage(harness.baseUrl, session)
    const mismatch = await submitPasswordChange(harness.baseUrl, session, next.csrfCookie, next.html, {
      currentPassword: harness.credentials.password,
      password: 'replacement-password-ok',
      confirmPassword: 'replacement-password-no',
    })
    expect(mismatch.status).toBe(400)
    expect(await mismatch.text()).toContain('The passwords do not match.')

    const invalid = await openPasswordPage(harness.baseUrl, session)
    const tooShort = await submitPasswordChange(harness.baseUrl, session, invalid.csrfCookie, invalid.html, {
      currentPassword: harness.credentials.password,
      password: 'short-password',
    })
    expect(tooShort.status).toBe(400)
    expect(await tooShort.text()).toContain('Password must be 15-128 characters')

    const wrong = await openPasswordPage(harness.baseUrl, session)
    const denied = await submitPasswordChange(harness.baseUrl, session, wrong.csrfCookie, wrong.html, {
      currentPassword: 'wrong-current-password-value',
      password: 'replacement-password-ok',
    })
    expect(denied.status).toBe(401)
    expect(await denied.text()).toContain('The current password is incorrect.')
  }, 30_000)

  it('updates the password, keeps the current session, and revokes other sessions', async () => {
    const harness = await configuredServer()
    const current = await login(harness.baseUrl, harness.credentials)
    const extra = await login(harness.baseUrl, harness.credentials)
    const replacement = randomBytes(18).toString('base64url')
    const page = await openPasswordPage(harness.baseUrl, current)
    const accepted = await submitPasswordChange(harness.baseUrl, current, page.csrfCookie, page.html, {
      currentPassword: harness.credentials.password,
      password: replacement,
    })
    expect(accepted.status).toBe(200)
    const html = await accepted.text()
    expect(html).toContain('<h1>Password updated</h1>')
    expect(html).toContain('href="/"')
    expect(html).not.toContain(replacement)
    expect(html).not.toContain(harness.credentials.password)

    expect((await fetch(`${harness.baseUrl}/auth/verify`, { headers: { cookie: current } })).status).toBe(204)
    expect((await fetch(`${harness.baseUrl}/auth/verify`, { headers: { cookie: extra } })).status).toBe(401)

    const saved = JSON.parse(readFileSync(harness.authStateFile, 'utf8')) as {
      readonly secretId: string
      readonly administrator: { readonly username: string; readonly passwordHash: string }
    }
    expect(saved.administrator.username).toBe('test-account')
    expect(saved.administrator.passwordHash).not.toBe(harness.credentials.hash)
    expect(saved.administrator.passwordHash).not.toContain(replacement)

    const loginPage = await fetch(`${harness.baseUrl}/auth/login`)
    const oldDenied = await fetch(`${harness.baseUrl}/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: cookiePair(loginPage.headers, CSRF_COOKIE) },
      body: new URLSearchParams({
        csrf: hiddenValue(await loginPage.text(), 'csrf'),
        returnTo: '/',
        username: 'test-account',
        password: harness.credentials.password,
      }),
    })
    expect(oldDenied.status).toBe(401)

    const nextLogin = await fetch(`${harness.baseUrl}/auth/login`)
    const signedIn = await fetch(`${harness.baseUrl}/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: cookiePair(nextLogin.headers, CSRF_COOKIE) },
      body: new URLSearchParams({
        csrf: hiddenValue(await nextLogin.text(), 'csrf'),
        returnTo: '/',
        username: 'test-account',
        password: replacement,
      }),
    })
    expect(signedIn.status).toBe(303)
  }, 30_000)

  it('rate-limits current-password guesses with the login limiter', async () => {
    const harness = await configuredServer({ loginMaxAttempts: 1 })
    const session = await login(harness.baseUrl, harness.credentials)
    const first = await openPasswordPage(harness.baseUrl, session)
    const denied = await submitPasswordChange(harness.baseUrl, session, first.csrfCookie, first.html, {
      currentPassword: 'wrong-current-password-value',
      password: 'replacement-password-ok',
    })
    expect(denied.status).toBe(401)
    const next = await openPasswordPage(harness.baseUrl, session)
    const blocked = await submitPasswordChange(harness.baseUrl, session, next.csrfCookie, next.html, {
      currentPassword: harness.credentials.password,
      password: 'replacement-password-ok',
    })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
  }, 30_000)

  it('sends unconfigured sessions to first-time setup instead of the change form', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-password-unconfigured-'))
    roots.push(root)
    const authStateFile = join(root, 'auth-state.json')
    const sessionSecretFile = join(root, 'session-secret')
    writeFileSync(sessionSecretFile, `${credentials.secret}\n`, { mode: 0o600 })
    writeFileSync(authStateFile, `${JSON.stringify(createAuthStateDocument(authStateSecretId(Buffer.from(credentials.secret))))}\n`, { mode: 0o600 })
    const config = testConfig(credentials, { authStateFile, sessionSecretFile })
    const created = new SessionStore(config).create(Date.now(), 'login-token')
    const server = await startTestServer(config)
    servers.push(server.server)
    const session = `${SESSION_COOKIE}=${created.cookieValue}`
    const page = await openPasswordPage(server.baseUrl, session, '/workspace')
    expect(page.status).toBe(303)
    expect(page.location).toBe('/auth/admin/setup?returnTo=%2Fworkspace')
  }, 30_000)
})
