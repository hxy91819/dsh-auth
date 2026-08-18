import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { authStateSecretId, createAuthStateDocument } from '../src/auth-state.js'
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/cookies.js'
import { LoginTokenStore, createNodeTokenHost } from '../src/login-token-store.js'
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

interface OnboardingHarness {
  readonly baseUrl: string
  readonly authStateFile: string
  readonly store: LoginTokenStore
  readonly credentials: TestCredentials
}

async function onboardingHarness(options: { readonly configured?: boolean } = {}): Promise<OnboardingHarness> {
  const credentials = await testCredentials()
  const root = mkdtempSync(join(tmpdir(), 'dsh-auth-onboarding-'))
  roots.push(root)
  const directory = join(root, 'login-tokens')
  mkdirSync(directory, { mode: 0o700 })
  chmodSync(directory, 0o700)
  const authStateFile = join(root, 'auth-state.json')
  const sessionSecretFile = join(root, 'session-secret')
  writeFileSync(sessionSecretFile, `${credentials.secret}\n`, { mode: 0o600 })
  const document = options.configured === true
    ? createAuthStateDocument(authStateSecretId(Buffer.from(credentials.secret)), {
      username: 'test-account',
      passwordHash: credentials.hash,
      configuredAt: Date.now(),
    })
    : createAuthStateDocument(authStateSecretId(Buffer.from(credentials.secret)))
  writeFileSync(authStateFile, `${JSON.stringify(document)}\n`, { mode: 0o600 })
  const config = testConfig(credentials, {
    authStateFile,
    sessionSecretFile,
    loginTokenEnabled: true,
    loginTokenDirectory: directory,
  })
  const server = await startTestServer(config)
  servers.push(server.server)
  return {
    baseUrl: server.baseUrl,
    authStateFile,
    credentials,
    store: new LoginTokenStore({ host: createNodeTokenHost(), directory }),
  }
}

function csrfMetaOrHidden(html: string): string {
  const meta = /<meta name="dsh-auth-csrf" content="([^"]*)">/u.exec(html)
  if (meta?.[1] !== undefined) return meta[1]
  return hiddenValue(html, 'csrf')
}

async function unconfiguredPasswordSession(): Promise<{ readonly baseUrl: string; readonly cookie: string }> {
  const credentials = await testCredentials()
  const root = mkdtempSync(join(tmpdir(), 'dsh-auth-onboarding-password-'))
  roots.push(root)
  const authStateFile = join(root, 'auth-state.json')
  const sessionSecretFile = join(root, 'session-secret')
  writeFileSync(sessionSecretFile, `${credentials.secret}\n`, { mode: 0o600 })
  writeFileSync(authStateFile, `${JSON.stringify(createAuthStateDocument(authStateSecretId(Buffer.from(credentials.secret))))}\n`, { mode: 0o600 })
  const config = testConfig(credentials, { authStateFile, sessionSecretFile })
  const created = new SessionStore(config).create(Date.now(), 'password')
  const server = await startTestServer(config)
  servers.push(server.server)
  return { baseUrl: server.baseUrl, cookie: `${SESSION_COOKIE}=${created.cookieValue}` }
}

async function redeemToken(harness: OnboardingHarness): Promise<string> {
  const issued = harness.store.issue({ ttlSeconds: 300 })
  const page = await fetch(`${harness.baseUrl}/auth/token`, { headers: proxyHeaders() })
  const accepted = await fetch(`${harness.baseUrl}/auth/token`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...proxyHeaders(),
      cookie: cookiePair(page.headers, CSRF_COOKIE),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ csrf: csrfMetaOrHidden(await page.text()), token: issued.token }),
  })
  expect(accepted.status).toBe(303)
  return cookiePair(accepted.headers, SESSION_COOKIE)
}

async function openSetup(baseUrl: string, session: string, returnTo = '/'): Promise<{
  readonly html: string
  readonly csrf: string
  readonly cookie: string
  readonly status: number
  readonly location: string | null
}> {
  const page = await fetch(`${baseUrl}/auth/admin/setup?returnTo=${encodeURIComponent(returnTo)}`, {
    redirect: 'manual',
    headers: { ...proxyHeaders(), cookie: session },
  })
  const html = await page.text()
  return {
    html,
    status: page.status,
    location: page.headers.get('location'),
    csrf: page.status === 200 ? hiddenValue(html, 'csrf') : '',
    cookie: page.status === 200
      ? `${session}; ${cookiePair(page.headers, CSRF_COOKIE)}`
      : session,
  }
}

