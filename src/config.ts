import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { inspectTokenDirectory } from './login-token-store.js'

/** Public authentication prefix is fixed for installer, Caddy, and browser URLs. */
const AUTH_BASE_PATH = '/auth'

function ownPackageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { readonly version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('dsh-auth package version is unavailable')
  return manifest.version
}

const ALLOWED_KEYS = [
  'authStateFile',
  'sessionSecretFile',
  'expectedVersion',
  'loginTokenEnabled',
  'loginTokenDirectory',
  'loginTokenFailureMessageZh',
  'loginTokenFailureMessageEn',
  'secureCookies',
  'sessionTtlSeconds',
  'idleTtlSeconds',
  'sessionRenewalSeconds',
  'maxSessions',
  'loginWindowSeconds',
  'loginMaxAttempts',
  'loginBlockSeconds',
  'loginTokenWindowSeconds',
  'loginTokenMaxAttempts',
  'loginTokenBlockSeconds',
  'trustedProxyAddresses',
  'externalIdentity',
  'gatewayIdentity',
] as const

const REMOVED_KEYS: Readonly<Record<string, string>> = {
  basePath: 'basePath is fixed to /auth',
  userId: 'userId is fixed to admin and is not configurable',
  username: 'username is stored in authStateFile, not plugin config',
  roles: 'roles are fixed to admin and are not configurable',
  passwordHash: 'passwordHash is stored in authStateFile, not plugin config',
  passwordHashFile: 'passwordHashFile is not accepted; use authStateFile',
  sessionSecret: 'sessionSecret literals are not accepted; use sessionSecretFile',
  sessionStoreFile: 'sessionStoreFile is not accepted; use authStateFile',
  maxPasswordBytes: 'maxPasswordBytes is not configurable',
}

/** User-facing plugin configuration before defaults and file-backed values resolve. */
export interface ConfigInput {
  readonly authStateFile?: string
  readonly sessionSecretFile?: string
  readonly expectedVersion?: string
  readonly loginTokenEnabled?: boolean
  readonly loginTokenDirectory?: string
  readonly loginTokenFailureMessageZh?: string
  readonly loginTokenFailureMessageEn?: string
  readonly secureCookies?: boolean
  readonly sessionTtlSeconds?: number
  readonly idleTtlSeconds?: number
  readonly sessionRenewalSeconds?: number
  readonly maxSessions?: number
  readonly loginWindowSeconds?: number
  readonly loginMaxAttempts?: number
  readonly loginBlockSeconds?: number
  readonly loginTokenWindowSeconds?: number
  readonly loginTokenMaxAttempts?: number
  readonly loginTokenBlockSeconds?: number
  readonly trustedProxyAddresses?: readonly string[]
  readonly externalIdentity?: ExternalIdentityConfigInput
  readonly gatewayIdentity?: GatewayIdentityConfigInput
}

interface GatewayIdentityConfigInput {
  readonly enabled?: boolean
  readonly tokenFile?: string
  readonly safeMode?: boolean
  readonly allowedUsers?: readonly string[]
  readonly allowedDepartmentIds?: readonly string[]
  readonly allowedDepartmentPrefixes?: readonly string[]
}

interface ExternalIdentityConfigInput {
  readonly enabled?: boolean
  readonly paasId?: string
  readonly tokenFile?: string
  readonly baseUrl?: string
  readonly authorizationEndpoint?: string
  readonly accessTokenPath?: string
  readonly callbackUrl?: string
  readonly allowedUsers?: readonly string[]
  readonly allowedDepartmentIds?: readonly string[]
  readonly allowedDepartmentPrefixes?: readonly string[]
}

interface ExternalIdentityConfig {
  readonly enabled: boolean
  readonly paasId: string
  readonly token: string
  readonly baseUrl: string
  readonly authorizationEndpoint?: string
  readonly accessTokenPath?: string
  readonly callbackUrl: string
  readonly allowedUsers: ReadonlySet<string>
  readonly allowedDepartmentIds: ReadonlySet<string>
  readonly allowedDepartmentPrefixes: readonly string[]
}

