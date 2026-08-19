import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declaredFlagNames } from '../src/installer/cli-parser.js'
import { runCli } from '../src/cli.js'
import { NodeInstallerHost } from '../src/installer/host.js'
import { FakeCliIo, FakeInstallerHost } from './installer-helpers.js'

const PASSWORD = 'sufficient-test-password'
const OUTPUT_ARGS = [
  '--non-interactive', '--json', '--output-dir', '/export/dsh-auth', '--mode', 'http',
  '--listen-address', '127.0.0.1', '--admin-bootstrap', 'password', '--admin-username', 'admin',
  '--login-token', 'disabled',
] as const

function outputHost(): FakeInstallerHost {
  const host = new FakeInstallerHost()
  host.addDirectory('/export')
  host.installBundledCaddy()
  return host
}

// eslint-disable-next-line max-lines-per-function -- 覆盖冻结 help/JSON/交互/回滚的公共 CLI 契约，逐用例共享下方模块级 fixture；阈值 2026-08 新增，重排需与契约表同步。
describe('installer CLI', () => {
  it('prints frozen help for --help and -h from the same flag table', async () => {
    const helpIo = new FakeCliIo(false)
    expect(await runCli(['--help'], helpIo, new FakeInstallerHost())).toBe(0)
    const text = helpIo.outputs.join('')
    expect(text).toContain('dsh-auth --help')
    expect(text).toContain('dsh-auth --version')
    expect(text).toContain('When stdin and stdout are TTYs')
    expect(text).toContain('--password-stdin or --password-file')
    expect(text).toContain('--name=value')
    expect(text).toContain('--json does not disable prompts')
    expect(text).toContain('--help')
    expect(text).toContain('  -h ')
    expect(text).toContain('dsh-auth hash [--password-stdin]')
    expect(text).not.toContain('--nginx')
    expect(text).not.toContain('--user-id')
    for (const flag of declaredFlagNames()) expect(text).toContain(flag)

    const aliasIo = new FakeCliIo(false)
    expect(await runCli(['-h'], aliasIo, new FakeInstallerHost())).toBe(0)
    expect(aliasIo.outputs.join('')).toBe(text)
  })

  it('prints the package version for --version', async () => {
    const version = `${(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { readonly version: string }).version}\n`
    const io = new FakeCliIo(false)
    expect(await runCli(['--version'], io, new FakeInstallerHost())).toBe(0)
    expect(io.outputs.join('')).toBe(version)

    const setupIo = new FakeCliIo(false)
    expect(await runCli(['setup', '--version'], setupIo, new FakeInstallerHost())).toBe(0)
    expect(setupIo.outputs.join('')).toBe(version)

    const unknown = new FakeCliIo(false)
    expect(await runCli(['version'], unknown, new FakeInstallerHost())).toBe(2)
  })

  it('emits a secret-free JSON plan without reading stdin or writing files', async () => {
    const host = outputHost()
    const io = new FakeCliIo(false, [], [], PASSWORD)

    const exitCode = await runCli(['plan', ...OUTPUT_ARGS, '--password-stdin'], io, host)

    expect(exitCode).toBe(0)
    expect(io.stdinReads).toBe(0)
    expect(io.errors).toEqual([])
    expect(io.outputs.join('')).not.toContain(PASSWORD)
    expect(host.entries.has('/export/dsh-auth')).toBe(false)
    expect(JSON.parse(io.outputs.join(''))).toMatchObject({ schemaVersion: 2, command: 'plan' })
  })

  it('treats setup --dry-run as the same zero-write plan core', async () => {
    const host = outputHost()
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['setup', '--dry-run', ...OUTPUT_ARGS], io, host)

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.outputs.join(''))).toMatchObject({ command: 'plan', exitCode: 0 })
    expect(host.entries.has('/export/dsh-auth')).toBe(false)
  })

  it('completes an interactive password setup through the same output plan', async () => {
    const host = outputHost()
    const io = new FakeCliIo(true, ['password', 'disabled', 'admin', 'http', '127.0.0.1', 'install'], [PASSWORD, PASSWORD])

    const exitCode = await runCli(['setup', '--output-dir', '/export/interactive'], io, host)

    expect(exitCode).toBe(0)
    expect(io.hiddenReads).toBe(2)
    expect(host.fileExists('/export/interactive/install-state.json')).toBe(true)
    expect(io.outputs.join('')).not.toContain(PASSWORD)
  }, 30_000)

  it('writes only hashed/file-backed secrets, preserves modes, and repeats unchanged', async () => {
    const host = outputHost()
    const firstIo = new FakeCliIo(false, [], [], PASSWORD)

    await expect(runCli(['setup', ...OUTPUT_ARGS, '--password-stdin'], firstIo, host)).resolves.toBe(0)

    expect(host.readFile('/export/dsh-auth/state/auth-state.json')).toMatch(/\$argon2id\$/u)
    expect(host.readFile('/export/dsh-auth/state/auth-state.json')).not.toContain(PASSWORD)
    expect(host.readFile('/export/dsh-auth/session-secret')).not.toContain(PASSWORD)
    expect(host.readFile('/export/dsh-auth/dsh-auth.env')).not.toContain(host.readFile('/export/dsh-auth/session-secret').trim())
    expect(host.readFile('/export/dsh-auth/dsh-auth.env')).toContain('DSH_AUTH_STATE_FILE=')
    expect(host.stat('/export/dsh-auth/session-secret').mode).toBe(0o600)
    expect(firstIo.outputs.join('')).not.toContain(PASSWORD)
    expect(JSON.parse(firstIo.outputs.join(''))).toMatchObject({ schemaVersion: 2 })

    const secondIo = new FakeCliIo(false)
    await expect(runCli(['setup', ...OUTPUT_ARGS], secondIo, host)).resolves.toBe(0)
    expect(secondIo.stdinReads).toBe(0)
    expect(JSON.parse(secondIo.outputs.join(''))).toMatchObject({ status: 'unchanged', exitCode: 0 })
  }, 30_000)

  it('rejects changed configuration instead of overwriting an owned install', async () => {
    const host = outputHost()
    await runCli(['setup', ...OUTPUT_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)

    const io = new FakeCliIo(false, [], [], `${PASSWORD}-two`)
    const changedArgs = OUTPUT_ARGS.map((value, index) => OUTPUT_ARGS[index - 1] === '--admin-username' ? 'different' : value)
    const exitCode = await runCli(['setup', ...changedArgs, '--password-stdin'], io, host)

    expect(exitCode).toBe(4)
    expect(io.stdinReads).toBe(0)
    expect(host.readFile('/export/dsh-auth/dsh-auth.env')).toContain('DSH_AUTH_STATE_FILE=')
  }, 30_000)

  it('reports drift instead of treating a damaged repeated install as unchanged', async () => {
    const host = outputHost()
    await runCli(['setup', ...OUTPUT_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)
    host.removeFile('/export/dsh-auth/session-secret')
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['setup', ...OUTPUT_ARGS], io, host)

    expect(exitCode).toBe(4)
    expect(io.outputs.join('')).toContain('MANAGED_PATH_MISSING')
  }, 30_000)

  it('recovers an adjacent bootstrap journal left before directory creation', async () => {
    const host = outputHost()
    await runCli(['setup', ...OUTPUT_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)
    const state = JSON.parse(host.readFile('/export/dsh-auth/install-state.json')) as { status: string; createdPaths: string[] }
    for (const path of [...state.createdPaths].reverse()) {
      if (!host.fileExists(path)) continue
      if (host.stat(path).isDirectory) host.removeDirectory(path)
      else host.removeFile(path)
    }
    state.status = 'installing'
    host.addFile('/export/dsh-auth.installing.json', `${JSON.stringify(state)}\n`, 0o600)

    const io = new FakeCliIo(false, [], [], `${PASSWORD}-recovered`)
    const exitCode = await runCli(['setup', ...OUTPUT_ARGS, '--password-stdin'], io, host)

    expect(exitCode).toBe(0)
    expect(host.fileExists('/export/dsh-auth.installing.json')).toBe(false)
    expect(JSON.parse(host.readFile('/export/dsh-auth/install-state.json'))).toMatchObject({ status: 'installed', schemaVersion: 2 })
  }, 30_000)

  it('creates token directories without a password for login-token initialization', async () => {
    const host = outputHost()
    const io = new FakeCliIo(false)
    const exitCode = await runCli([
      'setup', '--non-interactive', '--json', '--output-dir', '/export/token', '--mode', 'http',
      '--listen-address', '127.0.0.1', '--admin-bootstrap', 'login-token', '--login-token', 'enabled',
    ], io, host)

    expect(exitCode).toBe(0)
    expect(io.stdinReads).toBe(0)
    expect(host.stat('/export/token/state/login-tokens').mode).toBe(0o700)
    expect(host.readFile('/export/token/state/auth-state.json')).toContain('"username":null')
    expect(host.readFile('/export/token/dsh-auth.env')).toContain('DSH_AUTH_LOGIN_TOKEN_ENABLED=true')
  }, 30_000)

  it('rejects removed Nginx and identity flags without executing', async () => {
    const host = outputHost()
    const io = new FakeCliIo(false)
    expect(await runCli(['plan', ...OUTPUT_ARGS, '--nginx', 'require'], io, host)).toBe(2)
    expect(`${io.outputs.join('')}${io.errors.join('')}`).toContain('bundled Caddy')
    expect(await runCli(['plan', '--user-id', 'admin'], io, host)).toBe(2)
    expect(await runCli(['plan', '--username', 'admin'], io, host)).toBe(2)
    expect(await runCli(['plan', '--roles', 'admin'], io, host)).toBe(2)
  })

  it('rejects inline password syntax without echoing the following secret', async () => {
    const host = outputHost()
    const secret = 'must-not-echo-this-value'
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['setup', ...OUTPUT_ARGS, '--password', secret], io, host)

    expect(exitCode).toBe(2)
    expect(io.outputs.join('')).not.toContain(secret)
    expect(io.errors.join('')).not.toContain(secret)
  })

  it('does not discard trailing hash options or accept uninstall authorization during setup', async () => {
    const hashIo = new FakeCliIo(false, [], [], PASSWORD)
    await expect(runCli(['hash', '--stdin'], hashIo, new FakeInstallerHost())).resolves.toBe(2)
    expect(hashIo.errors.join('')).toContain('--password-stdin')
    expect(hashIo.stdinReads).toBe(0)

    const setupIo = new FakeCliIo(false)
    await expect(runCli(['plan', ...OUTPUT_ARGS, '--authorize-uninstall'], setupIo, outputHost())).resolves.toBe(2)
    await expect(runCli(['plan', ...OUTPUT_ARGS, '--authorize-password-reset'], setupIo, outputHost())).resolves.toBe(2)
    const binIo = new FakeCliIo(false)
    await expect(runCli(['plan', '--dsh-bin', '/usr/local/bin/dsh'], binIo, new FakeInstallerHost())).resolves.toBe(2)
    expect(binIo.errors.join('')).toContain('--dsh-executable')
    await expect(runCli(['hash', '--password-stdin', '--json'], hashIo, new FakeInstallerHost())).resolves.toBe(2)
  })

  it('accepts --name=value flags before the command', async () => {
    const host = outputHost()
    const io = new FakeCliIo(false)

    const exitCode = await runCli([
      '--json', 'plan', '--non-interactive', '--output-dir=/export/dsh-auth',
      '--mode=http', '--listen-address=127.0.0.1', '--admin-bootstrap=password',
      '--admin-username=admin', '--login-token=disabled',
    ], io, host)

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.outputs.join(''))).toMatchObject({ command: 'plan', exitCode: 0 })
  })

  it('keeps --json from disabling TTY prompts', async () => {
    const host = outputHost()
    const io = new FakeCliIo(true, ['password', 'disabled', 'admin', 'http', '127.0.0.1', 'install'], ['json-prompt-password', 'json-prompt-password'])

    const exitCode = await runCli(['setup', '--json', '--output-dir', '/export/json-prompt'], io, host)

    expect(exitCode).toBe(0)
    expect(io.hiddenReads).toBe(2)
    expect(JSON.parse(io.outputs.at(-1) ?? '')).toMatchObject({ command: 'setup', status: 'success' })
  }, 30_000)

  it('refuses schema v1 ownership records without migrating them', async () => {
    const host = outputHost()
    host.addDirectory('/etc/dsh-auth', 0o750)
    host.addFile('/etc/dsh-auth/install-state.json', `${JSON.stringify({ schemaVersion: 1, status: 'installed' })}\n`, 0o600)
    const io = new FakeCliIo(false)
    const exitCode = await runCli(['doctor', '--json'], io, host)
    expect(exitCode).not.toBe(0)
    expect(io.outputs.join('') + io.errors.join('')).toContain('SCHEMA_V1_UNSUPPORTED')
  })

  it('rejects login-token initialization with a password source', async () => {
    const host = outputHost()
    const io = new FakeCliIo(false, [], [], PASSWORD)
    const exitCode = await runCli([
      'setup', '--non-interactive', '--json', '--output-dir', '/export/token-password', '--mode', 'http',
      '--listen-address', '127.0.0.1', '--admin-bootstrap', 'login-token', '--login-token', 'enabled',
      '--password-stdin',
    ], io, host)
    expect(exitCode).toBe(2)
    expect(io.stdinReads).toBe(0)
  })

  it('rejects automatic TLS certificate parameters and duplicate flags', async () => {
    const host = outputHost()
    const tlsIo = new FakeCliIo(false)
    expect(await runCli([
      'plan', '--non-interactive', '--json', '--output-dir', '/export/tls', '--mode', 'https',
      '--server-name', 'auth.example.test', '--admin-bootstrap', 'login-token', '--login-token', 'enabled',
      '--tls', 'automatic', '--certificate', '/etc/ssl/cert.pem',
    ], tlsIo, host)).toBe(2)
    expect(`${tlsIo.outputs.join('')}${tlsIo.errors.join('')}`).toMatch(/certificate/u)

    const duplicate = new FakeCliIo(false)
    expect(await runCli(['plan', '--json', '--json'], duplicate, host)).toBe(2)
  })

  it('keeps issue-login-token options out of setup and plan', async () => {
    const io = new FakeCliIo(false)
    expect(await runCli(['plan', ...OUTPUT_ARGS, '--ttl-seconds', '60'], io, outputHost())).toBe(2)
    expect(await runCli(['plan', ...OUTPUT_ARGS, '--authorize-login-token-issue'], io, outputHost())).toBe(2)
  })
})

