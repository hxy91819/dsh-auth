import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.js'
import { testConfig, testCredentials } from './helpers.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('configuration', () => {
  it('fails before activation when auth state or session secret files are absent', () => {
    expect(Config['~standard'].validate({}).issues?.[0]?.message).toMatch(/authStateFile/u)
    expect(() => resolveConfig({ authStateFile: '/tmp/missing-auth-state.json' })).toThrow(/sessionSecretFile|authStateFile/u)
  })

  it('accepts the managed expected-version marker only for this exact build', async () => {
    const credentials = await testCredentials()
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    const thisBuild = testConfig(credentials, { expectedVersion: version.version })
    expect(thisBuild.basePath).toBe('/auth')
    expect(() => testConfig(credentials, { expectedVersion: '0.0.0-foreign' })).toThrow(/expectedVersion .* does not match this dsh-auth/u)
    expect(() => testConfig(credentials, { expectedVersion: '' })).toThrow(/expectedVersion must be a non-empty string/u)
    expect(testConfig(credentials).basePath).toBe('/auth')
  })

  it('reads bounded absolute secret files and rejects removed identity fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-config-'))
    roots.push(root)
    const secretFile = join(root, 'secret')
    const authStateFile = join(root, 'auth-state.json')
    writeFileSync(secretFile, `${randomBytes(48).toString('base64url')}\n`, { mode: 0o640 })
    writeFileSync(authStateFile, `${JSON.stringify({
      schemaVersion: 2,
      secretId: 'a'.repeat(43),
      administrator: { id: 'admin', username: null, passwordHash: null, configuredAt: null },
      sessions: [],
    })}\n`, { mode: 0o600 })

    const config = resolveConfig({
      authStateFile,
      sessionSecretFile: secretFile,
    })
    expect(config.basePath).toBe('/auth')
    expect(config.authStateFile).toBe(authStateFile)
    expect(config.sessionSecret.length).toBeGreaterThanOrEqual(32)
    expect(config.secureCookies).toBe(true)
    expect(config.loginTokenEnabled).toBe(false)
    expect(() => resolveConfig({
      authStateFile,
      sessionSecretFile: secretFile,
      userId: 'stable-id',
    })).toThrow(/userId/u)
  }, 30_000)

  it('rejects relative files, unknown fields, and invalid lifetimes', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-config-invalid-'))
    roots.push(root)
    const secretFile = join(root, 'secret')
    const authStateFile = join(root, 'auth-state.json')
    writeFileSync(secretFile, `${credentials.secret}\n`, { mode: 0o600 })
    writeFileSync(authStateFile, '{}\n', { mode: 0o600 })
    const base = { authStateFile, sessionSecretFile: secretFile }
    expect(() => resolveConfig({ ...base, sessionSecretFile: 'relative' })).toThrow(/absolute path/u)
    expect(() => resolveConfig({ ...base, passwordHash: credentials.hash })).toThrow(/passwordHash/u)
    expect(() => resolveConfig({ ...base, idleTtlSeconds: 59 })).toThrow(/idleTtlSeconds/u)
    expect(() => resolveConfig({
      ...base,
      sessionTtlSeconds: 60,
      idleTtlSeconds: 60,
      sessionRenewalSeconds: 61,
    })).toThrow(/sessionRenewalSeconds/u)
    expect(resolveConfig({ ...base, secureCookies: false }).secureCookies).toBe(false)
    expect(() => resolveConfig({ ...base, secureCookies: 'false' })).toThrow(/secureCookies/u)
  }, 30_000)

  it('rejects exposed or symbolic-link credential files', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-config-security-'))
    roots.push(root)
    const secretFile = join(root, 'secret')
    const authStateFile = join(root, 'auth-state.json')
    const linkedSecretFile = join(root, 'secret-link')
    writeFileSync(authStateFile, '{}\n', { mode: 0o600 })
    writeFileSync(secretFile, `${credentials.secret}\n`, { mode: 0o600 })
    symlinkSync(secretFile, linkedSecretFile)

    chmodSync(secretFile, 0o644)
    expect(() => resolveConfig({
      authStateFile, sessionSecretFile: secretFile,
    })).toThrow(/any access by others/u)

    chmodSync(secretFile, 0o600)
    expect(() => resolveConfig({
      authStateFile, sessionSecretFile: linkedSecretFile,
    })).toThrow(/sessionSecretFile cannot be read/u)
  }, 30_000)

  it('accepts a service-owned 0700 login token directory and rejects unsafe ones', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-config-tokens-'))
    roots.push(root)
    const secretFile = join(root, 'secret')
    const authStateFile = join(root, 'auth-state.json')
    const loginTokenDirectory = join(root, 'login-tokens')
    writeFileSync(secretFile, `${credentials.secret}\n`, { mode: 0o600 })
    writeFileSync(authStateFile, '{}\n', { mode: 0o600 })
    const enabled = { authStateFile, sessionSecretFile: secretFile, loginTokenEnabled: true, loginTokenDirectory }

    expect(() => resolveConfig(enabled)).toThrow(/loginTokenDirectory cannot be used/u)

    writeFileSync(loginTokenDirectory, 'not-a-directory\n', { mode: 0o700 })
    expect(() => resolveConfig(enabled)).toThrow(/not a real directory/u)
    rmSync(loginTokenDirectory)

    mkdirSync(join(root, 'real-tokens'), { mode: 0o700 })
    chmodSync(join(root, 'real-tokens'), 0o700)
    symlinkSync(join(root, 'real-tokens'), loginTokenDirectory)
    expect(() => resolveConfig(enabled)).toThrow(/symbolic links are not allowed|not a real directory/u)
    rmSync(loginTokenDirectory)

    mkdirSync(loginTokenDirectory, { mode: 0o777 })
    chmodSync(loginTokenDirectory, 0o777)
    expect(() => resolveConfig(enabled)).toThrow(/permissions must be 0700/u)
    chmodSync(loginTokenDirectory, 0o770)
    expect(() => resolveConfig(enabled)).toThrow(/permissions must be 0700/u)

    chmodSync(loginTokenDirectory, 0o700)
    const config = resolveConfig(enabled)
    expect(config.loginTokenEnabled).toBe(true)
    expect(config.loginTokenDirectory).toBe(loginTokenDirectory)

    if (process.geteuid?.() === 0) {
      chownSync(loginTokenDirectory, 4242, 4243)
      expect(() => resolveConfig(enabled)).toThrow(/must be owned by the service/u)
    }
  }, 30_000)
})