async function submitSetup(
  baseUrl: string,
  cookie: string,
  csrf: string,
  fields: { readonly username: string; readonly password: string; readonly confirmPassword: string; readonly returnTo?: string },
): Promise<Response> {
  return fetch(`${baseUrl}/auth/admin/setup`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...proxyHeaders(),
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrf,
      returnTo: fields.returnTo ?? '/',
      username: fields.username,
      password: fields.password,
      confirmPassword: fields.confirmPassword,
    }),
  })
}

describe('administrator first-time setup page', () => {
  it('renders four GET outcomes: anonymous login, non-token 403, token form, and configured account', async () => {
    const harness = await onboardingHarness()
    const anonymous = await fetch(`${harness.baseUrl}/auth/admin/setup?returnTo=%2F`, {
      redirect: 'manual',
      headers: proxyHeaders(),
    })
    expect(anonymous.status).toBe(303)
    expect(anonymous.headers.get('location')).toMatch(/^\/auth\/login\?/u)
    expect(anonymous.headers.get('cache-control')).toBe('no-store, max-age=0')

    const tokenSession = await redeemToken(harness)
    const setup = await fetch(`${harness.baseUrl}/auth/admin/setup?returnTo=%2Fworkspace`, {
      headers: { ...proxyHeaders(), cookie: tokenSession, 'accept-language': 'zh-CN' },
    })
    const html = await setup.text()
    expect(setup.status).toBe(200)
    expect(setup.headers.get('cache-control')).toBe('no-store, max-age=0')
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<label for="username">')
    expect(html).toContain('<label for="password">')
    expect(html).toContain('<label for="confirmPassword">')
    expect(html).toContain('autocomplete="username"')
    expect(html).toContain('autocomplete="new-password"')
    expect(html).toContain('href="/workspace"')
    expect(html).not.toContain('type="hidden" name="later"')

    const passwordOnly = await unconfiguredPasswordSession()
    const forbidden = await fetch(`${passwordOnly.baseUrl}/auth/admin/setup`, {
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: passwordOnly.cookie },
    })
    expect(forbidden.status).toBe(403)
    expect(await forbidden.text()).not.toContain('name="password"')

    const configured = await onboardingHarness({ configured: true })
    const passwordPage = await fetch(`${configured.baseUrl}/auth/login`, { headers: proxyHeaders() })
    const signedIn = await fetch(`${configured.baseUrl}/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: cookiePair(passwordPage.headers, CSRF_COOKIE) },
      body: new URLSearchParams({
        csrf: hiddenValue(await passwordPage.text(), 'csrf'),
        returnTo: '/',
        username: 'test-account',
        password: configured.credentials.password,
      }),
    })
    const complete = await fetch(`${configured.baseUrl}/auth/admin/setup`, {
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: cookiePair(signedIn.headers, SESSION_COOKIE) },
    })
    expect(complete.status).toBe(303)
    expect(complete.headers.get('location')).toBe('/auth/account')
  }, 30_000)

  it('lets Later skip only this login and prompts again on the next token session', async () => {
    const harness = await onboardingHarness()
    const first = await redeemToken(harness)
    const setup = await openSetup(harness.baseUrl, first, '/')
    expect(setup.html).toContain('href="/"')

    const skipped = await fetch(`${harness.baseUrl}/`, { redirect: 'manual', headers: { cookie: first } })
    expect(skipped.status).not.toBe(303)
    const saved = JSON.parse(readFileSync(harness.authStateFile, 'utf8')) as { administrator: { username: null } }
    expect(saved.administrator.username).toBeNull()

    const second = await redeemToken(harness)
    const again = await fetch(`${harness.baseUrl}/auth/admin/setup`, {
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: second },
    })
    expect(again.status).toBe(200)
    expect(await again.text()).toContain('name="username"')
  }, 30_000)

  it('rejects username and password policy failures before writing credentials', async () => {
    const harness = await onboardingHarness()
    const session = await redeemToken(harness)
    const setup = await openSetup(harness.baseUrl, session)
    const password = `${harness.credentials.password}-ok`

    const cases = [
      { username: ' leading', password, confirmPassword: password, notice: /whitespace|空白/u },
      { username: 'trailing ', password, confirmPassword: password, notice: /whitespace|空白/u },
      { username: 'bad\u0007name', password, confirmPassword: password, notice: /1-64|1–64|控制/u },
      { username: 'a'.repeat(65), password, confirmPassword: password, notice: /1-64|1–64|控制/u },
      { username: 'owner', password: 'fourteen-char.', confirmPassword: 'fourteen-char.', notice: /15-128|15–128|1024/u },
      { username: 'owner', password, confirmPassword: `${password}-no`, notice: /match|不一致/u },
    ]
    for (const submitted of cases) {
      const denied = await submitSetup(harness.baseUrl, setup.cookie, setup.csrf, submitted)
      expect(denied.status, submitted.username).toBe(400)
      expect(await denied.text(), submitted.username).toMatch(submitted.notice)
      expect(JSON.parse(readFileSync(harness.authStateFile, 'utf8'))).toMatchObject({
        administrator: { username: null, passwordHash: null },
      })
    }
  }, 30_000)

})

describe('administrator first-time setup mutations', () => {
  it('initializes once, keeps the current session, revokes others, and enables password login after restart', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-onboarding-sessions-'))
    roots.push(root)
    const directory = join(root, 'login-tokens')
    mkdirSync(directory, { mode: 0o700 })
    chmodSync(directory, 0o700)
    const authStateFile = join(root, 'auth-state.json')
    const sessionSecretFile = join(root, 'session-secret')
    writeFileSync(sessionSecretFile, `${credentials.secret}\n`, { mode: 0o600 })
    writeFileSync(authStateFile, `${JSON.stringify(createAuthStateDocument(authStateSecretId(Buffer.from(credentials.secret))))}\n`, { mode: 0o600 })
    const config = testConfig(credentials, {
      authStateFile,
      sessionSecretFile,
      loginTokenEnabled: true,
      loginTokenDirectory: directory,
    })
    const store = new SessionStore(config)
    const current = store.create(Date.now(), 'login-token')
    const stale = store.create(Date.now() + 1, 'login-token')
    const extra = store.create(Date.now() + 2, 'login-token')
    const server = await startTestServer(config)
    servers.push(server.server)

    const setup = await openSetup(server.baseUrl, `${SESSION_COOKIE}=${current.cookieValue}`)
    const password = `${credentials.password}-set`
    const accepted = await submitSetup(server.baseUrl, setup.cookie, setup.csrf, {
      username: 'e\u0301lite',
      password,
      confirmPassword: password,
      returnTo: '/workspace',
    })
    expect(accepted.status).toBe(303)
    expect(accepted.headers.get('location')).toBe('/workspace')
    expect(accepted.headers.getSetCookie().some(value => value.startsWith(`${CSRF_COOKIE}=`) && value.includes('Max-Age=0'))).toBe(true)

    const sessionCookie = accepted.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`))
    const session = sessionCookie === undefined
      ? `${SESSION_COOKIE}=${current.cookieValue}`
      : sessionCookie.split(';', 1)[0] ?? `${SESSION_COOKIE}=${current.cookieValue}`
    const verified = await fetch(`${server.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: session } })
    expect(verified.status).toBe(204)
    expect(verified.headers.get('x-dsh-auth-username')).toBe(encodeURIComponent('élite'))
    expect((await fetch(`${server.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: `${SESSION_COOKIE}=${stale.cookieValue}` } })).status).toBe(401)
    expect((await fetch(`${server.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: `${SESSION_COOKIE}=${extra.cookieValue}` } })).status).toBe(401)

    server.server.close()
    const restarted = await startTestServer(config)
    servers.push(restarted.server)
    expect((await fetch(`${restarted.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: `${SESSION_COOKIE}=${current.cookieValue}` } })).status).toBe(204)
    const loginPage = await fetch(`${restarted.baseUrl}/auth/login`, { headers: proxyHeaders() })
    const loginHtml = await loginPage.text()
    expect(loginHtml).toContain('name="password"')
    expect(loginHtml).not.toContain('cloud console')
    const signedIn = await fetch(`${restarted.baseUrl}/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: cookiePair(loginPage.headers, CSRF_COOKIE) },
      body: new URLSearchParams({
        csrf: hiddenValue(loginHtml, 'csrf'),
        returnTo: '/',
        username: 'élite',
        password,
      }),
    })
    expect(signedIn.status).toBe(303)
    const deniedPage = await fetch(`${restarted.baseUrl}/auth/login`, { headers: proxyHeaders() })
    const denied = await fetch(`${restarted.baseUrl}/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: cookiePair(deniedPage.headers, CSRF_COOKIE) },
      body: new URLSearchParams({
        csrf: hiddenValue(await deniedPage.text(), 'csrf'),
        returnTo: '/',
        username: 'élite',
        password: 'wrong-password-value',
      }),
    })
    expect(denied.status).toBe(401)
    expect(await denied.text()).toContain('username or password is incorrect')
  }, 30_000)

  it('lets only the first concurrent setup write credentials and shows the loser a completed page', async () => {
    const harness = await onboardingHarness()
    const session = await redeemToken(harness)
    const setup = await openSetup(harness.baseUrl, session)
    const firstPassword = `${harness.credentials.password}-one`
    const secondPassword = `${harness.credentials.password}-two`
    const posts = [
      submitSetup(harness.baseUrl, setup.cookie, setup.csrf, {
        username: 'first-owner', password: firstPassword, confirmPassword: firstPassword,
      }),
      submitSetup(harness.baseUrl, setup.cookie, setup.csrf, {
        username: 'second-owner', password: secondPassword, confirmPassword: secondPassword,
      }),
    ]
    const results = await Promise.all(posts)
    const statuses = results.map(result => result.status).sort((left, right) => left - right)
    expect(statuses).toEqual([200, 303])
    const completed = results.find(result => result.status === 200)
    expect(await completed?.text()).toMatch(/already|已设置|已配置/u)
    const username = (JSON.parse(readFileSync(harness.authStateFile, 'utf8')) as {
      administrator: { username: string }
    }).administrator.username
    expect(['first-owner', 'second-owner']).toContain(username)
    const winner = username === 'first-owner'
      ? { username: 'first-owner', password: firstPassword }
      : { username: 'second-owner', password: secondPassword }
    const loser = username === 'first-owner'
      ? { username: 'second-owner', password: secondPassword }
      : { username: 'first-owner', password: firstPassword }

    const loginPage = await fetch(`${harness.baseUrl}/auth/login`, { headers: proxyHeaders() })
    const accepted = await fetch(`${harness.baseUrl}/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: cookiePair(loginPage.headers, CSRF_COOKIE) },
      body: new URLSearchParams({
        csrf: hiddenValue(await loginPage.text(), 'csrf'),
        returnTo: '/',
        ...winner,
      }),
    })
    expect(accepted.status).toBe(303)
    const loserPage = await fetch(`${harness.baseUrl}/auth/login`, { headers: proxyHeaders() })
    const loserLogin = await fetch(`${harness.baseUrl}/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: cookiePair(loserPage.headers, CSRF_COOKIE) },
      body: new URLSearchParams({
        csrf: hiddenValue(await loserPage.text(), 'csrf'),
        returnTo: '/',
        ...loser,
      }),
    })
    expect(loserLogin.status).toBe(401)
  }, 30_000)
})

describe('password login after setup modes', () => {
  it('hides the password form until credentials exist and never auto-reminds a Later session', async () => {
    const harness = await onboardingHarness()
    const login = await fetch(`${harness.baseUrl}/auth/login`, { headers: proxyHeaders() })
    const loginHtml = await login.text()
    expect(login.status).toBe(200)
    expect(loginHtml).not.toContain('name="password"')
    expect(loginHtml).toMatch(/cloud console|云控制台/u)

    const session = await redeemToken(harness)
    const setup = await openSetup(harness.baseUrl, session)
    const later = /href="(\/[^"]*)"/u.exec(setup.html)?.[1]
    expect(later).toBe('/')
    const account = await fetch(`${harness.baseUrl}/auth/account`, { headers: { ...proxyHeaders(), cookie: session } })
    const accountHtml = await account.text()
    expect(account.status).toBe(200)
    expect(accountHtml).not.toContain('name="username"')
    expect(accountHtml).not.toContain('autofocus')
  }, 30_000)
})
