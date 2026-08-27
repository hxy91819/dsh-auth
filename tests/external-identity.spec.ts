import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaihuAccessTokenProvider } from '../src/external-identity.js'
import { startTestServer, testConfig, testCredentials } from './helpers.js'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(() => vi.unstubAllGlobals())

describe('TaihuAccessTokenProvider', () => {
  it('builds a passport authorization URL without exposing the API token', () => {
    const provider = new TaihuAccessTokenProvider({
      paasId: 'paas-demo',
      token: 'secret-token',
      baseUrl: 'https://api.woa.com',
    })
    const url = new URL(provider.authorizationUrl({
      state: 'state-value',
      nonce: 'nonce-value',
      redirectUri: 'https://lightpilot.woa.com/auth/callback',
    }))
    expect(url.hostname).toBe('passport.woa.com')
    expect(url.searchParams.get('appkey')).toBe('paas-demo')
    expect(url.searchParams.get('state')).toBe('state-value')
    expect(url.toString()).not.toContain('secret-token')
  })

  it('signs the Taihu exchange and normalizes the returned identity', async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(inputUrl)
      expect(url.pathname).toBe('/ebus/tof4/api/v1/passport/AccessToken')
      expect(url.searchParams.get('code')).toBe('one-time-code')
      const headers = new Headers(init?.headers)
      expect(headers.get('x-rio-paasid')).toBe('paas-demo')
      expect(headers.get('x-rio-nonce')).toMatch(/^\d{6}$/u)
      expect(headers.get('x-rio-timestamp')).toMatch(/^\d+$/u)
      expect(headers.get('x-rio-signature')).toMatch(/^[A-F0-9]{64}$/u)
      return Promise.resolve(new Response(JSON.stringify({
        Ret: 0,
        Data: {
          LoginName: 'masonxhuang@tencent.com',
          ChineseName: 'Mason',
          DeptId: 123,
          DeptName: 'TEG/Platform',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    })
    const provider = new TaihuAccessTokenProvider({
      paasId: 'paas-demo',
      token: 'secret-token',
      baseUrl: 'https://api.woa.com',
    }, fetcher)
    await expect(provider.exchangeCode({ code: 'one-time-code', redirectUri: 'https://lightpilot.woa.com/auth/callback' })).resolves.toEqual({
      subject: 'masonxhuang',
      username: 'masonxhuang',
      displayName: 'Mason',
      departmentId: '123',
      departmentName: 'TEG/Platform',
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('completes the callback into a session only for an allowed user', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-external-http-'))
    const tokenFile = join(root, 'taihu-token')
    writeFileSync(tokenFile, 'taihu-secret\n', { mode: 0o600 })
    chmodSync(tokenFile, 0o600)
    const config = testConfig(credentials, {
      secureCookies: false,
      externalIdentity: {
        enabled: true,
        paasId: 'paas-demo',
        tokenFile,
        callbackUrl: 'http://127.0.0.1/auth/callback',
        allowedUsers: ['masonxhuang'],
      },
    })
    const httpFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({
      Ret: 0,
      Data: { LoginName: 'masonxhuang@tencent.com', ChineseName: 'Mason' },
    }), { status: 200 }))))
    const server = await startTestServer(config)
    try {
      const start = await httpFetch(`${server.baseUrl}/auth/login?provider=ioa`, { redirect: 'manual' })
      expect(start.status).toBe(303)
      const authUrl = new URL(start.headers.get('location') ?? '')
      const callback = await httpFetch(`${server.baseUrl}/auth/callback?code=one-time&state=${encodeURIComponent(authUrl.searchParams.get('state') ?? '')}`, { redirect: 'manual' })
      expect(callback.status).toBe(303)
      expect(callback.headers.get('set-cookie')).toContain('dsh_auth_session=')
    } finally {
      await new Promise<void>((resolve, reject) => server.server.close(error => error === undefined ? resolve() : reject(error)))
    }
  })
})
