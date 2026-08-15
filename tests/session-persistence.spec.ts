import { once } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/cookies.js'
import type { TestCredentials } from './helpers.js'
import {
  cookiePair,
  hiddenValue,
  proxyHeaders,
  startTestServer,
  testConfig,
  testCredentials,
} from './helpers.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function login(baseUrl: string, credentials: TestCredentials): Promise<{ readonly cookie: string; readonly field: string }> {
  const page = await fetch(`${baseUrl}/auth/login`)
  const pageHtml = await page.text()
  const accepted = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...proxyHeaders(), cookie: cookiePair(page.headers, CSRF_COOKIE) },
    body: new URLSearchParams({
      csrf: hiddenValue(pageHtml, 'csrf'),
      returnTo: '/',
      username: 'test-account',
      password: credentials.password,
    }),
  })
  const field = accepted.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`))
  if (field === undefined) throw new Error('login omitted the session cookie')
  return { cookie: cookiePair(accepted.headers, SESSION_COOKIE), field }
}

describe('persistent renewable sessions', () => {
  it('survives an application restart, renews after activity, and persists logout revocation', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-session-'))
    roots.push(root)
    const sessionStoreFile = join(root, 'sessions.json')
    let now = Date.UTC(2026, 0, 1)
    const config = testConfig(credentials, {
      sessionStoreFile,
      sessionTtlSeconds: 72 * 60 * 60,
      idleTtlSeconds: 72 * 60 * 60,
      sessionRenewalSeconds: 60 * 60,
    })

    const first = await startTestServer(config, () => now)
    const loggedIn = await login(first.baseUrl, credentials)
    expect(loggedIn.field).toContain('Max-Age=259200')
    const sessionCookie = loggedIn.cookie
    const initialView = await fetch(`${first.baseUrl}/auth/session`, { headers: { cookie: sessionCookie } })
    const initialBody = await initialView.json() as { expiresAt: string }
    expect(statSync(sessionStoreFile).mode & 0o777).toBe(0o600)

    now += 60 * 60 * 1000 + 1
    const renewed = await fetch(`${first.baseUrl}/auth/verify`, { headers: { cookie: sessionCookie } })
    expect(renewed.status).toBe(204)
    expect(renewed.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`))).toContain('Max-Age=259200')
    const renewedView = await fetch(`${first.baseUrl}/auth/session`, { headers: { cookie: sessionCookie } })
    const renewedBody = await renewedView.json() as { expiresAt: string }
    expect(Date.parse(renewedBody.expiresAt)).toBeGreaterThan(Date.parse(initialBody.expiresAt))

    first.server.close()
    await once(first.server, 'close')
    const restarted = await startTestServer(config, () => now)
    expect((await fetch(`${restarted.baseUrl}/auth/verify`, { headers: { cookie: sessionCookie } })).status).toBe(204)

    const csrfResponse = await fetch(`${restarted.baseUrl}/auth/csrf`, { headers: { cookie: sessionCookie } })
    const csrfBody = await csrfResponse.json() as { csrf: string }
    const logout = await fetch(`${restarted.baseUrl}/auth/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...proxyHeaders(),
        cookie: `${sessionCookie}; ${cookiePair(csrfResponse.headers, CSRF_COOKIE)}`,
      },
      body: new URLSearchParams({ csrf: csrfBody.csrf }),
    })
    expect(logout.status).toBe(303)
    restarted.server.close()
    await once(restarted.server, 'close')

    const afterLogoutRestart = await startTestServer(config, () => now)
    expect((await fetch(`${afterLogoutRestart.baseUrl}/auth/verify`, { headers: { cookie: sessionCookie } })).status).toBe(401)
    afterLogoutRestart.server.close()
    await once(afterLogoutRestart.server, 'close')
  }, 30_000)

  it('fails at startup instead of discarding malformed persistent state', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-session-invalid-'))
    roots.push(root)
    const sessionStoreFile = join(root, 'sessions.json')
    writeFileSync(sessionStoreFile, '{invalid\n', { mode: 0o600 })
    await expect(startTestServer(testConfig(credentials, { sessionStoreFile }))).rejects.toThrow(/not valid JSON/u)
    expect(readFileSync(sessionStoreFile, 'utf8')).toBe('{invalid\n')

    if (process.platform !== 'win32') {
      const exposedStoreFile = join(root, 'exposed.json')
      writeFileSync(exposedStoreFile, '{}\n', { mode: 0o600 })
      chmodSync(exposedStoreFile, 0o644)
      await expect(startTestServer(testConfig(credentials, {
        sessionStoreFile: exposedStoreFile,
      }))).rejects.toThrow(/permissions/u)
    }
  }, 30_000)

  it('revokes persisted sessions when the signing secret changes', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-session-rotation-'))
    roots.push(root)
    const sessionStoreFile = join(root, 'sessions.json')
    const initial = await startTestServer(testConfig(credentials, { sessionStoreFile }))
    const loggedIn = await login(initial.baseUrl, credentials)
    initial.server.close()
    await once(initial.server, 'close')

    const rotated = await startTestServer(testConfig({
      ...credentials,
      secret: `${credentials.secret}-rotated-secret-material`,
    }, { sessionStoreFile }))
    expect((await fetch(`${rotated.baseUrl}/auth/verify`, { headers: { cookie: loggedIn.cookie } })).status).toBe(401)
    rotated.server.close()
    await once(rotated.server, 'close')
  }, 30_000)
})
