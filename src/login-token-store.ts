import { createHash } from 'node:crypto'
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

/** Filesystem port shared with the installer host; no installer import required. */
export interface TokenStoreHost {
  listDirectory(path: string): readonly string[]
  fileExists(path: string): boolean
  stat(path: string): { readonly uid: number; readonly gid: number; readonly mode: number; readonly size: number; readonly isDirectory: boolean }
  readFile(path: string): string
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
    const issuedAt = this.now()
    const expiresAt = issuedAt + ttlSeconds * 1000
    this.cleanExpired(issuedAt)
    if (this.countActive(issuedAt) >= LOGIN_TOKEN_CAPACITY) {
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
        if (input.owner !== undefined) this.host.chown(temporary, input.owner.uid, input.owner.gid)
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

  /** Atomically claim one token for redemption; leftover claims stay consumed. */
  claim(token: string): LoginTokenClaim {
    if (!LOGIN_TOKEN_PATTERN.test(token)) return { status: 'invalid' }
    const now = this.now()
    this.cleanExpired(now)
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
      metadata = this.readManagedMetadata(consumingPath)
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
  private cleanExpired(now: number): void {
    for (const entry of this.managedEntries()) {
      const metadata = this.readManagedMetadata(entry.path)
      if (metadata.expiresAt <= now) this.host.removeFile(entry.path)
    }
  }

  private countActive(now: number): number {
    let count = 0
    for (const entry of this.managedEntries()) {
      const metadata = this.readManagedMetadata(entry.path)
      if (metadata.expiresAt > now) count += 1
    }
    return count
  }

  private readManagedMetadata(path: string): LoginTokenMetadata {
    const stat = this.host.stat(path)
    if (stat.size === 0 || stat.size > MAX_TOKEN_FILE_BYTES) {
      throw new LoginTokenError('conflict', 'LOGIN_TOKEN_FILE_INVALID', 'a managed login token file has an unexpected size')
    }
    return parseMetadata(this.host.readFile(path))
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
