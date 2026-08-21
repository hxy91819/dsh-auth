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

/** HMAC identifier that binds persisted sessions to the current session secret. */
export function authStateSecretId(sessionSecret: Buffer): string {
  return createHmac('sha256', sessionSecret).update('dsh-auth-auth-state-v2').digest('base64url')
}

const AUTH_STATE_VERSION = 3
const MAX_AUTH_STATE_BYTES = 1024 * 1024
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9_-]{22,}$/u
export const MAX_AUTH_ACCOUNTS = 256
export const MAX_STORED_SESSIONS = 4096

export type AuthenticationMethod = 'password' | 'login-token'
export type AccountMode = 'single' | 'trusted-team-preview'
export type AccountRole = 'admin' | 'member'
export type AccountStatus = 'pending' | 'active' | 'disabled'
export type AccountId = 'admin' | `acct_${string}`

interface AdministratorState {
  readonly id: 'admin'
  username: string | null
  passwordHash: string | null
  configuredAt: number | null
}

export interface AccountState {
  readonly id: AccountId
  username: string | null
  passwordHash: string | null
  readonly role: AccountRole
  status: AccountStatus
  authVersion: number
  readonly createdAt: number
  configuredAt: number | null
}

export interface StoredSession {
  readonly token: string
  readonly accountId: AccountId
  accountAuthVersion: number
  readonly authenticationMethod: AuthenticationMethod
  readonly createdAt: number
  lastSeenAt: number
  expiresAt: number
}

interface StoredSessionV2 {
  readonly token: string
  readonly authenticationMethod: AuthenticationMethod
  readonly createdAt: number
  lastSeenAt: number
  expiresAt: number
}

export interface AuthStateDocument {
  readonly schemaVersion: 3
  readonly secretId: string
  accountMode: AccountMode
  accounts: AccountState[]
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

function nullableTimestamp(value: unknown, label: string): number | null {
  return value === null ? null : timestamp(value, label)
}

function authVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value as number
}

function accountId(value: unknown, label: string): AccountId {
  if (value === 'admin') return 'admin'
  if (typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value)) return value as AccountId
  throw new Error(`${label} is invalid`)
}

function accountUsername(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /\p{C}/u.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value.normalize('NFC')
}

