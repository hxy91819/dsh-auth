import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashPassword, parseAdministratorUsername, parsePasswordHash, verifyPassword } from '../src/password.js'

describe('Argon2id password hashes', () => {
  it('generates a bounded PHC hash and verifies only the submitted secret', async () => {
    const submitted = randomBytes(32).toString('base64url')
    const different = randomBytes(32).toString('base64url')
    const encoded = await hashPassword(submitted)

    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/u)
    expect(parsePasswordHash(encoded)).toMatchObject({ memory: 65_536, passes: 3, parallelism: 1 })
    await expect(verifyPassword(submitted, encoded)).resolves.toBe(true)
    await expect(verifyPassword(different, encoded)).resolves.toBe(false)
  }, 30_000)

  it('rejects unsupported versions and excessive resource parameters', () => {
    expect(() => parsePasswordHash('$argon2id$v=16$m=65536,t=3,p=1$AA$AA')).toThrow(/v=19/u)
    expect(() => parsePasswordHash('$argon2id$v=19$m=2000000,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA'))
      .toThrow(/memory/u)
  })

  it('rejects administrator passwords shorter than the v2 policy', async () => {
    await expect(hashPassword('fourteen-char.')).rejects.toThrow(/15-128/u)
  })
})

describe('administrator username policy', () => {
  it('normalizes NFC and rejects whitespace, control characters, and length boundaries', () => {
    expect(parseAdministratorUsername('e\u0301lite')).toBe('élite')
    expect(parseAdministratorUsername('管理员')).toBe('管理员')
    expect(parseAdministratorUsername('a'.repeat(64))).toHaveLength(64)
    expect(() => parseAdministratorUsername(' leading')).toThrow(/whitespace/u)
    expect(() => parseAdministratorUsername('trailing ')).toThrow(/whitespace/u)
    expect(() => parseAdministratorUsername('bad\u0007name')).toThrow(/1-64/u)
    expect(() => parseAdministratorUsername('a'.repeat(65))).toThrow(/1-64/u)
    expect(() => parseAdministratorUsername('')).toThrow(/1-64/u)
  })
})
