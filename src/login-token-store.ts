import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, chownSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Versioned bearer prefix that separates this token format from future revisions. */
const LOGIN_TOKEN_PREFIX = 'dsh_otl_v1_'

/** Complete textual shape of a v1 login token. */
const LOGIN_TOKEN_PATTERN = /^dsh_otl_v1_[A-Za-z0-9_-]{43}$/u

/** Allowed issue TTL in seconds, inclusive on both ends. */
const LOGIN_TOKEN_TTL_SECONDS = { min: 60, max: 300 } as const

/** Maximum number of unexpired token and consuming files kept in the directory. */
const LOGIN_TOKEN_CAPACITY = 32

const TOKEN_DIGEST_PATTERN = /^[0-9a-f]{64}$/u
const CONSUMING_PREFIX = '.dsh_otl_v1_consuming_'
const TEMP_PREFIX = '.dsh_otl_v1_tmp_'
const ISSUE_LOCK_NAME = '.dsh_otl_v1_issue.lock'
const ISSUE_LOCK_RETRY_MS = 15
const ISSUE_LOCK_ACQUIRE_MS = 10_000
const MAX_TOKEN_FILE_BYTES = 512
const MAX_GENERATION_ATTEMPTS = 8
const TOKEN_FILE_MODE = 0o600

export type LoginTokenErrorKind = 'usage' | 'conflict' | 'capacity' | 'execution'

