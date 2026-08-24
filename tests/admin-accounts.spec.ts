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
import type { AuthEventLogger, AuthLogRecord } from '../src/logging.js'

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

interface CapturedRecord {
  readonly level: 'error' | 'info' | 'warn'
  readonly record: AuthLogRecord
}

async function harness(): Promise<{
  readonly baseUrl: string
  readonly credentials: TestCredentials
  readonly captured: CapturedRecord[]
}> {
  const credentials = await testCredentials()
  const captured: CapturedRecord[] = []
  const logger: AuthEventLogger = {
    info: record => { captured.push({ level: 'info', record }) },
    warn: record => { captured.push({ level: 'warn', record }) },
    error: record => { captured.push({ level: 'error', record }) },
  }
  const server = await startTestServer(testConfig(credentials), undefined, undefined, undefined, logger)
  servers.push(server.server)
  return { baseUrl: server.baseUrl, credentials, captured }
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

async function csrf(baseUrl: string, session: string): Promise<{
  readonly csrfToken: string
  readonly csrfCookie: string
}> {
  const response = await fetch(`${baseUrl}/auth/csrf`, { headers: { cookie: session } })
  expect(response.status).toBe(200)
  const body = await response.json() as { csrf: string }
  return { csrfToken: body.csrf, csrfCookie: cookiePair(response.headers, CSRF_COOKIE) }
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
    const body = await session.json() as {
      user: { userId: string; roles: string[] }
      trustedTeamPreview: boolean
      team: {
        accounts: {
          username: string
          role: string
          status: string
          activeSessions: number
          lastSeenAt: string | null
          current: boolean
        }[]
      }
    }
    expect(body).toMatchObject({
      user: { roles: ['member'] },
      trustedTeamPreview: true,
    })
    expect(body.user.userId).toMatch(/^acct_/u)
    expect(body.team.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        username: 'test-account',
        role: 'admin',
        status: 'active',
        activeSessions: 1,
        current: false,
      }),
      expect.objectContaining({
        username: 'teammate',
        role: 'member',
        status: 'active',
        activeSessions: 1,
        current: true,
      }),
    ]))
    expect(body.team.accounts.find(account => account.username === 'teammate')?.lastSeenAt).toMatch(/T/u)

    const memberCsrf = await csrf(app.baseUrl, member)
    const memberActivity = await fetch(`${app.baseUrl}/auth/collaboration/session`, {
      method: 'POST',
      headers: { ...proxyHeaders(), cookie: `${member}; ${memberCsrf.csrfCookie}` },
      body: new URLSearchParams({
        csrf: memberCsrf.csrfToken,
        sessionId: 'harness-session-1',
        activity: 'prompt',
      }),
    })
    expect(memberActivity.status).toBe(200)
    await expect(memberActivity.json()).resolves.toMatchObject({
      recorded: true,
      collaboration: {
        sessionId: 'harness-session-1',
        participants: [
          expect.objectContaining({ username: 'teammate', promptCount: 1, current: true }),
        ],
      },
    })

    const adminView = await fetch(`${app.baseUrl}/auth/session?sessionId=harness-session-1`, {
      headers: { cookie: admin },
    })
    expect(adminView.status).toBe(200)
    await expect(adminView.json()).resolves.toMatchObject({
      collaboration: {
        sessionId: 'harness-session-1',
        participants: [
          expect.objectContaining({ username: 'teammate', promptCount: 1, current: false }),
        ],
      },
    })

    const adminCsrf = await csrf(app.baseUrl, admin)
    const adminActivity = await fetch(`${app.baseUrl}/auth/collaboration/session`, {
      method: 'POST',
      headers: { ...proxyHeaders(), cookie: `${admin}; ${adminCsrf.csrfCookie}` },
      body: new URLSearchParams({
        csrf: adminCsrf.csrfToken,
        sessionId: 'harness-session-1',
        activity: 'view',
      }),
    })
    expect(adminActivity.status).toBe(200)
    await expect(adminActivity.json()).resolves.toMatchObject({
      collaboration: {
        participants: [
          expect.objectContaining({ username: 'test-account', promptCount: 0, current: true }),
          expect.objectContaining({ username: 'teammate', promptCount: 1, current: false }),
        ],
      },
    })

    const verified = await fetch(`${app.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: member } })
    expect(verified.status).toBe(204)
    expect(verified.headers.get('x-dsh-auth-user-id')).toBe(body.user.userId)
    expect(verified.headers.get('x-dsh-auth-roles')).toBe('member')

    const account = await fetch(`${app.baseUrl}/auth/account`, { headers: { cookie: member } })
    const accountHtml = await account.text()
    expect(accountHtml).toContain('Trusted team preview is enabled')
    expect(accountHtml).toContain('Team activity')
    expect(accountHtml).toContain('Current account')
    expect(accountHtml).toContain('Active sessions: 1')
    expect(accountHtml).not.toContain('Manage team accounts')

    const forbidden = await fetch(`${app.baseUrl}/auth/admin/accounts`, {
      redirect: 'manual',
      headers: { ...proxyHeaders(), cookie: member },
    })
    expect(forbidden.status).toBe(403)

    const adminStillValid = await fetch(`${app.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: admin } })
    expect(adminStillValid.status).toBe(204)

    const disablePage = await adminAccountsPage(app.baseUrl, admin)
    expect(disablePage.html).toContain('test-account')
    expect(disablePage.html).toContain('teammate')
    expect(disablePage.html).toContain('Active sessions: 1')
    const disabled = await postAdminAccounts(app.baseUrl, admin, disablePage.csrfCookie, disablePage.html, {
      action: 'disable-member',
      accountId: body.user.userId,
    })
    expect(disabled.status).toBe(200)
    const disabledHtml = await disabled.text()
    expect(disabledHtml).toContain('Member account disabled')
    expect(disabledHtml).toContain('Disabled')
    expect(disabledHtml).toContain('Active sessions: 0')
    expect((await fetch(`${app.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: member } })).status).toBe(401)
    expect((await fetch(`${app.baseUrl}/auth/verify`, { headers: { ...proxyHeaders(), cookie: admin } })).status).toBe(204)

    expect(app.captured.some(entry => entry.level === 'info'
      && entry.record.event === 'auth.account-mode.updated'
      && entry.record.mode === 'trusted-team-preview'
      && entry.record.changed === true)).toBe(true)
    expect(app.captured.some(entry => entry.level === 'info'
      && entry.record.event === 'auth.member-account.created'
      && entry.record.targetAccountId === body.user.userId)).toBe(true)
    expect(app.captured.some(entry => entry.level === 'info'
      && entry.record.event === 'auth.member-account.disabled'
      && entry.record.targetAccountId === body.user.userId)).toBe(true)
    expect(JSON.stringify(app.captured)).not.toContain(memberPassword)
  }, 30_000)
})
