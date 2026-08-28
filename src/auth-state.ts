import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { parsePasswordHash } from './password.js'
import type { ExternalIdentity } from './external-identity.js'

/** HMAC identifier that binds persisted sessions to the current session secret. */
export function authStateSecretId(sessionSecret: Buffer): string {
  return createHmac('sha256', sessionSecret).update('dsh-auth-auth-state-v2').digest('base64url')
}

const AUTH_STATE_VERSION = 2
const MAX_AUTH_STATE_BYTES = 1024 * 1024
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export type AuthenticationMethod = 'password' | 'login-token' | 'external'

export interface AdministratorState {
  readonly id: 'admin'
  username: string | null
  passwordHash: string | null
  configuredAt: number | null
}

export interface StoredSession {
  readonly token: string
  readonly authenticationMethod: AuthenticationMethod
  readonly createdAt: number
  lastSeenAt: number
  expiresAt: number
  readonly identity?: ExternalIdentity
}

export interface AuthStateDocument {
  readonly schemaVersion: 2
  readonly secretId: string
  administrator: AdministratorState
  sessions: StoredSession[]
}

export interface LoadedAuthState {
  readonly document: AuthStateDocument
  readonly mustPersist: boolean
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} contains unknown or missing fields`)
  }
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`)
  return value as number
}

function persistedIdentity(value: unknown): ExternalIdentity {
  const saved = object(value, 'persisted session identity')
  const allowed = ['subject', 'username', 'displayName', 'picture', 'email', 'departmentId', 'departmentName', 'groups']
  if (Object.keys(saved).some(key => !allowed.includes(key))) throw new Error('persisted session identity contains unknown fields')
  const text = (key: string): string | undefined => {
    const item = saved[key]
    if (item === undefined) return undefined
    if (typeof item !== 'string' || item.length === 0 || Buffer.byteLength(item, 'utf8') > 512 || /\p{C}/u.test(item)) {
      throw new Error(`persisted session identity ${key} is invalid`)
    }
    return item
  }
  const subject = text('subject')
  if (subject === undefined) throw new Error('persisted session identity subject is required')
  const groups = saved.groups
  if (groups !== undefined && (!Array.isArray(groups) || groups.some(item => typeof item !== 'string' || item.length === 0 || item.length > 256))) {
    throw new Error('persisted session identity groups are invalid')
  }
  const username = text('username')
  const displayName = text('displayName')
  const picture = text('picture')
  if (picture !== undefined) {
    let url: URL
    try { url = new URL(picture) } catch { throw new Error('persisted session identity picture is invalid') }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
      throw new Error('persisted session identity picture must be an HTTPS URL')
    }
  }
  const email = text('email')
  const departmentId = text('departmentId')
  const departmentName = text('departmentName')
  return {
    subject,
    ...(username === undefined ? {} : { username }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(picture === undefined ? {} : { picture }),
    ...(email === undefined ? {} : { email }),
    ...(departmentId === undefined ? {} : { departmentId }),
    ...(departmentName === undefined ? {} : { departmentName }),
    ...(groups === undefined ? {} : { groups: groups as string[] }),
  }
}

function administrator(value: unknown): AdministratorState {
  const saved = object(value, 'administrator')
  exactKeys(saved, ['id', 'username', 'passwordHash', 'configuredAt'], 'administrator')
  if (saved.id !== 'admin') throw new Error('administrator id must be admin')
  const empty = saved.username === null && saved.passwordHash === null && saved.configuredAt === null
  if (empty) return { id: 'admin', username: null, passwordHash: null, configuredAt: null }
  if (typeof saved.username !== 'string' || saved.username.length === 0 || /\p{C}/u.test(saved.username)) {
    throw new Error('administrator username is invalid')
  }
  if (typeof saved.passwordHash !== 'string') throw new Error('administrator passwordHash is invalid')
  parsePasswordHash(saved.passwordHash)
  return {
    id: 'admin',
    username: saved.username,
    passwordHash: saved.passwordHash,
    configuredAt: timestamp(saved.configuredAt, 'administrator configuredAt'),
  }
}

function storedSession(value: unknown): StoredSession {
  const saved = object(value, 'persisted session')
  const baseKeys = ['token', 'authenticationMethod', 'createdAt', 'lastSeenAt', 'expiresAt']
  const actualKeys = Object.keys(saved).sort()
  const validKeys = actualKeys.join(',') === baseKeys.slice().sort().join(',')
    || actualKeys.join(',') === [...baseKeys, 'identity'].sort().join(',')
  if (!validKeys) throw new Error('persisted session contains unknown or missing fields')
  if (typeof saved.token !== 'string' || !SESSION_TOKEN_PATTERN.test(saved.token)) {
    throw new Error('persisted session token is invalid')
  }
  if (saved.authenticationMethod !== 'password' && saved.authenticationMethod !== 'login-token' && saved.authenticationMethod !== 'external') {
    throw new Error('persisted session authenticationMethod is invalid')
  }
  const session: StoredSession = {
    token: saved.token,
    authenticationMethod: saved.authenticationMethod,
    createdAt: timestamp(saved.createdAt, 'persisted session createdAt'),
    lastSeenAt: timestamp(saved.lastSeenAt, 'persisted session lastSeenAt'),
    expiresAt: timestamp(saved.expiresAt, 'persisted session expiresAt'),
    ...(saved.identity === undefined ? {} : { identity: persistedIdentity(saved.identity) }),
  }
  if (session.createdAt > session.lastSeenAt || session.lastSeenAt > session.expiresAt) {
    throw new Error('persisted session timestamps are inconsistent')
  }
  return session
}