function passwordHash(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${label} is invalid`)
  parsePasswordHash(value)
  return value
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

function account(value: unknown): AccountState {
  const saved = object(value, 'account')
  exactKeys(
    saved,
    ['id', 'username', 'passwordHash', 'role', 'status', 'authVersion', 'createdAt', 'configuredAt'],
    'account',
  )
  const id = accountId(saved.id, 'account id')
  if (saved.role !== 'admin' && saved.role !== 'member') throw new Error('account role is invalid')
  if (saved.status !== 'pending' && saved.status !== 'active' && saved.status !== 'disabled') {
    throw new Error('account status is invalid')
  }
  if (id === 'admin' && saved.role !== 'admin') throw new Error('admin account role must be admin')
  if (id !== 'admin' && saved.role !== 'member') throw new Error('member account role must be member')
  if (id !== 'admin' && saved.status === 'pending') throw new Error('member account cannot be pending')
  const username = accountUsername(saved.username, 'account username')
  const hash = passwordHash(saved.passwordHash, 'account passwordHash')
  const configuredAt = nullableTimestamp(saved.configuredAt, 'account configuredAt')
  const configured = username !== null && hash !== null && configuredAt !== null
  if (saved.status === 'pending') {
    if (configured || id !== 'admin') throw new Error('only an unconfigured admin account may be pending')
  } else if (!configured) {
    throw new Error('active or disabled accounts must be configured')
  }
  return {
    id,
    username,
    passwordHash: hash,
    role: saved.role,
    status: saved.status,
    authVersion: authVersion(saved.authVersion, 'account authVersion'),
    createdAt: timestamp(saved.createdAt, 'account createdAt'),
    configuredAt,
  }
}

function storedSessionV2(value: unknown): StoredSessionV2 {
  const saved = object(value, 'persisted session')
  exactKeys(
    saved,
    ['token', 'authenticationMethod', 'createdAt', 'lastSeenAt', 'expiresAt'],
    'persisted session',
  )
  if (typeof saved.token !== 'string' || !SESSION_TOKEN_PATTERN.test(saved.token)) {
    throw new Error('persisted session token is invalid')
  }
  if (saved.authenticationMethod !== 'password' && saved.authenticationMethod !== 'login-token') {
    throw new Error('persisted session authenticationMethod is invalid')
  }
  const session: StoredSessionV2 = {
    token: saved.token,
    authenticationMethod: saved.authenticationMethod,
    createdAt: timestamp(saved.createdAt, 'persisted session createdAt'),
    lastSeenAt: timestamp(saved.lastSeenAt, 'persisted session lastSeenAt'),
    expiresAt: timestamp(saved.expiresAt, 'persisted session expiresAt'),
  }
  if (session.createdAt > session.lastSeenAt || session.lastSeenAt > session.expiresAt) {
    throw new Error('persisted session timestamps are inconsistent')
  }
  return session
}

function storedSession(value: unknown): StoredSession {
  const saved = object(value, 'persisted session')
  exactKeys(
    saved,
    ['token', 'accountId', 'accountAuthVersion', 'authenticationMethod', 'createdAt', 'lastSeenAt', 'expiresAt'],
    'persisted session',
  )
  const session = {
    ...storedSessionV2({
      token: saved.token,
      authenticationMethod: saved.authenticationMethod,
      createdAt: saved.createdAt,
      lastSeenAt: saved.lastSeenAt,
      expiresAt: saved.expiresAt,
    }),
    accountId: accountId(saved.accountId, 'persisted session accountId'),
    accountAuthVersion: authVersion(saved.accountAuthVersion, 'persisted session accountAuthVersion'),
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

/** Construct a v3 authentication document for installer-created state. */
export function createAuthStateDocument(
  secretId: string,
  initial?: { readonly username: string; readonly passwordHash: string; readonly configuredAt: number },
): AuthStateDocument {
  if (initial !== undefined) parsePasswordHash(initial.passwordHash)
  const admin: AccountState = initial === undefined
    ? {
        id: 'admin',
        username: null,
        passwordHash: null,
        role: 'admin',
        status: 'pending',
        authVersion: 1,
        createdAt: 0,
        configuredAt: null,
      }
    : {
        id: 'admin',
        username: initial.username,
        passwordHash: initial.passwordHash,
        role: 'admin',
        status: 'active',
        authVersion: 1,
        createdAt: initial.configuredAt,
        configuredAt: initial.configuredAt,
      }
  return { schemaVersion: AUTH_STATE_VERSION, secretId, accountMode: 'single', accounts: [admin], sessions: [] }
}

function accountFromAdministrator(saved: AdministratorState): AccountState {
  const configured = saved.username !== null && saved.passwordHash !== null && saved.configuredAt !== null
  return {
    id: 'admin',
    username: saved.username,
    passwordHash: saved.passwordHash,
    role: 'admin',
    status: configured ? 'active' : 'pending',
    authVersion: 1,
    createdAt: saved.configuredAt ?? 0,
    configuredAt: saved.configuredAt,
  }
}

function assertSecretAndSessions(raw: Record<string, unknown>): void {
  if (typeof raw.secretId !== 'string' || !SESSION_TOKEN_PATTERN.test(raw.secretId) || !Array.isArray(raw.sessions)) {
    throw new Error('authStateFile has invalid metadata')
  }
  if (raw.sessions.length > MAX_STORED_SESSIONS) throw new Error('authStateFile contains too many sessions')
}

function assertUniqueSessions(sessions: readonly { readonly token: string }[]): void {
  if (new Set(sessions.map(session => session.token)).size !== sessions.length) {
    throw new Error('authStateFile contains a duplicate session')
  }
}

function validateDocument(document: AuthStateDocument): void {
  if (document.accounts.length === 0 || document.accounts.length > MAX_AUTH_ACCOUNTS) {
    throw new Error('authStateFile contains an invalid account count')
  }
  const ids = new Set(document.accounts.map(entry => entry.id))
  if (ids.size !== document.accounts.length || !ids.has('admin')) {
    throw new Error('authStateFile contains invalid account ids')
  }
  const admins = document.accounts.filter(entry => entry.role === 'admin')
  if (admins.length !== 1 || admins[0]?.id !== 'admin') throw new Error('authStateFile must contain exactly one admin account')
  const names = new Set<string>()
  for (const entry of document.accounts) {
    if (entry.username === null) continue
    const normalized = entry.username.normalize('NFC').toLocaleLowerCase('en-US')
    if (names.has(normalized)) throw new Error('authStateFile contains a duplicate account username')
    names.add(normalized)
  }
  for (const session of document.sessions) {
    const sessionAccount = document.accounts.find(entry => entry.id === session.accountId)
    if (sessionAccount === undefined) throw new Error('authStateFile contains a session for an unknown account')
    if (session.accountAuthVersion !== sessionAccount.authVersion) {
      throw new Error('authStateFile contains a session with an inconsistent account version')
    }
  }
}

function parseV2Document(raw: Record<string, unknown>, secretId?: string): AuthStateDocument {
  exactKeys(raw, ['schemaVersion', 'secretId', 'administrator', 'sessions'], 'authStateFile')
  assertSecretAndSessions(raw)
  if (typeof raw.secretId !== 'string' || !Array.isArray(raw.sessions)) throw new Error('authStateFile has invalid metadata')
  const rawSecretId = raw.secretId
  const sessions = raw.sessions.map(storedSessionV2)
  assertUniqueSessions(sessions)
  const admin = accountFromAdministrator(administrator(raw.administrator))
  const effectiveSecretId = secretId ?? rawSecretId
  const document: AuthStateDocument = {
    schemaVersion: AUTH_STATE_VERSION,
    secretId: effectiveSecretId,
    accountMode: 'single',
    accounts: [admin],
    sessions: rawSecretId === effectiveSecretId
      ? sessions.map(session => ({ ...session, accountId: 'admin', accountAuthVersion: admin.authVersion }))
      : [],
  }
  validateDocument(document)
  return document
}

function parseV3Document(raw: Record<string, unknown>, secretId?: string): AuthStateDocument {
  exactKeys(raw, ['schemaVersion', 'secretId', 'accountMode', 'accounts', 'sessions'], 'authStateFile')
  assertSecretAndSessions(raw)
  if (typeof raw.secretId !== 'string' || !Array.isArray(raw.sessions)) throw new Error('authStateFile has invalid metadata')
  const rawSecretId = raw.secretId
  if (raw.accountMode !== 'single' && raw.accountMode !== 'trusted-team-preview') {
    throw new Error('authStateFile accountMode is invalid')
  }
  if (!Array.isArray(raw.accounts)) throw new Error('authStateFile accounts must be an array')
  const sessions = raw.sessions.map(storedSession)
  assertUniqueSessions(sessions)
  const document: AuthStateDocument = {
    schemaVersion: AUTH_STATE_VERSION,
    secretId: secretId ?? rawSecretId,
    accountMode: raw.accountMode,
    accounts: raw.accounts.map(account),
    sessions: rawSecretId === (secretId ?? rawSecretId) ? sessions : [],
  }
  validateDocument(document)
  return document
}

/** Strictly parse v2 or v3 authentication JSON into the normalized v3 runtime document. */
export function parseAuthStateDocument(value: unknown, secretId?: string): AuthStateDocument {
  const raw = object(value, 'authStateFile')
  if (raw.schemaVersion === 2) return parseV2Document(raw, secretId)
  if (raw.schemaVersion === AUTH_STATE_VERSION) return parseV3Document(raw, secretId)
  throw new Error('authStateFile has an unsupported schemaVersion')
}

export function loadAuthState(path: string, secretId: string): LoadedAuthState {
  const raw = readDocument(path)
  if (raw === undefined) throw new Error('authStateFile is missing')
  const document = parseAuthStateDocument(raw, secretId)
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