const TOKEN_SYSTEM_ARGS = [
  '--json', '--non-interactive', '--mode', 'http', '--listen-address', '10.0.0.20',
  '--dsh-service', 'dsh-web.service', '--admin-bootstrap', 'login-token', '--login-token', 'enabled',
] as const
const ISSUE_ARGS = ['issue-login-token', '--non-interactive', '--authorize-login-token-issue'] as const
const TOKEN_URL = /^http:\/\/10\.0\.0\.20:8080\/auth\/token#token=dsh_otl_v1_[A-Za-z0-9_-]{43}$/u

function tokenSystemHost(): FakeInstallerHost {
  const host = new FakeInstallerHost()
  host.withSystemdService()
  host.installCliPackage()
  host.installBundledCaddy()
  return host
}

function digestOf(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function tokenFromUrl(url: string): string {
  return url.slice(url.indexOf('#token=') + '#token='.length)
}

function containerHost(callerUid: number): FakeInstallerHost {
  const host = new FakeInstallerHost()
  host.uid = callerUid
  host.addDirectory('/srv/app', 0o755)
  host.addDirectory('/srv/app/state', 0o700, 1000, 1000)
  host.addFile('/srv/app/state/auth-state.json', '{}\n', 0o600, 1000, 1000)
  host.addDirectory('/srv/app/state/login-tokens', 0o700, 1000, 1000)
  host.addFile('/srv/app/dsh-auth.env', 'DSH_AUTH_STATE_FILE="/srv/app/state/auth-state.json"\nDSH_AUTH_LOGIN_TOKEN_ENABLED=true\n', 0o600, 1000, 1000)
  return host
}

function containerArgs(): string[] {
  return ['issue-login-token', '--non-interactive', '--authorize-login-token-issue',
    '--auth-state-file', '/srv/app/state/auth-state.json', '--public-origin', 'https://auth.example.test']
}

class FirstWriteFailsIo extends FakeCliIo {
  private failedOnce = false

  override writeOut(value: string): void {
    if (!this.failedOnce) {
      this.failedOnce = true
      throw new Error('synthetic stdout failure')
    }
    super.writeOut(value)
  }
}

describe('issue-login-token CLI', () => {
  it('issues a system token from the recorded installation and prints one URL', async () => {
    const host = tokenSystemHost()
    await expect(runCli(['setup', ...TOKEN_SYSTEM_ARGS], new FakeCliIo(false), host)).resolves.toBe(0)

    const io = new FakeCliIo(false)
    expect(await runCli(ISSUE_ARGS, io, host)).toBe(0)
    const output = io.outputs.join('')
    expect(output.trim()).toMatch(TOKEN_URL)
    expect(output.trim().split('\n')).toHaveLength(1)
    expect(io.errors).toEqual([])
    const token = tokenFromUrl(output.trim())
    const path = `/var/lib/dsh-auth/login-tokens/${digestOf(token)}`
    expect(host.fileExists(path)).toBe(true)
    const metadata = JSON.parse(host.readFile(path)) as { schemaVersion: number; issuedAt: number; expiresAt: number }
    expect(metadata.schemaVersion).toBe(1)
    expect(metadata.expiresAt - metadata.issuedAt).toBe(300_000)
    expect(Number.isSafeInteger(metadata.issuedAt)).toBe(true)
    expect(Number.isSafeInteger(metadata.expiresAt)).toBe(true)
    expect(host.readFile(path)).not.toContain(token)
    expect(host.stat(path)).toMatchObject({ uid: 0, gid: 0, mode: 0o600 })
  }, 30_000)

  it('emits the JSON v2 success document as the only bearer-secret output', async () => {
    const host = tokenSystemHost()
    await runCli(['setup', ...TOKEN_SYSTEM_ARGS], new FakeCliIo(false), host)
    const before = Date.now()

    const io = new FakeCliIo(false)
    expect(await runCli([...ISSUE_ARGS, '--json'], io, host)).toBe(0)
    const document = JSON.parse(io.outputs.join('')) as { schemaVersion: number; command: string; status: string; exitCode: number; token: string; loginUrl: string; expiresAt: string }
    expect(document).toMatchObject({ schemaVersion: 2, command: 'issue-login-token', status: 'success', exitCode: 0 })
    expect(document.token).toMatch(/^dsh_otl_v1_[A-Za-z0-9_-]{43}$/u)
    expect(document.loginUrl).toBe(`http://10.0.0.20:8080/auth/token#token=${document.token}`)
    expect(document.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
    const remaining = Date.parse(document.expiresAt) - before
    expect(remaining).toBeGreaterThan(299_000)
    expect(remaining).toBeLessThanOrEqual(300_500)
    expect(io.errors).toEqual([])
  }, 30_000)

  it('accepts TTL boundaries 60 and 300 and rejects everything else before writing', async () => {
    const host = tokenSystemHost()
    await runCli(['setup', ...TOKEN_SYSTEM_ARGS], new FakeCliIo(false), host)
    for (const ttl of ['59', '301', '0', 'abc', '60.5']) {
      const io = new FakeCliIo(false)
      expect(await runCli([...ISSUE_ARGS, '--ttl-seconds', ttl], io, host)).toBe(2)
      expect(`${io.outputs.join('')}${io.errors.join('')}`).not.toMatch(/dsh_otl_v1_/u)
    }
    expect(host.listDirectory('/var/lib/dsh-auth/login-tokens')).toHaveLength(0)

    const before = Date.now()
    const io = new FakeCliIo(false)
    expect(await runCli([...ISSUE_ARGS, '--json', '--ttl-seconds', '60'], io, host)).toBe(0)
    const remaining = Date.parse((JSON.parse(io.outputs.join('')) as { expiresAt: string }).expiresAt) - before
    expect(remaining).toBeGreaterThan(59_000)
    expect(remaining).toBeLessThanOrEqual(60_500)
  }, 30_000)

  it('requires the exact confirmation word in interactive mode only', async () => {
    const host = tokenSystemHost()
    await runCli(['setup', ...TOKEN_SYSTEM_ARGS], new FakeCliIo(false), host)

    const confirmed = new FakeCliIo(true, ['issue-login-token'])
    expect(await runCli(['issue-login-token'], confirmed, host)).toBe(0)
    expect(confirmed.prompts.join('')).toContain('issue-login-token')
    expect(confirmed.outputs.join('').trim().split('\n').at(-1)).toMatch(TOKEN_URL)

    const denied = new FakeCliIo(true, ['issue'])
    expect(await runCli(['issue-login-token'], denied, host)).toBe(7)
    expect(denied.outputs.join('')).not.toContain('#token=')
    expect(denied.errors).toEqual([])

    const unauthorized = new FakeCliIo(false)
    expect(await runCli(['issue-login-token', '--non-interactive'], unauthorized, host)).toBe(2)
    expect(host.listDirectory('/var/lib/dsh-auth/login-tokens')).toHaveLength(1)
  }, 30_000)

  it('keeps the published token after a stdout failure without leaking it', async () => {
    const host = tokenSystemHost()
    await runCli(['setup', ...TOKEN_SYSTEM_ARGS], new FakeCliIo(false), host)

    const io = new FirstWriteFailsIo(false)
    expect(await runCli(ISSUE_ARGS, io, host)).toBe(6)
    expect(io.errors.join('')).not.toMatch(/dsh_otl_v1_/u)
    const files = host.listDirectory('/var/lib/dsh-auth/login-tokens')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{64}$/u)
    expect(host.readFile(`/var/lib/dsh-auth/login-tokens/${files[0] ?? ''}`)).toContain('"schemaVersion":1')
  }, 30_000)

  it('rejects the 33rd unexpired token and keeps failures secret-free', async () => {
    const host = tokenSystemHost()
    await runCli(['setup', ...TOKEN_SYSTEM_ARGS], new FakeCliIo(false), host)
    let counter = 0
    host.randomBytes = (size: number): Buffer => {
      counter += 1
      return Buffer.alloc(size, counter % 251)
    }
    for (let index = 0; index < 32; index += 1) {
      expect(await runCli(ISSUE_ARGS, new FakeCliIo(false), host)).toBe(0)
    }
    expect(host.listDirectory('/var/lib/dsh-auth/login-tokens')).toHaveLength(32)

    const io = new FakeCliIo(false)
    expect(await runCli([...ISSUE_ARGS, '--json'], io, host)).toBe(4)
    const output = io.outputs.join('')
    expect(output).toContain('LOGIN_TOKEN_CAPACITY_EXCEEDED')
    expect(output).not.toMatch(/dsh_otl_v1_/u)
  }, 30_000)

  it('refuses systemd issue for non-root callers, disabled installs, and tampered state', async () => {
    const host = tokenSystemHost()
    await runCli(['setup', ...TOKEN_SYSTEM_ARGS], new FakeCliIo(false), host)
    host.uid = 1000
    const nonRoot = new FakeCliIo(false)
    expect(await runCli(ISSUE_ARGS, nonRoot, host)).toBe(5)
    expect(`${nonRoot.outputs.join('')}${nonRoot.errors.join('')}`).toContain('LOGIN_TOKEN_ROOT_REQUIRED')
    host.uid = 0

    const state = JSON.parse(host.readFile('/etc/dsh-auth/install-state.json')) as { publicOrigin: string }
    state.publicOrigin = 'https://evil.example'
    host.addFile('/etc/dsh-auth/install-state.json', `${JSON.stringify(state)}\n`, 0o600)
    const tampered = new FakeCliIo(false)
    expect(await runCli(ISSUE_ARGS, tampered, host)).toBe(4)
    expect(tampered.outputs.join('') + tampered.errors.join('')).not.toMatch(/dsh_otl_v1_/u)
  }, 30_000)

  it('refuses issuance when the recorded installation disabled tokens', async () => {
    const host = tokenSystemHost()
    const args = TOKEN_SYSTEM_ARGS.map(value => value === 'enabled' ? 'disabled' : value).map(value => value === 'login-token' ? 'password' : value)
    await expect(runCli(['setup', ...args, '--admin-username', 'admin', '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)).resolves.toBe(0)

    const io = new FakeCliIo(false)
    expect(await runCli(ISSUE_ARGS, io, host)).toBe(3)
    expect(io.outputs.join('') + io.errors.join('')).toContain('LOGIN_TOKEN_DISABLED')
    expect(host.listDirectory('/var/lib/dsh-auth/login-tokens')).toHaveLength(0)
  }, 30_000)

  it('refuses missing or schema v1 system state before generating any token', async () => {
    const empty = tokenSystemHost()
    const missingIo = new FakeCliIo(false)
    expect(await runCli(ISSUE_ARGS, missingIo, empty)).toBe(4)
    expect(missingIo.outputs.join('') + missingIo.errors.join('')).toContain('INSTALLATION_NOT_FOUND')

    const v1 = tokenSystemHost()
    v1.addDirectory('/etc/dsh-auth', 0o750)
    v1.addFile('/etc/dsh-auth/install-state.json', `${JSON.stringify({ schemaVersion: 1, status: 'installed' })}\n`, 0o600)
    const v1Io = new FakeCliIo(false)
    expect(await runCli(ISSUE_ARGS, v1Io, v1)).toBe(4)
    expect(v1Io.outputs.join('') + v1Io.errors.join('')).toContain('SCHEMA_V1_UNSUPPORTED')
  })

  it('rejects unknown flags and half of the container input pair', async () => {
    const host = tokenSystemHost()
    await runCli(['setup', ...TOKEN_SYSTEM_ARGS], new FakeCliIo(false), host)
    const io = new FakeCliIo(false)
    expect(await runCli(['issue-login-token', '--dry-run'], io, host)).toBe(2)
    expect(await runCli([...ISSUE_ARGS, '--public-origin', 'https://auth.example.test'], io, host)).toBe(2)
    expect(await runCli([...ISSUE_ARGS, '--auth-state-file', 'relative/state.json', '--public-origin', 'https://auth.example.test'], io, host)).toBe(2)
    expect(host.listDirectory('/var/lib/dsh-auth/login-tokens')).toHaveLength(0)
  }, 30_000)
})

describe('issue-login-token CLI container mode', () => {
  it('issues for the container owner and for root with matching ownership', async () => {
    const ownerHost = containerHost(1000)
    const ownerIo = new FakeCliIo(false)
    expect(await runCli(containerArgs(), ownerIo, ownerHost)).toBe(0)
    const ownerUrl = ownerIo.outputs.join('').trim()
    expect(ownerUrl).toBe(`https://auth.example.test/auth/token#token=${tokenFromUrl(ownerUrl)}`)
    const ownerDigest = digestOf(tokenFromUrl(ownerUrl))
    expect(ownerHost.fileExists(`/srv/app/state/login-tokens/${ownerDigest}`)).toBe(true)
    expect(ownerHost.readFile(`/srv/app/state/login-tokens/${ownerDigest}`)).not.toContain(tokenFromUrl(ownerUrl))

    const rootHost = containerHost(0)
    const rootIo = new FakeCliIo(false)
    expect(await runCli(containerArgs(), rootIo, rootHost)).toBe(0)
    const rootDigest = digestOf(tokenFromUrl(rootIo.outputs.join('').trim()))
    expect(rootHost.stat(`/srv/app/state/login-tokens/${rootDigest}`)).toMatchObject({ uid: 1000, gid: 1000, mode: 0o600 })
  })

  it('refuses container callers that are neither root nor the state owner', async () => {
    const host = containerHost(1000)
    host.addFile('/srv/app/state/auth-state.json', '{}\n', 0o600, 0, 0)
    const io = new FakeCliIo(false)
    expect(await runCli(containerArgs(), io, host)).toBe(5)
    expect(io.outputs.join('') + io.errors.join('')).toContain('LOGIN_TOKEN_CALLER_NOT_AUTHORIZED')
    expect(host.listDirectory('/srv/app/state/login-tokens')).toHaveLength(0)
  })

  it('rejects unsafe public origins before any state validation writes', async () => {
    for (const origin of ['http://8.8.8.8:8080', 'https://example.com/path', 'https://user@example.com', 'https://example.com/?q=1', 'https://example.com#t', 'ftp://example.com', 'example.com']) {
      const io = new FakeCliIo(false)
      const host = containerHost(1000)
      expect(await runCli([...containerArgs().slice(0, 5), '--public-origin', origin], io, host)).toBe(2)
      expect(`${io.outputs.join('')}${io.errors.join('')}`).not.toMatch(/dsh_otl_v1_/u)
    }
  })

  it('fails closed on container drift: missing token directory, wrong modes, and policy files', async () => {
    const missingDir = containerHost(1000)
    missingDir.entries.delete('/srv/app/state/login-tokens')
    const missingIo = new FakeCliIo(false)
    expect(await runCli(containerArgs(), missingIo, missingDir)).toBe(4)

    const wideMode = containerHost(1000)
    wideMode.chmod('/srv/app/state/auth-state.json', 0o644)
    const wideIo = new FakeCliIo(false)
    expect(await runCli(containerArgs(), wideIo, wideMode)).toBe(4)

    const wideDir = containerHost(1000)
    wideDir.chmod('/srv/app/state/login-tokens', 0o777)
    const wideDirIo = new FakeCliIo(false)
    expect(await runCli(containerArgs(), wideDirIo, wideDir)).toBe(4)
    expect(wideDirIo.errors.join('')).toContain('LOGIN_TOKEN_DIRECTORY_INVALID')

    const foreignDir = containerHost(1000)
    foreignDir.chown('/srv/app/state/login-tokens', 99, 99)
    const foreignIo = new FakeCliIo(false)
    expect(await runCli(containerArgs(), foreignIo, foreignDir)).toBe(4)
    expect(foreignIo.errors.join('')).toContain('LOGIN_TOKEN_DIRECTORY_INVALID')

    const missingEnv = containerHost(1000)
    missingEnv.entries.delete('/srv/app/dsh-auth.env')
    const envIo = new FakeCliIo(false)
    expect(await runCli(containerArgs(), envIo, missingEnv)).toBe(3)
    expect(envIo.outputs.join('') + envIo.errors.join('')).toContain('LOGIN_TOKEN_POLICY_MISSING')

    const disabledEnv = containerHost(1000)
    disabledEnv.addFile('/srv/app/dsh-auth.env', 'DSH_AUTH_LOGIN_TOKEN_ENABLED=false\n', 0o600, 1000, 1000)
    const disabledIo = new FakeCliIo(false)
    expect(await runCli(containerArgs(), disabledIo, disabledEnv)).toBe(3)
    expect(disabledIo.outputs.join('') + disabledIo.errors.join('')).toContain('LOGIN_TOKEN_DISABLED')
  })

  it('refuses a symlinked container state file on the real filesystem', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-issue-container-'))
    try {
      const stateDirectory = join(root, 'state')
      mkdirSync(stateDirectory, { mode: 0o700 })
      writeFileSync(join(root, 'dsh-auth.env'), 'DSH_AUTH_LOGIN_TOKEN_ENABLED=true\n', { mode: 0o600 })
      writeFileSync(join(root, 'target.json'), '{}\n', { mode: 0o600 })
      chmodSync(join(root, 'target.json'), 0o600)
      symlinkSync(join(root, 'target.json'), join(stateDirectory, 'auth-state.json'))
      mkdirSync(join(stateDirectory, 'login-tokens'), { mode: 0o700 })

      const io = new FakeCliIo(false)
      expect(await runCli([
        'issue-login-token', '--non-interactive', '--authorize-login-token-issue',
        '--auth-state-file', join(stateDirectory, 'auth-state.json'), '--public-origin', 'http://127.0.0.1:8080',
      ], io, new NodeInstallerHost())).toBe(4)
      expect(io.errors.join('')).not.toMatch(/dsh_otl_v1_/u)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a world-writable or symlinked token directory on the real filesystem', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-issue-token-dir-'))
    try {
      const stateDirectory = join(root, 'state')
      const tokenDirectory = join(stateDirectory, 'login-tokens')
      mkdirSync(stateDirectory, { mode: 0o700 })
      writeFileSync(join(root, 'dsh-auth.env'), 'DSH_AUTH_LOGIN_TOKEN_ENABLED=true\n', { mode: 0o600 })
      writeFileSync(join(stateDirectory, 'auth-state.json'), '{}\n', { mode: 0o600 })
      chmodSync(join(stateDirectory, 'auth-state.json'), 0o600)

      mkdirSync(tokenDirectory, { mode: 0o777 })
      chmodSync(tokenDirectory, 0o777)
      const wideIo = new FakeCliIo(false)
      expect(await runCli([
        'issue-login-token', '--non-interactive', '--authorize-login-token-issue',
        '--auth-state-file', join(stateDirectory, 'auth-state.json'), '--public-origin', 'http://127.0.0.1:8080',
      ], wideIo, new NodeInstallerHost())).toBe(4)
      expect(wideIo.errors.join('')).toContain('LOGIN_TOKEN_DIRECTORY_INVALID')
      expect(wideIo.errors.join('')).not.toMatch(/dsh_otl_v1_/u)

      rmSync(tokenDirectory, { recursive: true, force: true })
      mkdirSync(join(root, 'real-tokens'), { mode: 0o700 })
      chmodSync(join(root, 'real-tokens'), 0o700)
      symlinkSync(join(root, 'real-tokens'), tokenDirectory)
      const linkIo = new FakeCliIo(false)
      expect(await runCli([
        'issue-login-token', '--non-interactive', '--authorize-login-token-issue',
        '--auth-state-file', join(stateDirectory, 'auth-state.json'), '--public-origin', 'http://127.0.0.1:8080',
      ], linkIo, new NodeInstallerHost())).toBe(4)
      expect(linkIo.errors.join('')).toContain('LOGIN_TOKEN_DIRECTORY_INVALID')
      expect(linkIo.errors.join('')).not.toMatch(/dsh_otl_v1_/u)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