/** Fully validated runtime configuration. */
export interface ResolvedConfig {
  readonly basePath: typeof AUTH_BASE_PATH
  readonly authStateFile: string
  readonly sessionSecret: Buffer
  readonly loginTokenEnabled: boolean
  readonly loginTokenDirectory?: string
  readonly loginTokenFailureMessageZh?: string
  readonly loginTokenFailureMessageEn?: string
  readonly secureCookies: boolean
  readonly sessionTtlSeconds: number
  readonly idleTtlSeconds: number
  readonly sessionRenewalSeconds: number
  readonly maxSessions: number
  readonly loginWindowSeconds: number
  readonly loginMaxAttempts: number
  readonly loginBlockSeconds: number
  readonly loginTokenWindowSeconds: number
  readonly loginTokenMaxAttempts: number
  readonly loginTokenBlockSeconds: number
  readonly trustedProxyAddresses: ReadonlySet<string>
  readonly externalIdentity?: ExternalIdentityConfig
  readonly gatewayIdentity?: { readonly token: string; readonly safeMode: boolean; readonly allowedUsers: ReadonlySet<string>; readonly allowedDepartmentIds: ReadonlySet<string>; readonly allowedDepartmentPrefixes: readonly string[] }
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config must be an object')
  }
  return value as Record<string, unknown>
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
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

function requiredAbsolutePath(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key)
  if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path`)
  return value
}

function inspectSecretFile(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`)
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
    throw new Error(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function inspectAuthStateFile(path: string): string {
  let descriptor: number | undefined
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('not a regular file')
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    descriptor = openSync(path, flags)
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('not a regular file')
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o777) !== 0o600) throw new Error('permissions must be 0600')
    }
    if (stat.size === 0 || stat.size > 1024 * 1024) throw new Error('must contain 1-1048576 bytes')
    return path
  } catch (error) {
    throw new Error(`authStateFile cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function inspectLoginTokenDirectory(path: string): string {
  try {
    const directory = inspectTokenDirectory(path)
    if (process.platform !== 'win32') {
      if ((directory.mode & 0o777) !== 0o700) throw new Error('permissions must be 0700')
      const uid = process.geteuid?.()
      const gid = process.getegid?.()
      if (uid !== undefined && directory.uid !== uid) throw new Error('must be owned by the service user')
      if (gid !== undefined && directory.gid !== gid) throw new Error('must be owned by the service group')
    }
    return path
  } catch (error) {
    throw new Error(`loginTokenDirectory cannot be used: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function plainTextMessage(input: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(input, key)
  if (value === undefined) return undefined
  const points = Array.from(value).length
  if (points < 1 || points > 500 || /\p{C}/u.test(value)) {
    throw new Error(`${key} must be 1-500 Unicode code points of plain text without control characters`)
  }
  return value
}

function stringList(value: unknown, key: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0 || /\p{C}/u.test(item))) {
    throw new Error(`${key} must be an array of non-empty strings`)
  }
  return value as string[]
}

