import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { parsePasswordHash } from './password.js'

/** User-facing plugin configuration before defaults and file-backed values resolve. */
export interface ConfigInput {
  readonly basePath?: string
  readonly userId?: string
  readonly username?: string
  readonly roles?: readonly string[]
  readonly passwordHash?: string
  readonly passwordHashFile?: string
  readonly sessionSecret?: string
  readonly sessionSecretFile?: string
  readonly sessionStoreFile?: string
  readonly secureCookies?: boolean
  readonly sessionTtlSeconds?: number
  readonly idleTtlSeconds?: number
  readonly sessionRenewalSeconds?: number
  readonly maxSessions?: number
  readonly maxPasswordBytes?: number
  readonly loginWindowSeconds?: number
  readonly loginMaxAttempts?: number
  readonly loginBlockSeconds?: number
  readonly trustedProxyAddresses?: readonly string[]
}

/** Fully validated runtime configuration. */
export interface ResolvedConfig {
  readonly basePath: string
  readonly user: {
    readonly userId: string
    readonly username: string
    readonly roles: readonly string[]
  }
  readonly passwordHash: string
  readonly sessionSecret: Buffer
  readonly sessionStoreFile: string | undefined
  readonly secureCookies: boolean
  readonly sessionTtlSeconds: number
  readonly idleTtlSeconds: number
  readonly sessionRenewalSeconds: number
  readonly maxSessions: number
  readonly maxPasswordBytes: number
  readonly loginWindowSeconds: number
  readonly loginMaxAttempts: number
  readonly loginBlockSeconds: number
  readonly trustedProxyAddresses: ReadonlySet<string>
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config must be an object')
  }
  return value as Record<string, unknown>
}

function requiredString(input: Record<string, unknown>, key: string, maxLength = 128): string {
  const value = input[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${key} must be a non-empty string no longer than ${String(maxLength)} characters`)
  }
  return value
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function integer(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = input[key] ?? fallback
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${key} must be an integer from ${String(min)} to ${String(max)}`)
  }
  return value as number
}

function boolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key] ?? fallback
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

function stringList(input: Record<string, unknown>, key: string, fallback: readonly string[]): readonly string[] {
  const value = input[key] ?? fallback
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error(`${key} must be a non-empty array with at most 32 entries`)
  }
  const entries = value.map((entry) => {
    if (typeof entry !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(entry)) {
      throw new Error(`${key} entries must be 1-64 character identifiers`)
    }
    return entry
  })
  if (new Set(entries).size !== entries.length) throw new Error(`${key} must not contain duplicates`)
  return entries
}

function proxyAddressList(input: Record<string, unknown>): readonly string[] {
  const value = input.trustedProxyAddresses ?? ['127.0.0.1', '::1']
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error('trustedProxyAddresses must be a non-empty array with at most 32 entries')
  }
  const entries = value.map((entry) => {
    if (typeof entry !== 'string') throw new Error('trustedProxyAddresses entries must be literal IP addresses')
    const normalized = entry.startsWith('::ffff:') ? entry.slice('::ffff:'.length) : entry
    if (isIP(normalized) === 0) throw new Error('trustedProxyAddresses entries must be literal IP addresses')
    return normalized
  })
  if (new Set(entries).size !== entries.length) throw new Error('trustedProxyAddresses must not contain duplicates')
  return entries
}

function materialFromFile(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label}File must be an absolute path`)
  let descriptor: number | undefined
  try {
    if (process.platform === 'win32' && lstatSync(path).isSymbolicLink()) throw new Error('symbolic links are not allowed')
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    descriptor = openSync(path, flags)
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('not a regular file')
    if (stat.size === 0 || stat.size > 4096) throw new Error('must contain 1-4096 bytes')
    if (process.platform !== 'win32' && ((stat.mode & 0o020) !== 0 || (stat.mode & 0o007) !== 0)) {
      throw new Error('must not allow group write or any access by others')
    }
    return readFileSync(descriptor, 'utf8').replace(/\r?\n$/u, '')
  } catch (error) {
    throw new Error(`${label}File cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function exclusiveMaterial(input: Record<string, unknown>, valueKey: string, fileKey: string): string {
  const value = optionalString(input, valueKey)
  const file = optionalString(input, fileKey)
  if ((value === undefined) === (file === undefined)) {
    throw new Error(`configure exactly one of ${valueKey} or ${fileKey}`)
  }
  if (value !== undefined) return value
  if (file === undefined) throw new Error(`configure ${fileKey}`)
  return materialFromFile(file, valueKey)
}

