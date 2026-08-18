import { argon2, randomBytes, timingSafeEqual } from 'node:crypto'

/** Resource limits accepted from a stored Argon2id password hash. */
const LIMITS = {
  memoryMin: 8 * 1024,
  memoryMax: 1024 * 1024,
  passesMax: 10,
  parallelismMax: 16,
  saltMin: 16,
  saltMax: 64,
  tagMin: 16,
  tagMax: 64,
} as const

/** Default Argon2id parameters used by the hash generator. */
const DEFAULT_PASSWORD_PARAMETERS = {
  memory: 64 * 1024,
  passes: 3,
  parallelism: 1,
  tagLength: 32,
} as const

/** Parsed Argon2id password hash. */
export interface PasswordHash {
  readonly memory: number
  readonly passes: number
  readonly parallelism: number
  readonly salt: Buffer
  readonly tag: Buffer
}

function decodePhcBase64(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9+/]+$/.test(value)) {
    throw new Error(`password hash ${label} is not unpadded base64`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64').replace(/=+$/u, '') !== value) {
    throw new Error(`password hash ${label} is not canonical base64`)
  }
  return decoded
}

function checkedInteger(raw: string, label: string, min: number, max: number): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`password hash ${label} must be an integer from ${String(min)} to ${String(max)}`)
  }
  return value
}

/**
 * Parse and resource-bound one PHC-style Argon2id hash.
 * @param encoded - hash in `$argon2id$v=19$m=...,t=...,p=...$salt$tag` form.
 * @returns validated parameters and decoded bytes.
 */
export function parsePasswordHash(encoded: string): PasswordHash {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/u.exec(encoded)
  if (match === null) {
    throw new Error('passwordHash must be a PHC-style Argon2id v=19 hash')
  }
  const memory = checkedInteger(match[1] ?? '', 'memory', LIMITS.memoryMin, LIMITS.memoryMax)
  const passes = checkedInteger(match[2] ?? '', 'passes', 1, LIMITS.passesMax)
  const parallelism = checkedInteger(match[3] ?? '', 'parallelism', 1, LIMITS.parallelismMax)
  const salt = decodePhcBase64(match[4] ?? '', 'salt')
  const tag = decodePhcBase64(match[5] ?? '', 'tag')
  if (salt.length < LIMITS.saltMin || salt.length > LIMITS.saltMax) {
    throw new Error(`password hash salt must be ${String(LIMITS.saltMin)}-${String(LIMITS.saltMax)} bytes`)
  }
  if (tag.length < LIMITS.tagMin || tag.length > LIMITS.tagMax) {
    throw new Error(`password hash tag must be ${String(LIMITS.tagMin)}-${String(LIMITS.tagMax)} bytes`)
  }
  return { memory, passes, parallelism, salt, tag }
}

function derive(password: string, parsed: PasswordHash): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', {
      message: Buffer.from(password, 'utf8'),
      nonce: parsed.salt,
      parallelism: parsed.parallelism,
      tagLength: parsed.tag.length,
      memory: parsed.memory,
      passes: parsed.passes,
    }, (error, value) => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve(value)
    })
  })
}

/**
 * Verify a password with constant-time derived-tag comparison.
 * @param password - submitted password.
 * @param encoded - validated PHC-style Argon2id hash.
 * @returns whether the password matches.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded)
  const actual = await derive(password, parsed)
  return timingSafeEqual(actual, parsed.tag)
}

function phcBase64(value: Buffer): string {
  return value.toString('base64').replace(/=+$/u, '')
}

/** Administrator password policy: 15-128 Unicode code points and at most 1024 UTF-8 bytes. */
const ADMIN_PASSWORD_MIN_POINTS = 15
const ADMIN_PASSWORD_MAX_POINTS = 128
export const ADMIN_PASSWORD_MAX_BYTES = 1024

/** Reject passwords that are too short, too long, or too large in UTF-8. */
export function assertAdministratorPassword(password: string): void {
  const points = Array.from(password).length
  if (points < ADMIN_PASSWORD_MIN_POINTS || points > ADMIN_PASSWORD_MAX_POINTS) {
    throw new Error(`password must be ${String(ADMIN_PASSWORD_MIN_POINTS)}-${String(ADMIN_PASSWORD_MAX_POINTS)} Unicode code points`)
  }
  if (Buffer.byteLength(password, 'utf8') > ADMIN_PASSWORD_MAX_BYTES) {
    throw new Error(`password must not exceed ${String(ADMIN_PASSWORD_MAX_BYTES)} UTF-8 bytes`)
  }
}

/**
 * Generate a PHC-style Argon2id password hash with a random 16-byte salt.
 * @param password - password to hash; policy-invalid passwords are rejected.
 * @returns encoded hash suitable for administrator authentication state.
 */
export async function hashPassword(password: string): Promise<string> {
  assertAdministratorPassword(password)
  const salt = randomBytes(16)
  const parsed: PasswordHash = {
    ...DEFAULT_PASSWORD_PARAMETERS,
    salt,
    tag: Buffer.alloc(DEFAULT_PASSWORD_PARAMETERS.tagLength),
  }
  const tag = await derive(password, parsed)
  const parameters = `m=${String(parsed.memory)},t=${String(parsed.passes)},p=${String(parsed.parallelism)}`
  return `$argon2id$v=19$${parameters}$${phcBase64(salt)}$${phcBase64(tag)}`
}
