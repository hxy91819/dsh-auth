import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuthEventLogger } from '../src/logging.js'
import type { AuthEventLogger, AuthLogRecord } from '../src/logging.js'
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/cookies.js'
import {
  cookiePair,
  hiddenValue,
  proxyHeaders,
  startTestServer,
  testConfig,
  testCredentials,
  type TestCredentials,
  type TestServer,
} from './helpers.js'

interface CapturedRecord {
  readonly level: 'error' | 'info' | 'warn'
  readonly record: AuthLogRecord
}

let credentials: TestCredentials
let running: TestServer
const captured: CapturedRecord[] = []

const logger: AuthEventLogger = {
  info: record => { captured.push({ level: 'info', record }) },
  warn: record => { captured.push({ level: 'warn', record }) },
  error: record => { captured.push({ level: 'error', record }) },
}

beforeAll(async () => {
  credentials = await testCredentials()
  running = await startTestServer(testConfig(credentials), undefined, undefined, undefined, logger)
}, 30_000)

afterAll(async () => {
  running.server.close()
  await once(running.server, 'close')
})

describe('runtime authentication logs', () => {
  it('falls back to JSON stderr only when Harness has no persistent exporter', () => {
    const hostRecords: AuthLogRecord[] = []
    const lines: string[] = []
    let external = false
    const fallback = createAuthEventLogger({
      info: record => { hostRecords.push(record) },
      warn: record => { hostRecords.push(record) },
      error: record => { hostRecords.push(record) },
    }, () => external, line => { lines.push(line) })

    fallback.warn({ event: 'auth.login.failed', reason: 'invalid_credentials' })
    external = true
    fallback.info({ event: 'auth.login.succeeded', authMethod: 'password' })

    expect(hostRecords).toHaveLength(2)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      level: 'warn', logger: 'dsh-auth', event: 'auth.login.failed', reason: 'invalid_credentials',
    })
  })

  it('bounds diagnostic events while preserving informational state changes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T00:00:00Z'))
    try {
      const records: CapturedRecord[] = []
      const budgeted = createAuthEventLogger({
        info: record => { records.push({ level: 'info', record }) },
        warn: record => { records.push({ level: 'warn', record }) },
        error: record => { records.push({ level: 'error', record }) },
      }, () => true, () => undefined)

      for (let index = 0; index < 61; index += 1) budgeted.warn({ event: 'auth.login.failed' })
      budgeted.error({ event: 'auth.request.error' })
      budgeted.info({ event: 'auth.login.succeeded' })

      expect(records.filter(entry => entry.level === 'warn')).toHaveLength(60)
      expect(records.some(entry => entry.record.event === 'auth.request.error')).toBe(false)
      expect(records.some(entry => entry.record.event === 'auth.login.succeeded')).toBe(true)

      vi.advanceTimersByTime(60_000)
      budgeted.info({ event: 'auth.runtime.ready' })
      budgeted.error({ event: 'auth.request.error' })

      expect(records.find(entry => entry.record.event === 'auth.logging.suppressed')?.record).toEqual({
        event: 'auth.logging.suppressed', count: 2, maxEvents: 60, windowSeconds: 60,
      })
      expect(records.at(-1)).toEqual({ level: 'error', record: { event: 'auth.request.error' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('records useful outcomes without retaining submitted secrets or network addresses', async () => {
    const page = await fetch(`${running.baseUrl}/auth/login`)
    const pageHtml = await page.text()
    const csrfCookie = cookiePair(page.headers, CSRF_COOKIE)
    const csrf = hiddenValue(pageHtml, 'csrf')
    const sensitiveUsername = 'submitted-user-must-not-be-logged'
    const sensitivePassword = 'submitted-password-must-not-be-logged'

    const denied = await fetch(`${running.baseUrl}/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders('192.0.2.44'), cookie: csrfCookie },
      body: new URLSearchParams({ csrf, username: sensitiveUsername, password: sensitivePassword }),
    })
    expect(denied.status).toBe(401)

    const freshPage = await fetch(`${running.baseUrl}/auth/login`)
    const freshHtml = await freshPage.text()
    const accepted = await fetch(`${running.baseUrl}/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders('192.0.2.44'), cookie: cookiePair(freshPage.headers, CSRF_COOKIE) },
      body: new URLSearchParams({
        csrf: hiddenValue(freshHtml, 'csrf'),
        username: 'test-account',
        password: credentials.password,
      }),
    })
    expect(accepted.status).toBe(303)
    const sessionCookie = cookiePair(accepted.headers, SESSION_COOKIE)

    const csrfResponse = await fetch(`${running.baseUrl}/auth/csrf`, { headers: { cookie: sessionCookie } })
    const logoutCsrf = (await csrfResponse.json() as { csrf: string }).csrf
    const logout = await fetch(`${running.baseUrl}/auth/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...proxyHeaders('192.0.2.44'),
        cookie: `${sessionCookie}; ${cookiePair(csrfResponse.headers, CSRF_COOKIE)}`,
      },
      body: new URLSearchParams({ csrf: logoutCsrf }),
    })
    expect(logout.status).toBe(303)

    expect(captured.some(entry => entry.level === 'warn'
      && entry.record.event === 'auth.login.failed'
      && entry.record.authMethod === 'password'
      && entry.record.reason === 'invalid_credentials')).toBe(true)
    expect(captured.some(entry => entry.level === 'info'
      && entry.record.event === 'auth.login.succeeded'
      && entry.record.authMethod === 'password')).toBe(true)
    expect(captured.some(entry => entry.level === 'info'
      && entry.record.event === 'auth.logout.succeeded')).toBe(true)
    const clientIds = captured.map(entry => entry.record.clientId).filter(value => value !== undefined)
    expect(clientIds).not.toHaveLength(0)
    expect(new Set(clientIds).size).toBe(1)
    expect(clientIds[0]).toMatch(/^[a-f0-9]{16}$/u)

    const serialized = JSON.stringify(captured)
    for (const sensitive of [
      sensitiveUsername, sensitivePassword, credentials.password, csrf, logoutCsrf,
      sessionCookie, '192.0.2.44', '/auth/login',
    ]) expect(serialized).not.toContain(sensitive)
  }, 30_000)

  it('records fixed denial context without logging request URLs', async () => {
    const denied = await fetch(`${running.baseUrl}/auth/login?returnTo=%2Fprivate%3Fsecret%3Dvalue`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...proxyHeaders('192.0.2.45'), origin: 'https://attacker.invalid' },
      body: new URLSearchParams({ password: 'hidden-request-value' }),
    })
    expect(denied.status).toBe(403)
    expect(captured.some(entry => entry.level === 'warn'
      && entry.record.event === 'auth.request.denied'
      && entry.record.route === '/login'
      && entry.record.method === 'POST'
      && entry.record.status === 403
      && entry.record.reason === 'origin_denied')).toBe(true)
    expect(JSON.stringify(captured)).not.toMatch(/private|secret=value|hidden-request-value|192\.0\.2\.45/u)
  })
})