function validateBasePath(value: unknown): string {
  const path = value ?? '/auth'
  if (typeof path !== 'string' || !/^\/[A-Za-z0-9/_-]*[A-Za-z0-9_-]$/u.test(path) || path.includes('//')) {
    throw new Error('basePath must be an absolute path without a trailing slash or repeated slash')
  }
  return path
}

function optionalAbsolutePath(input: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(input, key)
  if (value === undefined) return undefined
  if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path`)
  return value
}

/**
 * Validate and resolve all plugin configuration.
 * @param value - raw Cordis config.
 * @returns immutable runtime configuration.
 */
export function resolveConfig(value: unknown): ResolvedConfig {
  const input = record(value)
  const userId = requiredString(input, 'userId')
  const username = requiredString(input, 'username')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(userId)) {
    throw new Error('userId must be a 1-128 character stable identifier')
  }
  if (/\p{C}/u.test(username)) throw new Error('username must not contain control characters')
  const roles = stringList(input, 'roles', ['admin'])
  const passwordHash = exclusiveMaterial(input, 'passwordHash', 'passwordHashFile')
  parsePasswordHash(passwordHash)
  const secretText = exclusiveMaterial(input, 'sessionSecret', 'sessionSecretFile')
  const sessionSecret = Buffer.from(secretText, 'utf8')
  if (sessionSecret.length < 32 || sessionSecret.length > 4096) {
    throw new Error('sessionSecret must contain 32-4096 bytes')
  }
  if (sessionSecret.includes(0)) throw new Error('sessionSecret must not contain NUL bytes')

  const sessionTtlSeconds = integer(input, 'sessionTtlSeconds', 72 * 60 * 60, 60, 30 * 24 * 60 * 60)
  const idleTtlSeconds = integer(input, 'idleTtlSeconds', 72 * 60 * 60, 60, sessionTtlSeconds)
  const sessionRenewalSeconds = integer(
    input,
    'sessionRenewalSeconds',
    Math.min(60 * 60, sessionTtlSeconds, idleTtlSeconds),
    1,
    Math.min(sessionTtlSeconds, idleTtlSeconds),
  )
  const trustedProxyAddresses = proxyAddressList(input)
  return {
    basePath: validateBasePath(input.basePath),
    user: { userId, username, roles },
    passwordHash,
    sessionSecret,
    sessionStoreFile: optionalAbsolutePath(input, 'sessionStoreFile'),
    secureCookies: boolean(input, 'secureCookies', true),
    sessionTtlSeconds,
    idleTtlSeconds,
    sessionRenewalSeconds,
    maxSessions: integer(input, 'maxSessions', 16, 1, 1024),
    maxPasswordBytes: integer(input, 'maxPasswordBytes', 1024, 64, 16 * 1024),
    loginWindowSeconds: integer(input, 'loginWindowSeconds', 60, 1, 60 * 60),
    loginMaxAttempts: integer(input, 'loginMaxAttempts', 5, 1, 100),
    loginBlockSeconds: integer(input, 'loginBlockSeconds', 5 * 60, 1, 24 * 60 * 60),
    trustedProxyAddresses: new Set(trustedProxyAddresses),
  }
}

/** Cordis Standard Schema validator for fail-loud load-time configuration. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-auth',
    validate(value): StandardSchemaV1.Result<ResolvedConfig> {
      try {
        return { value: resolveConfig(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
} satisfies StandardSchemaV1<ConfigInput, ResolvedConfig>
