import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/cookies.js'
import {
  cookiePair,
  hiddenValue,
  proxyHeaders,
  startTestServer,
  testConfig,
  testCredentials,
  type TestCredentials,
} from './helpers.js'

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function harness(): Promise<{ readonly baseUrl: string; readonly credentials: TestCredentials }> {
  const credentials = await testCredentials()
  const server = await startTestServer(testConfig(credentials))
  servers.push(server.server)
  return { baseUrl: server.baseUrl, credentials }
}

async function login(baseUrl: string, username: string, password: string): Promise<string> {
  const page = await fetch(`${baseUrl}/auth/login`, { headers: proxyHeaders() })
  const accepted = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...proxyHeaders(), cookie: cookiePair(page.headers, CSRF_COOKIE) },
    body: new URLSearchParams({
      csrf: hiddenValue(await page.text(), 'csrf'),
      returnTo: '/',
      username,
      password,
    }),
  })
  expect(accepted.status).toBe(303)
  return cookiePair(accepted.headers, SESSION_COOKIE)
}

async function adminAccountsPage(baseUrl: string, session: string): Promise<{
  readonly html: string
  readonly csrfCookie: string
}> {
  const page = await fetch(`${baseUrl}/auth/admin/accounts`, {
    headers: { ...proxyHeaders(), cookie: session },
  })
  expect(page.status).toBe(200)
  const html = await page.text()
  return { html, csrfCookie: cookiePair(page.headers, CSRF_COOKIE) }
}

function postAdminAccounts(
  baseUrl: string,
  session: string,
  csrfCookie: string,
  html: string,
  values: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}/auth/admin/accounts`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...proxyHeaders(), cookie: `${session}; ${csrfCookie}` },
    body: new URLSearchParams({ csrf: hiddenValue(html, 'csrf'), ...values }),
  })
}

describe('trusted team account preview', () => {
  it('lets an administrator create and revoke a member without pretending session isolation', async () => {
    const app = await harness()
    const admin = await login(app.baseUrl, 'test-account', app.credentials.password)

    const closed = await adminAccountsPage(app.baseUrl, admin)
    expect(closed.html).toContain('Trusted team preview')
    const enabled = await postAdminAccounts(app.baseUrl, admin, closed.csrfCookie, closed.html, {
      action: 'enable-preview',
      ack: 'trusted-team-preview',
    })
    expect(enabled.status).toBe(200)
    expect(await enabled.text()).toContain('Trusted team preview is enabled')

    const memberPassword = `${app.credentials.password}-member`
    const createPage = await adminAccountsPage(app.baseUrl, admin)
    const created = await postAdminAccounts(app.baseUrl, admin, createPage.csrfCookie, createPage.html, {
      action: 'create-member',
      username: 'teammate',
      password: memberPassword,
      confirmPassword: memberPassword,
    })
    expect(created.status).toBe(200)
    expect(await created.text()).toContain('Member account created')

    const member = await login(app.baseUrl, 'teammate', memberPassword)
    const session = await fetch(`${app.baseUrl}/auth/session`, { headers: { cookie: member } })
    const body = await session.json() as { user: { userId: string; roles: string[] }; trustedTeamPreview: boolean }
    expect(body).toMatchObject({
      user: { roles: ['member'] },
      trustedTeamPreview: true,
    })
    expect(body.user.userId).toMatch(/^acct_/u)

    const verified = await fetch(`${app.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: member } })
    expect(verified.status).toBe(204)
    expect(verified.headers.get('x-dsh-auth-user-id')).toBe(body.user.userId)
    expect(verified.headers.get('x-dsh-auth-roles')).toBe('member')

    const account = await fetch(`${app.baseUrl}/auth/account`, { headers: { cookie: member } })
    const accountHtml = await account.text()
    expect(accountHtml).toContain('Trusted team preview is enabled')
    expect(accountHtml).not.toContain('Manage team accounts')

    const forbidden = await fetch(`${app.baseUrl}/auth/admin/accounts`, {
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: member },
    })
    expect(forbidden.status).toBe(403)

    const adminStillValid = await fetch(`${app.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: admin } })
    expect(adminStillValid.status).toBe(204)

    const disablePage = await adminAccountsPage(app.baseUrl, admin)
    const disabled = await postAdminAccounts(app.baseUrl, admin, disablePage.csrfCookie, disablePage.html, {
      action: 'disable-member',
      accountId: body.user.userId,
    })
    expect(disabled.status).toBe(200)
    expect(await disabled.text()).toContain('Member account disabled')
    expect((await fetch(`${app.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: member } })).status).toBe(401)
    expect((await fetch(`${app.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: admin } })).status).toBe(204)
  }, 30_000)
})
