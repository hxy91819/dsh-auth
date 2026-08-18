import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { declaredFlagNames } from '../src/installer/cli-parser.js'
import { runCli } from '../src/cli.js'
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
  host.installCaddyPackage()
  return host
}

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
})
