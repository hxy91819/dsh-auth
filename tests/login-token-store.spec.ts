import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as ts from 'typescript'
import { NodeInstallerHost } from '../src/installer/host.js'
import { LoginTokenError, LoginTokenStore, type TokenStoreHost } from '../src/login-token-store.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tokenDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-auth-token-store-'))
  roots.push(root)
  const directory = join(root, 'login-tokens')
  mkdirSync(directory, { mode: 0o700 })
  chmodSync(directory, 0o700)
  return directory
}

function storeFor(directory: string, now: () => number, random?: () => Buffer, host: TokenStoreHost = new NodeInstallerHost()): LoginTokenStore {
  return new LoginTokenStore({ host, directory, now, ...(random === undefined ? {} : { random }) })
}

function digestOf(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function expectStoreFailure(action: () => unknown): LoginTokenError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(LoginTokenError)
    return error as LoginTokenError
  }
  throw new Error('expected the store to fail')
}

class SwapBeforeOpenHost extends NodeInstallerHost {
  override readOpenFile(path: string, maxBytes: number): ReturnType<NodeInstallerHost['readOpenFile']> {
    try {
      const target = `${path}.swapped`
      const current = readFileSync(path)
      writeFileSync(target, current, { mode: 0o600 })
      chmodSync(target, 0o600)
      unlinkSync(path)
      symlinkSync(target, path)
    } catch {
      // If the path is already a symlink or missing, the real open still fail-closes.
    }
    return super.readOpenFile(path, maxBytes)
  }
}

class FaultyTokenHost extends NodeInstallerHost {
  private remaining: number

  constructor(private readonly failing: 'writeNewFile' | 'renameFile', times: number) {
    super()
    this.remaining = times
  }

  override writeNewFile(path: string, content: string | Buffer, mode: number): void {
    if (this.failing === 'writeNewFile' && this.remaining > 0 && !path.endsWith('.dsh_otl_v1_issue.lock')) {
      this.remaining -= 1
      throw new Error('synthetic token write failure')
    }
    super.writeNewFile(path, content, mode)
  }

  override renameFile(from: string, to: string): void {
    if (this.failing === 'renameFile' && this.remaining > 0) {
      this.remaining -= 1
      throw new Error('synthetic token rename failure')
    }
    super.renameFile(from, to)
  }
}