function externalIdentity(input: Record<string, unknown>): ExternalIdentityConfig | undefined {
  const raw = input.externalIdentity ?? (process.env.DSH_AUTH_EXTERNAL_ENABLED === 'true' ? {
    enabled: true,
    paasId: process.env.DSH_AUTH_EXTERNAL_PAAS_ID,
    tokenFile: process.env.DSH_AUTH_EXTERNAL_TOKEN_FILE,
    baseUrl: process.env.DSH_AUTH_EXTERNAL_BASE_URL,
    callbackUrl: process.env.DSH_AUTH_EXTERNAL_CALLBACK_URL,
    allowedUsers: (process.env.DSH_AUTH_EXTERNAL_ALLOWED_USERS ?? '').split(',').map(value => value.trim()).filter(Boolean),
    allowedDepartmentIds: (process.env.DSH_AUTH_EXTERNAL_ALLOWED_DEPT_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean),
    allowedDepartmentPrefixes: (process.env.DSH_AUTH_EXTERNAL_ALLOWED_DEPT_PREFIXES ?? '').split(',').map(value => value.trim()).filter(Boolean),
  } : undefined)
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('externalIdentity must be an object')
  const value = raw as Record<string, unknown>
  const enabled = boolean(value, 'enabled', false)
  if (!enabled) return undefined
  const paasId = requiredString(value, 'paasId')
  const tokenFile = requiredAbsolutePath(value, 'tokenFile')
  const baseUrl = optionalString(value, 'baseUrl') ?? 'https://api.woa.com'
  const authorizationEndpoint = optionalString(value, 'authorizationEndpoint')
  const accessTokenPath = optionalString(value, 'accessTokenPath')
  const callbackUrl = requiredString(value, 'callbackUrl')
  return {
    enabled,
    paasId,
    token: inspectSecretFile(tokenFile, 'externalIdentity.tokenFile'),
    baseUrl,
    ...(authorizationEndpoint === undefined ? {} : { authorizationEndpoint }),
    ...(accessTokenPath === undefined ? {} : { accessTokenPath }),
    callbackUrl,
    allowedUsers: new Set(stringList(value.allowedUsers, 'externalIdentity.allowedUsers')),
    allowedDepartmentIds: new Set(stringList(value.allowedDepartmentIds, 'externalIdentity.allowedDepartmentIds')),
    allowedDepartmentPrefixes: stringList(value.allowedDepartmentPrefixes, 'externalIdentity.allowedDepartmentPrefixes'),
  }
}

function assertAllowedKeys(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    const removed = REMOVED_KEYS[key]
    if (removed !== undefined) throw new Error(removed)
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) throw new Error(`unknown config field ${key}`)
  }
}

/**
 * Validate and resolve all plugin configuration.
 * @param value - raw Cordis config.
 * @returns immutable runtime configuration.
 */
