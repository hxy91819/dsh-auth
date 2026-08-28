import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompactEncrypt } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestServer, testConfig, testCredentials, cookiePair } from './helpers.js'

afterEach(() => vi.restoreAllMocks())

const token = 'gateway-test-token-0123456789abc'
const now = Date.parse('2026-08-27T12:00:00.000Z')

function signature(timestamp: string, sequence: string): string {
  return createHash('sha256').update(`${timestamp}${token}${sequence},,,${timestamp}`, 'utf8').digest('hex').toUpperCase()
}

async function identityHeader(loginName = 'masonxhuang@tencent.com', expiration = '2026-08-27T13:00:00.000Z'): Promise<string> {
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify({
    LoginName: loginName,
    ChineseName: 'Mason',
    Expiration: expiration,
  }))).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(new TextEncoder().encode(token))
}

async function gatewayServer() {
  const credentials = await testCredentials()
  const root = mkdtempSync(join(tmpdir(), 'dsh-auth-gateway-http-'))
  const tokenFile = join(root, 'gateway-token')
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
  chmodSync(tokenFile, 0o600)
  const config = testConfig(credentials, {
    secureCookies: false,
    externalIdentity: {
      enabled: true,
      paasId: 'gateway-test',
      tokenFile,
      callbackUrl: 'http://127.0.0.1/auth/callback',
      allowedUsers: ['masonxhuang'],
    },
    gatewayIdentity: { enabled: true, tokenFile, safeMode: true, allowedUsers: ['masonxhuang'] },
  })
  const server = await startTestServer(config, () => now)
  return { server, tokenFile }
}

describe('TOF gateway identity behavior', () => {
  it('creates a session from a valid signed JWE and hides the OAuth fallback link', async () => {
    const { server } = await gatewayServer()
    try {
      const login = await fetch(`${server.baseUrl}/auth/login`)
      expect(await login.text()).not.toContain('/auth/login/ioa')

      const timestamp = String(Math.floor(now / 1000))
      const sequence = 'sequence-1'
      const verify = await fetch(`${server.baseUrl}/auth/verify`, {
        headers: {
          timestamp,
          signature: signature(timestamp, sequence),
          'x-rio-seq': sequence,
          'x-tai-identity': await identityHeader(),
        },
      })
      expect(verify.status).toBe(204)
      const session = cookiePair(verify.headers, 'dsh_auth_session')
      await expect(fetch(`${server.baseUrl}/auth/session`, { headers: { cookie: session } }).then(response => response.json())).resolves.toMatchObject({
        authenticated: true,
        user: { username: 'masonxhuang' },
      })
    } finally {
      server.server.close()
    }
  })

  it.each([
    ['missing gateway headers', {}],
    ['forged signature', { timestamp: String(Math.floor(now / 1000)), signature: 'FORGED', 'x-rio-seq': 'sequence-2' }],
    ['expired timestamp', { timestamp: String(Math.floor(now / 1000) - 181), signature: signature(String(Math.floor(now / 1000) - 181), 'sequence-3'), 'x-rio-seq': 'sequence-3' }],
  ])('does not authenticate with %s', async (_reason, headers) => {
    const { server } = await gatewayServer()
    try {
      const response = await fetch(`${server.baseUrl}/auth/verify`, { headers })
      expect(response.status).toBe(401)
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally {
      server.server.close()
    }
  })

  it('rejects an expired identity assertion even when its gateway signature is valid', async () => {
    const { server } = await gatewayServer()
    try {
      const timestamp = String(Math.floor(now / 1000))
      const sequence = 'sequence-4'
      const response = await fetch(`${server.baseUrl}/auth/verify`, {
        headers: {
          timestamp,
          signature: signature(timestamp, sequence),
          'x-rio-seq': sequence,
          'x-tai-identity': await identityHeader('masonxhuang@tencent.com', '2026-08-27T11:55:00.000Z'),
        },
      })
      expect(response.status).toBe(401)
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally {
      server.server.close()
    }
  })

  it('requires the encrypted assertion in safe mode instead of trusting staffname', async () => {
    const { server } = await gatewayServer()
    try {
      const timestamp = String(Math.floor(now / 1000))
      const sequence = 'sequence-safe-mode-fallback'
      const response = await fetch(`${server.baseUrl}/auth/verify`, {
        headers: {
          timestamp,
          signature: signature(timestamp, sequence),
          'x-rio-seq': sequence,
          staffname: 'masonxhuang',
        },
      })
      expect(response.status).toBe(401)
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally {
      server.server.close()
    }
  })

  it('applies the gateway allowlist when OAuth and gateway policies differ', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-gateway-policy-http-'))
    const tokenFile = join(root, 'gateway-token')
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
    chmodSync(tokenFile, 0o600)
    const config = testConfig(credentials, {
      secureCookies: false,
      externalIdentity: {
        enabled: true,
        paasId: 'oauth-test',
        tokenFile,
        callbackUrl: 'http://127.0.0.1/auth/callback',
        allowedUsers: ['masonxhuang'],
      },
      gatewayIdentity: { enabled: true, tokenFile, safeMode: true, allowedUsers: ['yuehuali'] },
    })
    const server = await startTestServer(config, () => now)
    try {
      const timestamp = String(Math.floor(now / 1000))
      const sequence = 'sequence-gateway-policy'
      const response = await fetch(`${server.baseUrl}/auth/verify`, {
        headers: {
          timestamp,
          signature: signature(timestamp, sequence),
          'x-rio-seq': sequence,
          'x-tai-identity': await identityHeader('yuehuali@tencent.com'),
        },
      })
      expect(response.status).toBe(204)
    } finally {
      server.server.close()
    }
  })
})
