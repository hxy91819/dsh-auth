import { once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/cookies.js'
import { authStateSecretId, createAuthStateDocument, loadAuthState } from '../src/auth-state.js'
import { SessionStore } from '../src/session.js'
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

describe('unified administrator authentication state', () => {
  it('uses fixed administrator identity and updates existing token sessions after one atomic initialization', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-state-initialize-'))
    roots.push(root)
    const authStateFile = join(root, 'auth-state.json')
    const sessionSecretFile = join(root, 'session-secret')
    writeFileSync(sessionSecretFile, `${credentials.secret}\n`, { mode: 0o600 })
    writeFileSync(authStateFile, `${JSON.stringify(createAuthStateDocument(authStateSecretId(Buffer.from(credentials.secret))))}\n`, { mode: 0o600 })
    const config = testConfig(credentials, { authStateFile, sessionSecretFile })
    const store = new SessionStore(config)
    const current = store.create(Date.now(), 'login-token')
    const stale = store.create(Date.now() + 1, 'login-token')
    expect(current.session.user).toEqual({ userId: 'admin', username: 'admin', roles: ['admin'] })

    expect(store.initializeAdministrator(current.session.token, 'Configured Admin', credentials.hash, Date.now() + 2))
      .toBe('initialized')
    expect(store.initializeAdministrator(current.session.token, 'Attacker', credentials.hash, Date.now() + 3))
      .toBe('already-configured')
    expect(store.passwordCredentials()?.username).toBe('Configured Admin')

    const request = (value: string): IncomingMessage => ({
      headers: { cookie: `${SESSION_COOKIE}=${value}` },
    }) as IncomingMessage
    expect(store.authenticate(request(current.cookieValue), Date.now() + 4)?.session.user).toEqual({
      userId: 'admin', username: 'Configured Admin', roles: ['admin'],
    })
    expect(store.authenticate(request(stale.cookieValue), Date.now() + 4)).toBeUndefined()

    const restarted = new SessionStore(config)
    expect(restarted.authenticate(request(current.cookieValue), Date.now() + 5)?.session.user.username)
      .toBe('Configured Admin')
    const saved = JSON.parse(readFileSync(authStateFile, 'utf8')) as {
      schemaVersion: number
      accounts: { id: string; username: string }[]
      sessions: { authenticationMethod: string }[]
    }
    expect(saved).toMatchObject({
      schemaVersion: 3,
      accounts: [{ id: 'admin', username: 'Configured Admin' }],
      sessions: [{ authenticationMethod: 'login-token' }],
    })
  }, 30_000)

  it('replaces the password hash, keeps the current session, and revokes others', async () => {
    const credentials = await testCredentials()
    const replacement = await testCredentials()
    const unconfiguredRoot = mkdtempSync(join(tmpdir(), 'dsh-auth-state-password-unset-'))
    roots.push(unconfiguredRoot)
    const unconfiguredState = join(unconfiguredRoot, 'auth-state.json')
    const unconfiguredSecret = join(unconfiguredRoot, 'session-secret')
    writeFileSync(unconfiguredSecret, `${credentials.secret}\n`, { mode: 0o600 })
    writeFileSync(unconfiguredState, `${JSON.stringify(createAuthStateDocument(authStateSecretId(Buffer.from(credentials.secret))))}\n`, { mode: 0o600 })
    const unset = new SessionStore(testConfig(credentials, { authStateFile: unconfiguredState, sessionSecretFile: unconfiguredSecret }))
    const bootstrap = unset.create(Date.now(), 'login-token')
    expect(unset.updateAdministratorPassword(bootstrap.session.token, replacement.hash, Date.now() + 1))
      .toBe('not-configured')

    const store = new SessionStore(testConfig(credentials))
    const current = store.create(Date.now())
    const extra = store.create(Date.now() + 1)
    expect(store.updateAdministratorPassword('missing-token-value-00000000000000000000000', replacement.hash, Date.now() + 2))
      .toBe('invalid-session')
    expect(store.updateAdministratorPassword(current.session.token, replacement.hash, Date.now() + 3)).toBe('updated')
    expect(store.passwordCredentials()?.passwordHash).toBe(replacement.hash)

    const request = (value: string): IncomingMessage => ({
      headers: { cookie: `${SESSION_COOKIE}=${value}` },
    }) as IncomingMessage
    expect(store.authenticate(request(current.cookieValue), Date.now() + 4)).toBeDefined()
    expect(store.authenticate(request(extra.cookieValue), Date.now() + 4)).toBeUndefined()
  }, 30_000)

  it('rolls memory back when an authentication state write fails', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-state-write-failure-'))
    roots.push(root)
    const stateDirectory = join(root, 'state')
    mkdirSync(stateDirectory)
    const authStateFile = join(stateDirectory, 'auth-state.json')
    const store = new SessionStore(testConfig(credentials, { authStateFile }))
    const original = readFileSync(authStateFile, 'utf8')
    rmSync(authStateFile)
    mkdirSync(authStateFile)
    expect(() => store.create(Date.now())).toThrow(/cannot be updated/u)
    rmSync(authStateFile, { recursive: true, force: true })
    writeFileSync(authStateFile, original, { mode: 0o600 })
    store.create(Date.now() + 1)
    const saved = JSON.parse(readFileSync(authStateFile, 'utf8')) as { sessions: unknown[] }
    expect(saved.sessions).toHaveLength(1)
  }, 30_000)
})