export function resolveConfig(value: unknown): ResolvedConfig {
  const input = record(value)
  assertAllowedKeys(input)
  const authStateFile = inspectAuthStateFile(requiredAbsolutePath(input, 'authStateFile'))
  const secretText = inspectSecretFile(requiredAbsolutePath(input, 'sessionSecretFile'), 'sessionSecretFile')
  const sessionSecret = Buffer.from(secretText, 'utf8')
  if (sessionSecret.length < 32 || sessionSecret.length > 4096) {
    throw new Error('sessionSecret must contain 32-4096 bytes')
  }
  if (sessionSecret.includes(0)) throw new Error('sessionSecret must not contain NUL bytes')

  const expectedVersion = optionalString(input, 'expectedVersion')
  if (expectedVersion !== undefined && expectedVersion !== ownPackageVersion()) {
    // Fail-closed marker from the managed environment file: the bundle that
    // drifted away from the managed installation must not silently activate.
    throw new Error(`expectedVersion ${expectedVersion} does not match this dsh-auth ${ownPackageVersion()}; restore the recorded bundle and run dsh-auth upgrade`)
  }

  const loginTokenEnabled = boolean(input, 'loginTokenEnabled', false)
  const loginTokenDirectory = optionalString(input, 'loginTokenDirectory')
  if (loginTokenEnabled) {
    if (loginTokenDirectory === undefined || !isAbsolute(loginTokenDirectory)) {
      throw new Error('loginTokenDirectory must be an absolute path when login tokens are enabled')
    }
    if (loginTokenDirectory !== join(dirname(authStateFile), 'login-tokens')) {
      throw new Error('loginTokenDirectory must be the login-tokens directory beside authStateFile')
    }
    inspectLoginTokenDirectory(loginTokenDirectory)
  } else if (loginTokenDirectory !== undefined) {
    throw new Error('loginTokenDirectory is only accepted when loginTokenEnabled is true')
  }

  const failureZh = plainTextMessage(input, 'loginTokenFailureMessageZh')
  const failureEn = plainTextMessage(input, 'loginTokenFailureMessageEn')
  const sessionTtlSeconds = integer(input, 'sessionTtlSeconds', 72 * 60 * 60, 60, 30 * 24 * 60 * 60)
  const idleTtlSeconds = integer(input, 'idleTtlSeconds', 72 * 60 * 60, 60, sessionTtlSeconds)
  const sessionRenewalSeconds = integer(
    input,
    'sessionRenewalSeconds',
    Math.min(60 * 60, sessionTtlSeconds, idleTtlSeconds),
    1,
    Math.min(sessionTtlSeconds, idleTtlSeconds),
  )
  const resolvedExternalIdentity = externalIdentity(input)
  const gatewayRaw = input.gatewayIdentity as Record<string, unknown> | undefined
  const gatewayEnabled = gatewayRaw?.enabled === true || process.env.DSH_AUTH_GATEWAY_ENABLED === 'true'
  const gatewayTokenFile = typeof gatewayRaw?.tokenFile === 'string' ? gatewayRaw.tokenFile : process.env.DSH_AUTH_GATEWAY_TOKEN_FILE
  const gatewaySafeMode = gatewayRaw?.safeMode !== false && process.env.DSH_AUTH_GATEWAY_SAFE_MODE !== 'false'
  const list = (key: string): readonly string[] => {
    const value = gatewayRaw?.[key] ?? process.env[`DSH_AUTH_GATEWAY_${key.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}`]
    if (value === undefined) return []
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${key} must be a string list`)
    return String(value).split(',').map((entry) => entry.trim()).filter(Boolean)
  }
  const resolvedGatewayIdentity = gatewayEnabled
    ? {
        token: inspectSecretFile(requiredAbsolutePath({ tokenFile: gatewayTokenFile }, 'tokenFile'), 'gatewayIdentity.tokenFile'),
        safeMode: gatewaySafeMode,
        allowedUsers: new Set(list('allowedUsers')),
        allowedDepartmentIds: new Set(list('allowedDepartmentIds')),
        allowedDepartmentPrefixes: list('allowedDepartmentPrefixes'),
      }
    : undefined
  return {
    basePath: AUTH_BASE_PATH,
    authStateFile,
    sessionSecret,
    loginTokenEnabled,
    ...(loginTokenDirectory === undefined ? {} : { loginTokenDirectory }),
    ...(failureZh === undefined ? {} : { loginTokenFailureMessageZh: failureZh }),
    ...(failureEn === undefined ? {} : { loginTokenFailureMessageEn: failureEn }),
    secureCookies: boolean(input, 'secureCookies', true),
    sessionTtlSeconds,
    idleTtlSeconds,
    sessionRenewalSeconds,
    maxSessions: integer(input, 'maxSessions', 16, 1, 1024),
    loginWindowSeconds: integer(input, 'loginWindowSeconds', 60, 1, 60 * 60),
    loginMaxAttempts: integer(input, 'loginMaxAttempts', 5, 1, 100),
    loginBlockSeconds: integer(input, 'loginBlockSeconds', 5 * 60, 1, 24 * 60 * 60),
    loginTokenWindowSeconds: integer(input, 'loginTokenWindowSeconds', 60, 1, 60 * 60),
    loginTokenMaxAttempts: integer(input, 'loginTokenMaxAttempts', 10, 1, 100),
    loginTokenBlockSeconds: integer(input, 'loginTokenBlockSeconds', 5 * 60, 1, 24 * 60 * 60),
    trustedProxyAddresses: new Set(proxyAddressList(input)),
    ...(resolvedExternalIdentity === undefined ? {} : { externalIdentity: resolvedExternalIdentity }),
    ...(resolvedGatewayIdentity === undefined ? {} : { gatewayIdentity: resolvedGatewayIdentity }),
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