describe('login token store', () => {
  it('issues digest-named metadata files without writing the raw token', () => {
    const directory = tokenDirectory()
    const issued = storeFor(directory, () => 0).issue({ ttlSeconds: 300 })

    expect(issued.token).toMatch(/^dsh_otl_v1_[A-Za-z0-9_-]{43}$/u)
    expect(issued.issuedAt).toBe(0)
    expect(issued.expiresAt - issued.issuedAt).toBe(300_000)
    const path = join(directory, digestOf(issued.token))
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify({ schemaVersion: 1, issuedAt: 0, expiresAt: 300_000 })}\n`)
    expect(readFileSync(path, 'utf8')).not.toContain(issued.token)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(directory)).toHaveLength(1)
  })

  it('rejects TTL values outside the frozen range before touching the directory', () => {
    const directory = tokenDirectory()
    const subject = storeFor(directory, () => 0)
    for (const ttlSeconds of [59, 301, 60.5, Number.NaN]) {
      expect(expectStoreFailure((): void => { subject.issue({ ttlSeconds }) }).kind).toBe('usage')
    }
    expect(readdirSync(directory)).toHaveLength(0)
  })

  it('caps unexpired tokens at 32 and frees capacity after expiry', () => {
    const directory = tokenDirectory()
    let clock = 0
    let counter = 0
    const subject = storeFor(directory, () => clock, (): Buffer => {
      counter += 1
      return Buffer.alloc(32, counter)
    })
    for (let index = 0; index < 32; index += 1) subject.issue({ ttlSeconds: 60 })
    expect(expectStoreFailure((): void => { subject.issue({ ttlSeconds: 60 }) }).kind).toBe('capacity')

    clock = 60_000
    const fresh = subject.issue({ ttlSeconds: 300 })
    expect(readdirSync(directory)).toEqual([digestOf(fresh.token)])
  })

  it('cleans only strictly named expired managed files', () => {
    const directory = tokenDirectory()
    writeFileSync(join(directory, 'zzz-operator-file'), 'keep\n')
    writeFileSync(join(directory, '.dsh_otl_v1_tmp_deadbeef'), 'stale temp\n')
    writeFileSync(join(directory, 'g'.repeat(64)), 'uppercase lookalike\n')
    writeFileSync(join(directory, '.dsh_otl_v1_consuming_zzz'), 'unknown consuming lookalike\n')
    let clock = 0
    const subject = storeFor(directory, () => clock)
    const issued = subject.issue({ ttlSeconds: 60 })

    clock = 60_000
    subject.issue({ ttlSeconds: 60 })
    const names = readdirSync(directory)
    expect(names).toContain('zzz-operator-file')
    expect(names).toContain('.dsh_otl_v1_tmp_deadbeef')
    expect(names).toContain('g'.repeat(64))
    expect(names).toContain('.dsh_otl_v1_consuming_zzz')
    expect(names).not.toContain(digestOf(issued.token))
  })

  it('treats an unparseable managed file as a safe conflict without deleting it', () => {
    const directory = tokenDirectory()
    const corrupt = 'c'.repeat(64)
    writeFileSync(join(directory, corrupt), '{broken\n', { mode: 0o600 })
    const oversized = 'd'.repeat(64)
    writeFileSync(join(directory, oversized), `${JSON.stringify({ schemaVersion: 1, issuedAt: 0, expiresAt: 60_000, extra: true })}\n`, { mode: 0o600 })

    const subject = storeFor(directory, () => 0)
    expect(expectStoreFailure((): void => { subject.issue({ ttlSeconds: 60 }) }).kind).toBe('conflict')
    expect(readFileSync(join(directory, corrupt), 'utf8')).toBe('{broken\n')
    expect(readFileSync(join(directory, oversized), 'utf8')).toContain('extra')
  })

  it('regenerates on digest collision and fails once retries are exhausted', () => {
    const directory = tokenDirectory()
    const first = Buffer.alloc(32, 7)
    const second = Buffer.alloc(32, 9)
    const sequence = [first, first, second]
    const subject = storeFor(directory, () => 0, (): Buffer => sequence.shift() ?? second)
    const one = subject.issue({ ttlSeconds: 60 })
    const two = subject.issue({ ttlSeconds: 60 })
    expect(one.token).not.toBe(two.token)
    expect(readdirSync(directory)).toHaveLength(2)

    const stuck = storeFor(directory, () => 0, (): Buffer => first)
    expect(expectStoreFailure((): void => { stuck.issue({ ttlSeconds: 60 }) }).kind).toBe('execution')
    expect(readdirSync(directory)).toHaveLength(2)
  })

  it('leaves no file behind when the metadata write fails', () => {
    const directory = tokenDirectory()
    const subject = storeFor(directory, () => 0, undefined, new FaultyTokenHost('writeNewFile', 1))
    expect(expectStoreFailure((): void => { subject.issue({ ttlSeconds: 60 }) }).kind).toBe('execution')
    expect(readdirSync(directory)).toHaveLength(0)
  })

  it('cleans the temporary file and keeps prior tokens when rename fails', () => {
    const directory = tokenDirectory()
    storeFor(directory, () => 0).issue({ ttlSeconds: 60 })
    const subject = storeFor(directory, () => 0, undefined, new FaultyTokenHost('renameFile', 1))
    expect(expectStoreFailure((): void => { subject.issue({ ttlSeconds: 60 }) }).kind).toBe('execution')
    const names = readdirSync(directory)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('claims a token exactly once and invalidates expired or unknown tokens', () => {
    const directory = tokenDirectory()
    let clock = 0
    const subject = storeFor(directory, () => clock)
    const issued = subject.issue({ ttlSeconds: 60 })

    const claim = subject.claim(issued.token)
    if (claim.status !== 'claimed') throw new Error('expected the first claim to succeed')
    expect(claim.issuedAt).toBe(0)
    expect(claim.expiresAt).toBe(60_000)
    expect(subject.claim(issued.token).status).toBe('invalid')
    expect(readdirSync(directory)).toEqual([`.dsh_otl_v1_consuming_${digestOf(issued.token)}`])
    subject.releaseClaim(claim)
    expect(readdirSync(directory)).toHaveLength(0)

    clock = 60_000
    const second = subject.issue({ ttlSeconds: 60 })
    expect(subject.claim('not-a-login-token').status).toBe('invalid')
    expect(subject.claim(`dsh_otl_v1_${'A'.repeat(43)}`).status).toBe('invalid')
    clock = 120_000
    expect(subject.claim(second.token).status).toBe('invalid')
    expect(readdirSync(directory)).toHaveLength(0)
  })

  it('publishes owned metadata for the service user', () => {
    const processEuid = process.geteuid?.()
    if (processEuid !== 0) return
    const directory = tokenDirectory()
    const issued = storeFor(directory, () => 0).issue({ ttlSeconds: 60, owner: { uid: 4242, gid: 4243 } })
    expect(statSync(join(directory, digestOf(issued.token)))).toMatchObject({ uid: 4242, gid: 4243 })
  })

  it('supports concurrent issuers without overwriting existing tokens', () => {
    const directory = tokenDirectory()
    const clock = 0
    const left = storeFor(directory, () => clock, (): Buffer => Buffer.alloc(32, 21))
    const right = storeFor(directory, () => clock, (): Buffer => Buffer.alloc(32, 22))
    const first = left.issue({ ttlSeconds: 60 })
    const second = right.issue({ ttlSeconds: 60 })
    expect(readdirSync(directory).sort()).toEqual([digestOf(first.token), digestOf(second.token)].sort())
    expect(readFileSync(join(directory, digestOf(first.token)), 'utf8')).toContain('"expiresAt":60000')
  })

  it('keeps at most 32 valid tokens when 96 processes issue concurrently', async () => {
    const directory = tokenDirectory()
    const compiled = compileIssueWorker(directory)
    const results = await Promise.all(Array.from({ length: 96 }, () => issueInChild(compiled.worker, directory)))
    const names = readdirSync(directory)
    expect(results.filter(result => result === 'ok')).toHaveLength(32)
    expect(results.filter(result => result === 'capacity')).toHaveLength(64)
    expect(names).toHaveLength(32)
    expect(names.every(name => /^[0-9a-f]{64}$/u.test(name))).toBe(true)
  }, 30_000)
})

describe('login token store filesystem safety', () => {
  it('refuses unsafe token directories before issue or claim', () => {
    const missingRoot = mkdtempSync(join(tmpdir(), 'dsh-auth-token-missing-'))
    roots.push(missingRoot)
    const missing = join(missingRoot, 'login-tokens')
    expect(expectStoreFailure((): void => { storeFor(missing, () => 0).issue({ ttlSeconds: 60 }) }).code).toBe('LOGIN_TOKEN_DIRECTORY_INVALID')

    const fileAsDirectory = tokenDirectory()
    const asFile = join(fileAsDirectory, 'not-a-dir')
    writeFileSync(asFile, 'nope\n', { mode: 0o700 })
    const fileStore = new LoginTokenStore({ host: new NodeInstallerHost(), directory: asFile, now: () => 0 })
    expect(expectStoreFailure((): void => { fileStore.issue({ ttlSeconds: 60 }) }).code).toBe('LOGIN_TOKEN_DIRECTORY_INVALID')

    const linkedRoot = mkdtempSync(join(tmpdir(), 'dsh-auth-token-dirlink-'))
    roots.push(linkedRoot)
    const realDirectory = join(linkedRoot, 'real')
    mkdirSync(realDirectory, { mode: 0o700 })
    chmodSync(realDirectory, 0o700)
    const linked = join(linkedRoot, 'login-tokens')
    symlinkSync(realDirectory, linked)
    expect(expectStoreFailure((): void => { storeFor(linked, () => 0).issue({ ttlSeconds: 60 }) }).code).toBe('LOGIN_TOKEN_DIRECTORY_INVALID')

    const wide = tokenDirectory()
    chmodSync(wide, 0o777)
    expect(expectStoreFailure((): void => { storeFor(wide, () => 0).issue({ ttlSeconds: 60 }) }).code).toBe('LOGIN_TOKEN_DIRECTORY_INVALID')
    chmodSync(wide, 0o770)
    expect(expectStoreFailure((): void => { storeFor(wide, () => 0).issue({ ttlSeconds: 60 }) }).code).toBe('LOGIN_TOKEN_DIRECTORY_INVALID')
  })

  it('does not issue or claim digest-named symlinks, wide files, or non-files', () => {
    const directory = tokenDirectory()
    const metadata = `${JSON.stringify({ schemaVersion: 1, issuedAt: 0, expiresAt: 60_000 })}\n`
    const linked = 'a'.repeat(64)
    const target = join(directory, 'safe-target')
    writeFileSync(target, metadata, { mode: 0o600 })
    chmodSync(target, 0o600)
    symlinkSync(target, join(directory, linked))
    expect(expectStoreFailure((): void => { storeFor(directory, () => 0).issue({ ttlSeconds: 60 }) }).code).toBe('LOGIN_TOKEN_FILE_INVALID')
    expect(expectStoreFailure((): void => { storeFor(directory, () => 0).claim(`dsh_otl_v1_${'A'.repeat(43)}`) }).code).toBe('LOGIN_TOKEN_FILE_INVALID')
    expect(readdirSync(directory)).toContain(linked)

    unlinkSync(join(directory, linked))
    unlinkSync(target)
    const wide = 'b'.repeat(64)
    writeFileSync(join(directory, wide), metadata, { mode: 0o644 })
    chmodSync(join(directory, wide), 0o644)
    expect(expectStoreFailure((): void => { storeFor(directory, () => 0).issue({ ttlSeconds: 60 }) }).code).toBe('LOGIN_TOKEN_FILE_INVALID')
    expect(readFileSync(join(directory, wide), 'utf8')).toBe(metadata)

    unlinkSync(join(directory, wide))
    const asDirectory = 'c'.repeat(64)
    mkdirSync(join(directory, asDirectory), { mode: 0o700 })
    expect(expectStoreFailure((): void => { storeFor(directory, () => 0).issue({ ttlSeconds: 60 }) }).code).toBe('LOGIN_TOKEN_FILE_INVALID')
    expect(statSync(join(directory, asDirectory)).isDirectory()).toBe(true)
  })

  it('fails closed when a managed file is replaced with a symlink before the descriptor read', () => {
    const directory = tokenDirectory()
    const issued = storeFor(directory, () => 0).issue({ ttlSeconds: 60 })
    const subject = storeFor(directory, () => 0, undefined, new SwapBeforeOpenHost())
    expect(expectStoreFailure((): void => { subject.claim(issued.token) }).code).toBe('LOGIN_TOKEN_FILE_INVALID')
    expect(expectStoreFailure((): void => { subject.issue({ ttlSeconds: 60 }) }).code).toBe('LOGIN_TOKEN_FILE_INVALID')
  })

  it('rejects a token file owned by another user', () => {
    if (process.geteuid?.() !== 0) return
    const directory = tokenDirectory()
    const issued = storeFor(directory, () => 0).issue({ ttlSeconds: 60 })
    const path = join(directory, digestOf(issued.token))
    chownSync(path, 4242, 4243)
    expect(expectStoreFailure((): void => { storeFor(directory, () => 0).issue({ ttlSeconds: 60 }) }).code).toBe('LOGIN_TOKEN_FILE_INVALID')
    expect(expectStoreFailure((): void => { storeFor(directory, () => 0).claim(issued.token) }).code).toBe('LOGIN_TOKEN_FILE_INVALID')
  })
})

function compileIssueWorker(directory: string): { readonly worker: string } {
  const root = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(root, '../src/login-token-store.ts'), 'utf8')
  const emitted = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'login-token-store.ts',
  }).outputText
  const storePath = join(directory, '..', 'login-token-store.mjs')
  const workerPath = join(directory, '..', 'issue-worker.mjs')
  writeFileSync(storePath, emitted)
  writeFileSync(workerPath, `import { LoginTokenError, LoginTokenStore, createNodeTokenHost } from ${JSON.stringify(pathToFileURL(storePath).href)}
try {
  new LoginTokenStore({ host: createNodeTokenHost(), directory: process.argv[2] }).issue({ ttlSeconds: 60 })
  process.stdout.write('ok\\n')
} catch (error) {
  if (error instanceof LoginTokenError) process.stdout.write(\`\${error.kind}\\n\`)
  else throw error
}
`)
  return { worker: workerPath }
}

function issueInChild(worker: string, directory: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, directory], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) reject(new Error(`issue worker exited ${String(code)}: ${stderr}`))
      else resolve(stdout.trim())
    })
  })
}