function readDocument(path: string): Record<string, unknown> | undefined {
  let descriptor: number | undefined
  try {
    if (process.platform === 'win32' && lstatSync(path).isSymbolicLink()) {
      throw new Error('authStateFile must be a regular file, not a symlink or directory')
    }
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    descriptor = openSync(path, flags)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    if (errorCode(error) === 'ELOOP') {
      throw new Error('authStateFile must be a regular file, not a symlink or directory')
    }
    throw new Error(`authStateFile cannot be inspected: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('authStateFile must be a regular file, not a symlink or directory')
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o777) !== 0o600) throw new Error('authStateFile permissions must be 0600')
      const effectiveUser = process.geteuid?.()
      if (effectiveUser !== undefined && stat.uid !== effectiveUser) {
        throw new Error('authStateFile must be owned by the service user')
      }
    }
    if (stat.size === 0 || stat.size > MAX_AUTH_STATE_BYTES) {
      throw new Error(`authStateFile must contain 1-${String(MAX_AUTH_STATE_BYTES)} bytes`)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown
    } catch (error) {
      throw new Error(`authStateFile is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    return object(decoded, 'authStateFile')
  } finally {
    closeSync(descriptor)
  }
}

/** Construct a v2 authentication document for installer-created state. */
export function createAuthStateDocument(
  secretId: string,
  initial?: { readonly username: string; readonly passwordHash: string; readonly configuredAt: number },
): AuthStateDocument {
  const configured = initial === undefined
    ? { id: 'admin' as const, username: null, passwordHash: null, configuredAt: null }
    : { id: 'admin' as const, username: initial.username, passwordHash: initial.passwordHash, configuredAt: initial.configuredAt }
  if (initial !== undefined) parsePasswordHash(initial.passwordHash)
  return { schemaVersion: AUTH_STATE_VERSION, secretId, administrator: configured, sessions: [] }
}

export function loadAuthState(path: string, secretId: string): LoadedAuthState {
  const raw = readDocument(path)
  if (raw === undefined) throw new Error('authStateFile is missing')
  if (raw.schemaVersion !== AUTH_STATE_VERSION) throw new Error('authStateFile has an unsupported schemaVersion')
  exactKeys(raw, ['schemaVersion', 'secretId', 'administrator', 'sessions'], 'authStateFile')
  if (typeof raw.secretId !== 'string' || !SESSION_TOKEN_PATTERN.test(raw.secretId) || !Array.isArray(raw.sessions)) {
    throw new Error('authStateFile has invalid metadata')
  }
  if (raw.sessions.length > 4096) throw new Error('authStateFile contains too many sessions')
  const sessions = raw.sessions.map(storedSession)
  if (new Set(sessions.map(session => session.token)).size !== sessions.length) {
    throw new Error('authStateFile contains a duplicate session')
  }
  const document: AuthStateDocument = {
    schemaVersion: AUTH_STATE_VERSION,
    secretId,
    administrator: administrator(raw.administrator),
    sessions: raw.secretId === secretId ? sessions : [],
  }
  return { document, mustPersist: raw.secretId !== secretId }
}

function syncFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(dirname(path), constants.O_RDONLY)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function persistAuthState(path: string | undefined, document: AuthStateDocument): void {
  if (path === undefined) return
  const temporary = `${path}.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`
  const backup = `${path}.${String(process.pid)}.${randomBytes(8).toString('hex')}.backup`
  let backupCreated = false
  let replaced = false
  try {
    writeFileSync(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    syncFile(temporary)
    try {
      linkSync(path, backup)
      backupCreated = true
      syncDirectory(path)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    renameSync(temporary, path)
    replaced = true
    syncDirectory(path)
    if (backupCreated) unlinkSync(backup)
  } catch (error) {
    const failures: unknown[] = [error]
    try {
      if (replaced) {
        if (backupCreated) renameSync(backup, path)
        else unlinkSync(path)
        syncDirectory(path)
      } else if (backupCreated) {
        unlinkSync(backup)
      }
    } catch (restoreError) {
      failures.push(restoreError)
    }
    try {
      unlinkSync(temporary)
    } catch (cleanupError) {
      if (errorCode(cleanupError) !== 'ENOENT') failures.push(cleanupError)
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'authStateFile update and rollback failed')
    }
    throw new Error(`authStateFile cannot be updated: ${error instanceof Error ? error.message : String(error)}`)
  }
}
