import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.js'
import { FakeCliIo, FakeInstallerHost } from './installer-helpers.js'

const OUTPUT_ARGS = [
  '--non-interactive', '--json', '--output-dir', '/export/dsh-auth', '--mode', 'http',
  '--listen-address', '127.0.0.1', '--user-id', 'admin', '--username', 'admin',
] as const

describe('installer CLI', () => {
  const FROZEN_FLAGS = [
    '--help', '--version', '--non-interactive', '--json', '--dry-run',
    '--nginx', '--authorize-nginx-install', '--dsh-service', '--dsh-home', '--dsh-executable',
    '--profile', '--package', '--user-id', '--username', '--roles',
    '--password-stdin', '--password-file', '--mode', '--upstream', '--listen-address',
    '--http-port', '--https-port', '--server-name', '--certificate', '--certificate-key',
    '--output-dir', '--authorize-password-reset', '--authorize-uninstall',
  ] as const

  it('prints frozen help for --help and -h', async () => {
    const helpIo = new FakeCliIo(false)
    expect(await runCli(['--help'], helpIo, new FakeInstallerHost())).toBe(0)
    const text = helpIo.outputs.join('')
    expect(text).toContain('dsh-auth --help')
    expect(text).toContain('dsh-auth --version')
    expect(text).toContain('When stdin and stdout are TTYs')
    expect(text).toContain('setup also requires exactly one of --password-stdin')
    expect(text).toContain('--name=value')
    expect(text).toContain('--json does not disable prompts')
    expect(text).toContain('--help, -h')
    expect(text).toContain('dsh-auth hash [--password-stdin]')
    for (const flag of FROZEN_FLAGS) expect(text).toContain(flag)

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
    const host = new FakeInstallerHost()
    host.addDirectory('/export')
    const secret = 'unique-plan-password-value'
    const io = new FakeCliIo(false, [], [], secret)

    const exitCode = await runCli(['plan', ...OUTPUT_ARGS, '--password-stdin'], io, host)

    expect(exitCode).toBe(0)
    expect(io.stdinReads).toBe(0)
    expect(io.errors).toEqual([])
    expect(io.outputs.join('')).not.toContain(secret)
    expect(host.entries.has('/export/dsh-auth')).toBe(false)
  })

  it('treats setup --dry-run as the same zero-write plan core', async () => {
    const host = new FakeInstallerHost()
    host.addDirectory('/export')
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['setup', '--dry-run', ...OUTPUT_ARGS], io, host)

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.outputs.join(''))).toMatchObject({ command: 'plan', exitCode: 0 })
    expect(host.entries.has('/export/dsh-auth')).toBe(false)
  })

  it('completes an interactive setup through the same output plan', async () => {
    const host = new FakeInstallerHost()
    host.addDirectory('/export')
    const io = new FakeCliIo(true, ['', '', 'http', '127.0.0.1', 'install'], ['interactive-password', 'interactive-password'])

    const exitCode = await runCli(['setup', '--output-dir', '/export/interactive'], io, host)

    expect(exitCode).toBe(0)
    expect(io.hiddenReads).toBe(2)
    expect(host.fileExists('/export/interactive/install-state.json')).toBe(true)
    expect(io.outputs.join('')).not.toContain('interactive-password')
  }, 30_000)

  it('writes only hashed/file-backed secrets, preserves modes, and repeats unchanged', async () => {
    const host = new FakeInstallerHost()
    host.addDirectory('/export')
    const password = 'never-store-this-plaintext'
    const firstIo = new FakeCliIo(false, [], [], password)

    await expect(runCli(['setup', ...OUTPUT_ARGS, '--password-stdin'], firstIo, host)).resolves.toBe(0)

    expect(host.readFile('/export/dsh-auth/password-hash')).toMatch(/^\$argon2id\$/u)
    expect(host.readFile('/export/dsh-auth/password-hash')).not.toContain(password)
    expect(host.readFile('/export/dsh-auth/session-secret')).not.toContain(password)
    expect(host.readFile('/export/dsh-auth/dsh-auth.env')).not.toContain(host.readFile('/export/dsh-auth/session-secret').trim())
    expect(host.stat('/export/dsh-auth/password-hash').mode).toBe(0o600)
    expect(host.stat('/export/dsh-auth/session-secret').mode).toBe(0o600)
    expect(firstIo.outputs.join('')).not.toContain(password)

    const secondIo = new FakeCliIo(false)
    await expect(runCli(['setup', ...OUTPUT_ARGS], secondIo, host)).resolves.toBe(0)
    expect(secondIo.stdinReads).toBe(0)
    expect(JSON.parse(secondIo.outputs.join(''))).toMatchObject({ status: 'unchanged', exitCode: 0 })
  }, 30_000)

  it('rejects changed configuration instead of overwriting an owned install', async () => {
    const host = new FakeInstallerHost()
    host.addDirectory('/export')
    await runCli(['setup', ...OUTPUT_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'first-password'), host)

    const io = new FakeCliIo(false, [], [], 'second-password')
    const changedArgs = OUTPUT_ARGS.map((value, index) => OUTPUT_ARGS[index - 1] === '--username' ? 'different' : value)
    const exitCode = await runCli(['setup', ...changedArgs, '--password-stdin'], io, host)

    expect(exitCode).toBe(4)
    expect(io.stdinReads).toBe(0)
    expect(host.readFile('/export/dsh-auth/dsh-auth.env')).toContain('DSH_AUTH_USERNAME="admin"')
  }, 30_000)

  it('reports drift instead of treating a damaged repeated install as unchanged', async () => {
    const host = new FakeInstallerHost()
    host.addDirectory('/export')
    await runCli(['setup', ...OUTPUT_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'drift-password'), host)
    host.removeFile('/export/dsh-auth/session-secret')
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['setup', ...OUTPUT_ARGS], io, host)

    expect(exitCode).toBe(4)
    expect(io.outputs.join('')).toContain('MANAGED_PATH_MISSING')
  }, 30_000)

  it('recovers an adjacent bootstrap journal left before directory creation', async () => {
    const host = new FakeInstallerHost()
    host.addDirectory('/export')
    await runCli(['setup', ...OUTPUT_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'initial-bootstrap-password'), host)
    const state = JSON.parse(host.readFile('/export/dsh-auth/install-state.json')) as { status: string; createdPaths: string[] }
    for (const path of [...state.createdPaths].reverse()) {
      if (!host.fileExists(path)) continue
      if (host.stat(path).isDirectory) host.removeDirectory(path)
      else host.removeFile(path)
    }
    state.status = 'installing'
    host.addFile('/export/dsh-auth.installing.json', `${JSON.stringify(state)}\n`, 0o600)

    const io = new FakeCliIo(false, [], [], 'recovered-bootstrap-password')
    const exitCode = await runCli(['setup', ...OUTPUT_ARGS, '--password-stdin'], io, host)

    expect(exitCode).toBe(0)
    expect(host.fileExists('/export/dsh-auth.installing.json')).toBe(false)
    expect(JSON.parse(host.readFile('/export/dsh-auth/install-state.json'))).toMatchObject({ status: 'installed' })
  }, 30_000)

  it('cancels missing-Nginx interactive installation before writes or password input', async () => {
    const host = new FakeInstallerHost()
    host.withSystemdService()
    const io = new FakeCliIo(true, [
      'dsh-web.service', '', '', 'http', '10.0.0.20', 'decline',
    ])

    const exitCode = await runCli(['setup'], io, host)

    expect(exitCode).toBe(7)
    expect(io.hiddenReads).toBe(0)
    expect(host.entries.has('/etc/dsh-auth')).toBe(false)
    expect(io.outputs.join('')).toContain('Cancelled before any write')
    expect(io.outputs.join('')).toContain('--authorize-nginx-install')
  })

  it('reports missing required Nginx as stable JSON without writes', async () => {
    const host = new FakeInstallerHost()
    host.withSystemdService()
    const io = new FakeCliIo(false)
    const exitCode = await runCli([
      'plan', '--json', '--non-interactive', '--nginx', 'require', '--mode', 'http', '--listen-address', '10.0.0.20',
      '--dsh-service', 'dsh-web.service', '--user-id', 'admin', '--username', 'admin',
    ], io, host)

    expect(exitCode).toBe(3)
    const output = JSON.parse(io.outputs.join('')) as { readonly plan: { readonly diagnostics: readonly { readonly code: string }[] } }
    expect(output.plan.diagnostics).toContainEqual(expect.objectContaining({ code: 'NGINX_MISSING' }))
    expect(host.entries.has('/etc/dsh-auth')).toBe(false)
  })

  it('rejects inline password syntax without echoing the following secret', async () => {
    const host = new FakeInstallerHost()
    const secret = 'must-not-echo-this-value'
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['setup', ...OUTPUT_ARGS, '--password', secret], io, host)

    expect(exitCode).toBe(2)
    expect(io.outputs.join('')).not.toContain(secret)
    expect(io.errors.join('')).not.toContain(secret)
  })

  it('does not discard trailing hash options or accept uninstall authorization during setup', async () => {
    const hashIo = new FakeCliIo(false, [], [], 'hash-password')
    await expect(runCli(['hash', '--stdin'], hashIo, new FakeInstallerHost())).resolves.toBe(2)
    expect(hashIo.errors.join('')).toContain('--password-stdin')
    expect(hashIo.stdinReads).toBe(0)

    const setupIo = new FakeCliIo(false)
    await expect(runCli(['plan', ...OUTPUT_ARGS, '--authorize-uninstall'], setupIo, new FakeInstallerHost())).resolves.toBe(2)
    await expect(runCli(['plan', ...OUTPUT_ARGS, '--authorize-password-reset'], setupIo, new FakeInstallerHost())).resolves.toBe(2)
    const binIo = new FakeCliIo(false)
    await expect(runCli(['plan', '--dsh-bin', '/usr/local/bin/dsh'], binIo, new FakeInstallerHost())).resolves.toBe(2)
    expect(binIo.errors.join('')).toContain('--dsh-executable')
    await expect(runCli(['hash', '--password-stdin', '--json'], hashIo, new FakeInstallerHost())).resolves.toBe(2)
  })

  it('accepts --name=value flags before the command and output-dir without --nginx skip', async () => {
    const host = new FakeInstallerHost()
    host.addDirectory('/export')
    const io = new FakeCliIo(false)

    const exitCode = await runCli([
      '--json', 'plan', '--non-interactive', '--output-dir=/export/dsh-auth',
      '--mode=http', '--listen-address=127.0.0.1', '--user-id=admin', '--username=admin',
    ], io, host)

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.outputs.join(''))).toMatchObject({ command: 'plan', exitCode: 0 })
  })

  it('keeps --json from disabling TTY prompts', async () => {
    const host = new FakeInstallerHost()
    host.addDirectory('/export')
    const io = new FakeCliIo(true, ['', '', 'http', '127.0.0.1', 'install'], ['json-prompt-password', 'json-prompt-password'])

    const exitCode = await runCli(['setup', '--json', '--output-dir', '/export/json-prompt'], io, host)

    expect(exitCode).toBe(0)
    expect(io.hiddenReads).toBe(2)
    expect(JSON.parse(io.outputs.at(-1) ?? '')).toMatchObject({ command: 'setup', status: 'success' })
  }, 30_000)
})
