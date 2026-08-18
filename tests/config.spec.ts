import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.js'
import { testCredentials } from './helpers.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('configuration', () => {
  it('fails before activation when identity, hash, or session secret is absent', () => {
    expect(Config['~standard'].validate({}).issues?.[0]?.message).toMatch(/userId/u)
    expect(() => resolveConfig({ userId: 'u', username: 'name' })).toThrow(/passwordHash/u)
  })

  it('reads bounded absolute secret files and resolves administrator bootstrap credentials', async () => {
    const credentials = await testCredentials()
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-config-'))
    roots.push(root)
    const hashFile = join(root, 'hash')
    const secretFile = join(root, 'secret')
    writeFileSync(hashFile, `${credentials.hash}\n`, { mode: 0o640 })
    writeFileSync(secretFile, `${randomBytes(48).toString('base64url')}\n`, { mode: 0o640 })

    const config = resolveConfig({
      userId: 'stable-id',
      username: 'display-name',
      roles: ['admin', 'operator'],
      passwordHashFile: hashFile,
      sessionSecretFile: secretFile,
    })
    expect(config.initialAdministrator).toEqual({ username: 'display-name', passwordHash: credentials.hash })
    expect(config.sessionSecret.length).toBeGreaterThanOrEqual(32)
    expect(config.secureCookies).toBe(true)
    expect(config.sessionTtlSeconds).toBe(72 * 60 * 60)
    expect(config.idleTtlSeconds).toBe(72 * 60 * 60)
    expect(config.sessionRenewalSeconds).toBe(60 * 60)
  }, 30_000)

  it('rejects relative files, duplicate sources, and invalid lifetimes', async () => {
    const credentials = await testCredentials()
    const base = { userId: 'u', username: 'name', passwordHash: credentials.hash, sessionSecret: credentials.secret }
    expect(() => resolveConfig({ ...base, passwordHashFile: 'relative' })).toThrow(/exactly one/u)
    expect(() => resolveConfig({ ...base, sessionStoreFile: 'relative' })).toThrow(/sessionStoreFile/u)
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
    const hashFile = join(root, 'hash')
    const secretFile = join(root, 'secret')
    const linkedSecretFile = join(root, 'secret-link')
    writeFileSync(hashFile, `${credentials.hash}\n`, { mode: 0o600 })
    writeFileSync(secretFile, `${credentials.secret}\n`, { mode: 0o600 })
    symlinkSync(secretFile, linkedSecretFile)

    chmodSync(hashFile, 0o644)
    expect(() => resolveConfig({
      userId: 'u', username: 'name', passwordHashFile: hashFile, sessionSecretFile: secretFile,
    })).toThrow(/any access by others/u)

    chmodSync(hashFile, 0o640)
    expect(() => resolveConfig({
      userId: 'u', username: 'name', passwordHashFile: hashFile, sessionSecretFile: linkedSecretFile,
    })).toThrow(/sessionSecretFile cannot be read/u)
  }, 30_000)
})