/** Store failure carrying the exit-code class the CLI must report. */
export class LoginTokenError extends Error {
  constructor(
    readonly kind: LoginTokenErrorKind,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Descriptor-backed directory metadata; the last path component is not followed. */
export interface InspectedTokenDirectory {
  readonly uid: number
  readonly gid: number
  readonly mode: number
}

/** Descriptor-backed regular-file contents; the last path component is not followed. */
export interface OpenedTokenFile {
  readonly content: string
  readonly uid: number
  readonly gid: number
  readonly mode: number
  readonly size: number
}

/** Filesystem port shared with the installer host; no installer import required. */
export interface TokenStoreHost {
  listDirectory(path: string): readonly string[]
  fileExists(path: string): boolean
  stat(path: string): { readonly uid: number; readonly gid: number; readonly mode: number; readonly size: number; readonly isDirectory: boolean }
  inspectDirectory(path: string): InspectedTokenDirectory
  readFile(path: string): string
  readOpenFile(path: string, maxBytes: number): OpenedTokenFile
  writeNewFile(path: string, content: string | Buffer, mode: number): void
  renameFile(from: string, to: string): void
  chmod(path: string, mode: number): void
  chown(path: string, uid: number, gid: number): void
  removeFile(path: string): void
  randomBytes(size: number): Buffer
  fsyncFile?(path: string): void
  fsyncDirectory?(path: string): void
}

export interface IssuedLoginToken {
  readonly token: string
  readonly issuedAt: number
  readonly expiresAt: number
}

export type LoginTokenClaim =
  | { readonly status: 'claimed'; readonly digest: string; readonly issuedAt: number; readonly expiresAt: number }
  | { readonly status: 'invalid' }

export interface LoginTokenStoreOptions {
  readonly host: TokenStoreHost
  readonly directory: string
  readonly now?: () => number
  readonly random?: () => Buffer
}

function systemErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function throwSafeFsError(error: unknown, fallback: string): never {
  if (error instanceof Error && systemErrorCode(error) === undefined) throw error
  const code = systemErrorCode(error)
  if (code === 'ELOOP') throw new Error('symbolic links are not allowed')
  throw new Error(fallback)
}

function noFollowFlags(extra = 0): number {
  const nonblock = process.platform === 'win32' ? 0 : constants.O_NONBLOCK
  return extra | constants.O_RDONLY | nonblock | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
}

/** Open a directory without following a final symlink and return its owner and mode. */
export function inspectTokenDirectory(path: string): InspectedTokenDirectory {
  let descriptor: number | undefined
  try {
    if (process.platform === 'win32' && lstatSync(path).isSymbolicLink()) throw new Error('not a real directory')
    descriptor = openSync(path, noFollowFlags(constants.O_DIRECTORY))
    const stat = fstatSync(descriptor)
    if (!stat.isDirectory()) throw new Error('not a real directory')
    closeSync(descriptor)
    descriptor = undefined
    return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    throwSafeFsError(error, 'not a real directory')
  }
}

/** Open a regular file without following a final symlink, then fstat and bound-read that descriptor. */
export function readOpenTokenFile(path: string, maxBytes: number): OpenedTokenFile {
  let descriptor: number | undefined
  try {
    if (process.platform === 'win32' && lstatSync(path).isSymbolicLink()) throw new Error('not a regular file')
    descriptor = openSync(path, noFollowFlags())
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('not a regular file')
    if (stat.size === 0 || stat.size > maxBytes) throw new Error('unexpected size')
    const buffer = Buffer.alloc(maxBytes + 1)
    const bytes = readSync(descriptor, buffer, 0, maxBytes + 1, 0)
    if (bytes === 0 || bytes > maxBytes) throw new Error('unexpected size')
    closeSync(descriptor)
    descriptor = undefined
    return {
      content: buffer.toString('utf8', 0, bytes),
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode & 0o7777,
      size: stat.size,
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    throwSafeFsError(error, 'not a regular file')
  }
}

/** Real-filesystem host used by the running plugin process, independent of the installer CLI. */
export function createNodeTokenHost(): TokenStoreHost {
  return {
    listDirectory(path) {
      return readdirSync(path)
    },
    fileExists(path) {
      return existsSync(path)
    },
    stat(path) {
      const value = lstatSync(path)
      return { uid: value.uid, gid: value.gid, mode: value.mode & 0o7777, size: value.size, isDirectory: value.isDirectory() }
    },
    inspectDirectory: inspectTokenDirectory,
    readFile(path) {
      return readFileSync(path, 'utf8')
    },
    readOpenFile: readOpenTokenFile,
    writeNewFile(path, content, mode) {
      const descriptor = openSync(path, 'wx', mode)
      try {
        writeFileSync(descriptor, content)
      } finally {
        closeSync(descriptor)
      }
    },
    renameFile(from, to) {
      renameSync(from, to)
    },
    chmod(path, mode) {
      chmodSync(path, mode)
    },
    chown(path, uid, gid) {
      chownSync(path, uid, gid)
    },
    removeFile(path) {
      try {
        unlinkSync(path)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    },
    randomBytes(size) {
      return randomBytes(size)
    },
    fsyncFile(path) {
      syncDescriptor(path, constants.O_RDONLY)
    },
    fsyncDirectory(path) {
      syncDescriptor(path, constants.O_RDONLY | constants.O_DIRECTORY)
    },
  }
}

function syncDescriptor(path: string, flags: number): void {
  const descriptor = openSync(path, flags)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

interface LoginTokenMetadata {
  readonly issuedAt: number
  readonly expiresAt: number
}

function digestHex(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function base64url(value: Buffer): string {
  return value.toString('base64url')
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function parseMetadata(raw: string): LoginTokenMetadata {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new LoginTokenError('conflict', 'LOGIN_TOKEN_FILE_INVALID', 'a managed login token file is not valid JSON')
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new LoginTokenError('conflict', 'LOGIN_TOKEN_FILE_INVALID', 'a managed login token file has an unsupported format')
  }
  const record = decoded as Record<string, unknown>
  if (record.schemaVersion !== 1 || !exactKeys(record, ['schemaVersion', 'issuedAt', 'expiresAt'])) {
    throw new LoginTokenError('conflict', 'LOGIN_TOKEN_FILE_INVALID', 'a managed login token file has unknown or missing fields')
  }
  const issuedAt = record.issuedAt
  const expiresAt = record.expiresAt
  if (typeof issuedAt !== 'number' || typeof expiresAt !== 'number' || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || issuedAt < 0) {
    throw new LoginTokenError('conflict', 'LOGIN_TOKEN_FILE_INVALID', 'a managed login token file has unsafe timestamps')
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > LOGIN_TOKEN_TTL_SECONDS.max * 1000) {
    throw new LoginTokenError('conflict', 'LOGIN_TOKEN_FILE_INVALID', 'a managed login token file has an inverted or oversized lifetime')
  }
  return { issuedAt, expiresAt }
}

function serializeMetadata(metadata: LoginTokenMetadata): string {
  return `${JSON.stringify({ schemaVersion: 1, issuedAt: metadata.issuedAt, expiresAt: metadata.expiresAt })}\n`
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return systemErrorCode(error) !== 'ESRCH'
  }
}

interface ManagedEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'token' | 'consuming'
  readonly digest: string
}

/** Digest-named, expiring, capacity-bounded one-time login token store. */
export class LoginTokenStore {
  private readonly host: TokenStoreHost
  private readonly directory: string
  private readonly now: () => number
  private readonly random: () => Buffer

  constructor(options: LoginTokenStoreOptions) {
    this.host = options.host
    this.directory = options.directory
    this.now = options.now ?? ((): number => Date.now())
    this.random = options.random ?? ((): Buffer => options.host.randomBytes(32))
  }

  /** Atomically publish one new token file; the raw token never touches disk. */
  issue(input: { readonly ttlSeconds: number; readonly owner?: { readonly uid: number; readonly gid: number } }): IssuedLoginToken {
    const ttlSeconds = input.ttlSeconds
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < LOGIN_TOKEN_TTL_SECONDS.min || ttlSeconds > LOGIN_TOKEN_TTL_SECONDS.max) {
      throw new LoginTokenError('usage', 'LOGIN_TOKEN_TTL_INVALID', `login token TTL must be ${String(LOGIN_TOKEN_TTL_SECONDS.min)}-${String(LOGIN_TOKEN_TTL_SECONDS.max)} seconds`)
    }
    this.requireDirectory()
    return this.withIssueLock(() => this.publishIssuedToken(input.ttlSeconds, input.owner))
  }

  private publishIssuedToken(ttlSeconds: number, requestedOwner: { readonly uid: number; readonly gid: number } | undefined): IssuedLoginToken {
    const issuedAt = this.now()
    const expiresAt = issuedAt + ttlSeconds * 1000
    const owner = this.requireDirectory()
    this.cleanExpired(issuedAt, owner)
    if (this.countActive(issuedAt, owner) >= LOGIN_TOKEN_CAPACITY) {
      throw new LoginTokenError('capacity', 'LOGIN_TOKEN_CAPACITY_EXCEEDED', `the login token directory already holds ${String(LOGIN_TOKEN_CAPACITY)} unexpired tokens`)
    }
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const token = `${LOGIN_TOKEN_PREFIX}${base64url(this.random())}`
      const digest = digestHex(token)
      const path = join(this.directory, digest)
      if (this.host.fileExists(path)) continue
      const temporary = join(this.directory, `${TEMP_PREFIX}${this.host.randomBytes(8).toString('hex')}`)
      try {
        this.host.writeNewFile(temporary, serializeMetadata({ issuedAt, expiresAt }), TOKEN_FILE_MODE)
        this.host.fsyncFile?.(temporary)
        if (requestedOwner !== undefined) this.host.chown(temporary, requestedOwner.uid, requestedOwner.gid)
      } catch {
        this.removeQuietly(temporary)
        throw new LoginTokenError('execution', 'LOGIN_TOKEN_WRITE_FAILED', 'login token metadata could not be written')
      }
      try {
        this.host.renameFile(temporary, path)
      } catch {
        this.removeQuietly(temporary)
        throw new LoginTokenError('execution', 'LOGIN_TOKEN_PUBLISH_FAILED', 'login token metadata could not be published')
      }
      try {
        this.host.fsyncDirectory?.(this.directory)
      } catch {
        throw new LoginTokenError('execution', 'LOGIN_TOKEN_SYNC_FAILED', 'the login token directory could not be synced')
      }
      return { token, issuedAt, expiresAt }
    }
    throw new LoginTokenError('execution', 'LOGIN_TOKEN_GENERATION_EXHAUSTED', 'login token generation could not avoid an existing digest')
  }

  /** Serialize capacity check and publish so concurrent CLI processes cannot exceed 32. */
  private withIssueLock<T>(run: () => T): T {
    const lockPath = join(this.directory, ISSUE_LOCK_NAME)
    const payload = this.acquireIssueLock(lockPath)
    try {
      return run()
    } finally {
      this.releaseIssueLock(lockPath, payload)
    }
  }

  private acquireIssueLock(lockPath: string): string {
    const deadline = Date.now() + ISSUE_LOCK_ACQUIRE_MS
    while (Date.now() <= deadline) {
      const payload = `${String(process.pid)}\n${this.host.randomBytes(8).toString('hex')}\n`
      try {
        this.host.writeNewFile(lockPath, payload, TOKEN_FILE_MODE)
        return payload
      } catch (error) {
        if (systemErrorCode(error) !== 'EEXIST') {
          throw new LoginTokenError('execution', 'LOGIN_TOKEN_LOCK_FAILED', 'the login token issue lock could not be created')
        }
      }
      this.reclaimStaleIssueLock(lockPath)
      sleepSync(ISSUE_LOCK_RETRY_MS)
    }
    throw new LoginTokenError('execution', 'LOGIN_TOKEN_LOCK_FAILED', 'the login token issue lock could not be acquired')
  }

  private reclaimStaleIssueLock(lockPath: string): void {
    let current: string
    try {
      current = this.host.readFile(lockPath)
    } catch {
      return
    }
    const pidLine = current.split('\n', 1)[0]
    const pid = pidLine === undefined ? Number.NaN : Number(pidLine)
    if (!Number.isInteger(pid) || pid <= 0 || processExists(pid)) return
    let confirmed: string
    try {
      confirmed = this.host.readFile(lockPath)
    } catch {
      return
    }
    if (confirmed === current) this.removeQuietly(lockPath)
  }

  private releaseIssueLock(lockPath: string, payload: string): void {
    try {
      if (this.host.readFile(lockPath) === payload) this.host.removeFile(lockPath)
    } catch {
      this.removeQuietly(lockPath)
    }
  }

  /** Atomically claim one token for redemption; leftover claims stay consumed. */
  claim(token: string): LoginTokenClaim {
    if (!LOGIN_TOKEN_PATTERN.test(token)) return { status: 'invalid' }
    const now = this.now()
    const owner = this.requireDirectory()
    this.cleanExpired(now, owner)
    const digest = digestHex(token)
    const path = join(this.directory, digest)
    const consumingPath = join(this.directory, `${CONSUMING_PREFIX}${digest}`)
    if (!this.host.fileExists(path)) return { status: 'invalid' }
    try {
      this.host.renameFile(path, consumingPath)
    } catch {
      return { status: 'invalid' }
    }
    let metadata: LoginTokenMetadata
    try {
      metadata = this.readManagedMetadata(consumingPath, owner)
    } catch {
      return { status: 'invalid' }
    }
    if (metadata.expiresAt <= now) return { status: 'invalid' }
    return { status: 'claimed', digest, issuedAt: metadata.issuedAt, expiresAt: metadata.expiresAt }
  }

  /** Drop a finished claim after the session it produced is durable. */
  releaseClaim(claim: Extract<LoginTokenClaim, { status: 'claimed' }>): void {
    this.removeQuietly(join(this.directory, `${CONSUMING_PREFIX}${claim.digest}`))
  }

  /** Remove only strictly named managed files whose recorded expiry has passed. */
  private cleanExpired(now: number, owner: InspectedTokenDirectory): void {
    for (const entry of this.managedEntries()) {
      const metadata = this.readManagedMetadata(entry.path, owner)
      if (metadata.expiresAt <= now) this.host.removeFile(entry.path)
    }
  }

  private countActive(now: number, owner: InspectedTokenDirectory): number {
    let count = 0
    for (const entry of this.managedEntries()) {
      const metadata = this.readManagedMetadata(entry.path, owner)
      if (metadata.expiresAt > now) count += 1
    }
    return count
  }

  private requireDirectory(): InspectedTokenDirectory {
    let directory: InspectedTokenDirectory
    try {
      directory = this.host.inspectDirectory(this.directory)
    } catch {
      throw new LoginTokenError('conflict', 'LOGIN_TOKEN_DIRECTORY_INVALID', 'the login token directory is not a real 0700 directory')
    }
    if (process.platform !== 'win32' && (directory.mode & 0o777) !== 0o700) {
      throw new LoginTokenError('conflict', 'LOGIN_TOKEN_DIRECTORY_INVALID', 'the login token directory is not a real 0700 directory')
    }
    return directory
  }

  private readManagedMetadata(path: string, owner: InspectedTokenDirectory): LoginTokenMetadata {
    let file: OpenedTokenFile
    try {
      file = this.host.readOpenFile(path, MAX_TOKEN_FILE_BYTES)
    } catch (error) {
      if (error instanceof LoginTokenError) throw error
      throw new LoginTokenError('conflict', 'LOGIN_TOKEN_FILE_INVALID', 'a managed login token file is not safe to use')
    }
    if (process.platform !== 'win32' && ((file.mode & 0o777) !== 0o600 || file.uid !== owner.uid || file.gid !== owner.gid)) {
      throw new LoginTokenError('conflict', 'LOGIN_TOKEN_FILE_INVALID', 'a managed login token file is not safe to use')
    }
    if (file.size === 0 || file.size > MAX_TOKEN_FILE_BYTES) {
      throw new LoginTokenError('conflict', 'LOGIN_TOKEN_FILE_INVALID', 'a managed login token file has an unexpected size')
    }
    return parseMetadata(file.content)
  }

  private managedEntries(): readonly ManagedEntry[] {
    const entries: ManagedEntry[] = []
    for (const name of this.host.listDirectory(this.directory)) {
      if (TOKEN_DIGEST_PATTERN.test(name)) {
        entries.push({ name, path: join(this.directory, name), kind: 'token', digest: name })
        continue
      }
      if (name.startsWith(CONSUMING_PREFIX) && TOKEN_DIGEST_PATTERN.test(name.slice(CONSUMING_PREFIX.length))) {
        entries.push({ name, path: join(this.directory, name), kind: 'consuming', digest: name.slice(CONSUMING_PREFIX.length) })
      }
    }
    return entries
  }

  private removeQuietly(path: string): void {
    try {
      if (this.host.fileExists(path)) this.host.removeFile(path)
    } catch {
      // Best-effort cleanup of our own temporary or claim files only.
    }
  }
}