describe('persistent session activity', () => {
  it('summarizes per-account browser activity and prunes expired sessions', async () => {
    const credentials = await testCredentials()
    const config = testConfig(credentials, {
      sessionTtlSeconds: 60,
      idleTtlSeconds: 60,
      sessionRenewalSeconds: 60,
    })
    const store = new SessionStore(config)

    expect(store.setTrustedTeamPreview(true)).toBe('updated')
    const member = store.createMemberAccount('teammate', credentials.hash, 1_000)
    expect(member.result).toBe('created')
    const memberId = member.account?.id
    if (memberId === undefined) throw new Error('member account was not created')
    const adminSession = store.create(1_000, 'password', 'admin')
    const memberSession = store.create(2_000, 'password', memberId)

    expect(store.listAccountActivity(3_000)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'admin',
        activeSessions: 1,
        lastSeenAt: 1_000,
      }),
      expect.objectContaining({
        id: memberId,
        username: 'teammate',
        activeSessions: 1,
        lastSeenAt: 2_000,
      }),
    ]))
    expect(store.recordSessionActivity('session-1', memberSession.session, 3_000, 'prompt')).toMatchObject({
      sessionId: 'session-1',
      participants: [
        expect.objectContaining({ id: memberId, username: 'teammate', promptCount: 1, current: true }),
      ],
    })
    expect(store.recordSessionActivity('session-1', adminSession.session, 4_000, 'view')).toMatchObject({
      sessionId: 'session-1',
      participants: [
        expect.objectContaining({ id: 'admin', promptCount: 0, current: true }),
        expect.objectContaining({ id: memberId, promptCount: 1, current: false }),
      ],
    })
    expect(store.sessionCollaboration('session-1', memberId)).toMatchObject({
      participants: [
        expect.objectContaining({ id: 'admin', current: false }),
        expect.objectContaining({ id: memberId, current: true }),
      ],
    })
    const restarted = new SessionStore(config)
    expect(restarted.sessionCollaboration('session-1', memberId)).toMatchObject({
      sessionId: 'session-1',
      participants: [
        expect.objectContaining({ id: 'admin', username: 'test-account', promptCount: 0 }),
        expect.objectContaining({ id: memberId, username: 'teammate', promptCount: 1 }),
      ],
    })
    expect(store.listAccountActivity(70_000)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'admin', activeSessions: 0, lastSeenAt: null }),
      expect.objectContaining({ id: memberId, activeSessions: 0, lastSeenAt: null }),
    ]))
  }, 30_000)
})

