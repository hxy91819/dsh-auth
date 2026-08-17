import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, chmodSync, chownSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { CommandResult, CommandSpec, InstallerHost } from './types.js'

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

  stat(path: string): ReturnType<InstallerHost['stat']> {
    return snapshotStat(path)
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
}
