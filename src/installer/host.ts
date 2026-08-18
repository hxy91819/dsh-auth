import { randomBytes } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, chmodSync, chownSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { CommandResult, CommandSpec, InstallerHost } from './types.js'
import { inspectTokenDirectory, readOpenTokenFile } from '../login-token-store.js'

function snapshotStat(path: string): ReturnType<InstallerHost['stat']> {
  const value = lstatSync(path)
  return {
    uid: value.uid,
    gid: value.gid,
    mode: value.mode & 0o7777,
    size: value.size,
    isDirectory: value.isDirectory(),
  }
}

/** Real Node.js host implementation for the installer core. */
export class NodeInstallerHost implements InstallerHost {
  readonly platform = process.platform
  readonly arch = process.arch
  readonly effectiveUid = process.geteuid?.()

  run(command: CommandSpec, options?: { readonly env?: NodeJS.ProcessEnv }): CommandResult {
    const result = spawnSync(command.executable, [...command.args], {
      encoding: 'utf8',
      env: options?.env ?? process.env,
      maxBuffer: 1024 * 1024,
    })
    const output: CommandResult = {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }
    return result.error === undefined ? output : { ...output, error: result.error }
  }

  readFile(path: string): string {
    return readFileSync(path, 'utf8')
  }

  readFileBytes(path: string): Buffer {
    return readFileSync(path)
  }

  fileExists(path: string): boolean {
    return existsSync(path)
  }

  regularFile(path: string): boolean {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }

  realpath(path: string): string {
    return realpathSync(path)
  }

  listDirectory(path: string): readonly string[] {
    return readdirSync(path)
  }

  fsyncFile(path: string): void {
    const descriptor = openSync(path, constants.O_RDONLY)
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }

  fsyncDirectory(path: string): void {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }

  stat(path: string): ReturnType<InstallerHost['stat']> {
    return snapshotStat(path)
  }

  inspectDirectory(path: string): ReturnType<InstallerHost['inspectDirectory']> {
    return inspectTokenDirectory(path)
  }

  readOpenFile(path: string, maxBytes: number): ReturnType<InstallerHost['readOpenFile']> {
    return readOpenTokenFile(path, maxBytes)
  }

  mkdir(path: string, mode: number): void {
    mkdirSync(path, { mode })
  }

  writeNewFile(path: string, content: string | Buffer, mode: number): void {
    const descriptor = openSync(path, 'wx', mode)
    try {
      writeFileSync(descriptor, content)
    } finally {
      closeSync(descriptor)
    }
  }

  replaceFile(path: string, content: string, mode: number): void {
    const temporary = join(dirname(path), `.dsh-auth-${randomBytes(8).toString('hex')}.tmp`)
    this.writeNewFile(temporary, content, mode)
    renameSync(temporary, path)
  }

  renameFile(from: string, to: string): void {
    renameSync(from, to)
  }

  chmod(path: string, mode: number): void {
    chmodSync(path, mode)
  }

  chown(path: string, uid: number, gid: number): void {
    chownSync(path, uid, gid)
  }

  removeFile(path: string): void {
    try {
      unlinkSync(path)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }

  removeDirectory(path: string): void {
    try {
      rmdirSync(path)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTEMPTY'))) throw error
    }
  }

  randomBytes(size: number): Buffer {
    return randomBytes(size)
  }

  resolveBundledCaddyRoot(): string {
    return join(fileURLToPath(new URL('../..', import.meta.url)), 'vendor/caddy')
  }

  portBusy(address: string, port: number): boolean {
    const executable = ['/usr/bin/ss', '/bin/ss'].find(candidate => existsSync(candidate))
    if (executable === undefined) {
      const result = spawnSync('/usr/bin/bash', ['-c', `echo >/dev/tcp/${address}/${String(port)}`], { encoding: 'utf8' })
      return result.status === 0
    }
    const result = spawnSync(executable, ['-H', '-ltn'], { encoding: 'utf8' })
    if (result.status !== 0) return false
    const needle = `:${String(port)}`
    return result.stdout.split('\n').some(line => line.includes(needle) && (line.includes(address) || address === '0.0.0.0' || address === '::'))
  }
}