describe('persistent renewable sessions', () => {
  it('survives an application restart, renews after activity, and persists logout revocation', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-session-'))
    roots.push(root)
    const authStateFile = join(root, 'sessions.json')
    let now = Date.UTC(2026, 0, 1)
    const config = testConfig(credentials, {
      authStateFile,
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
    expect(statSync(authStateFile).mode & 0o777).toBe(0o600)

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
    const authStateFile = join(root, 'sessions.json')
    writeFileSync(authStateFile, '{invalid\n', { mode: 0o600 })
    await expect(startTestServer(testConfig(credentials, { authStateFile }))).rejects.toThrow(/not valid JSON/u)
    expect(readFileSync(authStateFile, 'utf8')).toBe('{invalid\n')

    const legacyStateFile = join(root, 'legacy.json')
    writeFileSync(legacyStateFile, '{"version":1,"sessions":[]}\n', { mode: 0o600 })
    await expect(startTestServer(testConfig(credentials, {
      authStateFile: legacyStateFile,
    }))).rejects.toThrow(/unsupported schemaVersion/u)

    const linkedStateFile = join(root, 'state-link.json')
    symlinkSync(legacyStateFile, linkedStateFile)
    expect(() => testConfig(credentials, {
      authStateFile: linkedStateFile,
    })).toThrow(/regular file/u)
    const secretId = authStateSecretId(Buffer.from(credentials.secret))
    expect(() => loadAuthState(linkedStateFile, secretId)).toThrow(/regular file/u)

    const duplicateStateFile = join(root, 'duplicate.json')
    const duplicateSession = {
      token: 'a'.repeat(43),
      accountId: 'admin',
      accountAuthVersion: 1,
      authenticationMethod: 'password',
      createdAt: 1,
      lastSeenAt: 1,
      expiresAt: 2,
    }
    writeFileSync(duplicateStateFile, `${JSON.stringify({
      schemaVersion: 3,
      secretId: 'b'.repeat(43),
      accountMode: 'single',
      accounts: [{
        id: 'admin',
        username: 'test-account',
        passwordHash: credentials.hash,
        role: 'admin',
        status: 'active',
        authVersion: 1,
        createdAt: 1,
        configuredAt: 1,
      }],
      sessions: [duplicateSession, duplicateSession],
    })}\n`, { mode: 0o600 })
    await expect(startTestServer(testConfig(credentials, {
      authStateFile: duplicateStateFile,
    }))).rejects.toThrow(/duplicate session/u)

    if (process.platform !== 'win32') {
      const exposedStoreFile = join(root, 'exposed.json')
      writeFileSync(exposedStoreFile, '{}\n', { mode: 0o600 })
      chmodSync(exposedStoreFile, 0o644)
      expect(() => testConfig(credentials, {
        authStateFile: exposedStoreFile,
      })).toThrow(/permissions/u)

      chmodSync(exposedStoreFile, 0o400)
      expect(() => testConfig(credentials, {
        authStateFile: exposedStoreFile,
      })).toThrow(/permissions/u)
    }
  }, 30_000)

  it('revokes persisted sessions when the signing secret changes', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-session-rotation-'))
    roots.push(root)
    const authStateFile = join(root, 'sessions.json')
    const initial = await startTestServer(testConfig(credentials, { authStateFile }))
    const loggedIn = await login(initial.baseUrl, credentials)
    initial.server.close()
    await once(initial.server, 'close')

    const replacement = await testCredentials()
    const rotated = await startTestServer(testConfig({
      ...replacement,
      secret: `${credentials.secret}-rotated-secret-material`,
    }, { authStateFile }))
    expect((await fetch(`${rotated.baseUrl}/auth/verify`, { headers: { cookie: loggedIn.cookie } })).status).toBe(401)
    const originalLogin = await login(rotated.baseUrl, credentials)
    expect((await fetch(`${rotated.baseUrl}/auth/verify`, { headers: { cookie: originalLogin.cookie } })).status).toBe(204)
    rotated.server.close()
    await once(rotated.server, 'close')
  }, 30_000)

  it('keeps only the configured session capacity across restarts', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-session-capacity-'))
    roots.push(root)
    const authStateFile = join(root, 'sessions.json')
    const config = testConfig(credentials, { authStateFile, maxSessions: 1 })
    const initial = await startTestServer(config)
    const first = await login(initial.baseUrl, credentials)
    const second = await login(initial.baseUrl, credentials)

    expect((await fetch(`${initial.baseUrl}/auth/verify`, { headers: { cookie: first.cookie } })).status).toBe(401)
    expect((await fetch(`${initial.baseUrl}/auth/verify`, { headers: { cookie: second.cookie } })).status).toBe(204)
    initial.server.close()
    await once(initial.server, 'close')

    const restarted = await startTestServer(config)
    expect((await fetch(`${restarted.baseUrl}/auth/verify`, { headers: { cookie: first.cookie } })).status).toBe(401)
    expect((await fetch(`${restarted.baseUrl}/auth/verify`, { headers: { cookie: second.cookie } })).status).toBe(204)
    restarted.server.close()
    await once(restarted.server, 'close')
  }, 30_000)

})
