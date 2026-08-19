import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.js'
import { verifyPassword } from '../src/password.js'
import { FakeCliIo, FakeInstallerHost } from './installer-helpers.js'

const PASSWORD = 'sufficient-system-password'
const SYSTEM_ARGS = [
  '--json', '--non-interactive', '--mode', 'http', '--listen-address', '10.0.0.20',
  '--dsh-service', 'dsh-web.service', '--admin-bootstrap', 'password', '--admin-username', 'admin',
  '--login-token', 'disabled',
] as const

function readyHost(): FakeInstallerHost {
  const host = new FakeInstallerHost()
  host.withSystemdService()
  host.installBundledCaddy()
  return host
}

function authPasswordHash(host: FakeInstallerHost): string {
  const document = JSON.parse(host.readFile('/var/lib/dsh-auth/auth-state.json')) as { readonly administrator: { readonly passwordHash: string } }
  return document.administrator.passwordHash
}

// eslint-disable-next-line max-lines-per-function -- 系统 setup/回滚/doctor 事务矩阵按状态机顺序断言，拆分会掩盖故障传播路径；阈值 2026-08 新增，重估于 STORY-06 发布验收。
describe('system installer transactions', () => {
  it('rejects a user-writable DSH_HOME for a root service before mutations', async () => {
    const host = readyHost()
    host.chmod('/root/.dsh', 0o777)
    const io = new FakeCliIo(false, [], [], PASSWORD)

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], io, host)

    expect(exitCode).toBe(5)
    expect(host.fileExists('/etc/dsh-auth')).toBe(false)
    expect(host.commands.some(command => command.args[0] === 'plugin')).toBe(false)
  })

  it('rejects a missing password source before profile, file, or service mutations', async () => {
    const host = readyHost()
    const mutationCount = host.commands.length
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS], io, host)

    expect(exitCode).toBe(2)
    expect(host.fileExists('/etc/dsh-auth')).toBe(false)
    expect(host.commands.slice(mutationCount).some(command => command.args[0] === 'plugin' || command.args[0] === 'restart' || command.args[0] === 'enable')).toBe(false)
  })

  it('rejects an unsafe password file before any managed write', async () => {
    const host = readyHost()
    host.addFile('/root/password-input', PASSWORD, 0o644)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-file', '/root/password-input'], io, host)

    expect(exitCode).toBe(5)
    expect(host.fileExists('/etc/dsh-auth')).toBe(false)
  })

  it('installs fixed-owner files, validates Caddy before enable, and passes doctor', async () => {
    const host = readyHost()
    const io = new FakeCliIo(false, [], [], PASSWORD)

    await expect(runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], io, host)).resolves.toBe(0)

    expect(host.stat('/etc/dsh-auth').mode).toBe(0o750)
    expect(host.stat('/etc/dsh-auth/session-secret').mode).toBe(0o640)
    expect(host.stat('/var/lib/dsh-auth').mode).toBe(0o700)
    expect(host.stat('/var/lib/dsh-auth/auth-state.json').mode).toBe(0o600)
    expect(host.stat('/var/lib/dsh-auth/login-tokens').mode).toBe(0o700)
    expect(host.stat('/etc/dsh-auth/Caddyfile').mode).toBe(0o644)
    expect(host.stat('/usr/lib/dsh-auth/caddy').mode).toBe(0o755)
    expect(host.stat('/etc/systemd/system/dsh-auth-caddy.service').mode).toBe(0o644)
    expect(host.fileExists('/var/lib/dsh-auth-caddy')).toBe(false)
    const installed = JSON.parse(host.readFile('/etc/dsh-auth/install-state.json')) as { readonly createdPaths: readonly string[] }
    expect(installed.createdPaths).not.toContain('/var/lib/dsh-auth-caddy')
    expect(host.readFile('/etc/dsh-auth/dsh-auth.env')).not.toContain(PASSWORD)
    expect(host.readFile('/etc/dsh-auth/dsh-auth.env')).toContain('DSH_AUTH_STATE_FILE=')
    expect(host.readFile('/etc/dsh-auth/Caddyfile')).toContain('admin off')
    expect(host.readFile('/etc/dsh-auth/Caddyfile')).toContain('output file "/var/lib/dsh-auth-caddy/access.log"')
    expect(host.readFile('/etc/dsh-auth/Caddyfile')).toContain('log_skip @skip_access_log')
    expect(host.readFile('/etc/systemd/system/dsh-auth-caddy.service')).toContain('DynamicUser=yes')
    const validateIndex = host.commands.findIndex(command => command.executable === '/usr/lib/dsh-auth/caddy' && command.args[0] === 'validate')
    const enableIndex = host.commands.findIndex(command => command.executable === '/usr/bin/systemctl' && command.args[0] === 'enable' && command.args[2] === 'dsh-auth-caddy.service')
    expect(validateIndex).toBeGreaterThanOrEqual(0)
    expect(enableIndex).toBeGreaterThan(validateIndex)
    expect(JSON.parse(host.readFile('/etc/dsh-auth/install-state.json'))).toMatchObject({ schemaVersion: 2, publicOrigin: 'http://10.0.0.20:8080' })

    const doctorIo = new FakeCliIo(false)
    await expect(runCli(['doctor', '--json'], doctorIo, host)).resolves.toBe(0)
    expect(JSON.parse(doctorIo.outputs.join(''))).toMatchObject({ schemaVersion: 2, command: 'doctor', status: 'healthy', exitCode: 0 })
  }, 30_000)

  it('validates system manual TLS against source certificates before enable', async () => {
    const host = readyHost()
    host.addDirectory('/etc/ssl')
    host.addFile('/etc/ssl/dsh-auth/cert.pem', 'placeholder-cert\n', 0o644)
    host.addFile('/etc/ssl/dsh-auth/key.pem', 'placeholder-key\n', 0o600)
    const io = new FakeCliIo(false, [], [], PASSWORD)
    const args = [
      '--json', '--non-interactive', '--mode', 'https', '--tls', 'manual',
      '--server-name', 'auth.example.test',
      '--certificate', '/etc/ssl/dsh-auth/cert.pem',
      '--certificate-key', '/etc/ssl/dsh-auth/key.pem',
      '--dsh-service', 'dsh-web.service', '--admin-bootstrap', 'password', '--admin-username', 'admin',
      '--login-token', 'disabled',
    ] as const

    await expect(runCli(['setup', ...args, '--password-stdin'], io, host)).resolves.toBe(0)

    expect(host.readFile('/etc/dsh-auth/Caddyfile')).toContain('/run/credentials/dsh-auth-caddy.service/dsh-auth-cert')
    expect(host.readFile('/etc/dsh-auth/Caddyfile')).not.toContain('/etc/ssl/dsh-auth/key.pem')
    expect(host.fileExists('/etc/dsh-auth/Caddyfile.validate')).toBe(false)
    expect(host.commands).toContainEqual({
      executable: '/usr/lib/dsh-auth/caddy',
      args: ['validate', '--config', '/etc/dsh-auth/Caddyfile.validate'],
    })
  }, 30_000)

  it('rolls back new files when Caddy validate rejects the candidate configuration', async () => {
    const host = readyHost()
    const prior = host.commandHandler
    host.commandHandler = (command) => {
      if (command.executable === '/usr/lib/dsh-auth/caddy' && command.args[0] === 'validate' && host.fileExists('/etc/dsh-auth/Caddyfile')) {
        return { status: 1, stdout: '', stderr: 'synthetic syntax failure' }
      }
      return prior(command)
    }
    const io = new FakeCliIo(false, [], [], PASSWORD)

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], io, host)

    expect(exitCode).toBe(6)
    expect(host.fileExists('/etc/dsh-auth/Caddyfile')).toBe(false)
    expect(host.fileExists('/etc/dsh-auth/session-secret')).toBe(false)
    expect(host.fileExists('/usr/lib/dsh-auth/caddy')).toBe(false)
    expect(host.readFile('/etc/dsh-auth/install-state.json')).not.toContain(PASSWORD)
    expect(host.commands.some(command => command.args.includes('remove') && command.args.includes('dsh-auth'))).toBe(true)
  }, 30_000)

  it('restores files when Caddy enable fails after a valid configuration', async () => {
    const host = readyHost()
    const prior = host.commandHandler
    let failed = false
    host.commandHandler = (command) => {
      if (!failed && command.executable === '/usr/bin/systemctl' && command.args[0] === 'enable' && command.args.includes('dsh-auth-caddy.service')) {
        failed = true
        return { status: 1, stdout: '', stderr: 'synthetic enable failure' }
      }
      return prior(command)
    }

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)

    expect(exitCode).toBe(6)
    expect(host.fileExists('/etc/dsh-auth/Caddyfile')).toBe(false)
    expect(host.fileExists('/etc/systemd/system/dsh-web.service.d/50-dsh-auth.conf')).toBe(false)
    expect(host.fileExists('/etc/dsh-auth/install-state.json')).toBe(true)
    expect(host.commands.filter(command => command.args[0] === 'enable' && command.args.includes('dsh-auth-caddy.service'))).toHaveLength(1)
    expect(host.commands).toContainEqual({ executable: '/usr/bin/systemctl', args: ['disable', '--now', 'dsh-auth-caddy.service'] })
  }, 30_000)

  it('restores inactive service states after activation fails', async () => {
    const host = readyHost()
    const prior = host.commandHandler
    host.commandHandler = (command) => {
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'show' && command.args[1] === 'dsh-web.service' && command.args.includes('--property=ActiveState')) {
        return { status: 0, stdout: 'inactive\n', stderr: '' }
      }
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'is-active' && command.args[2] === 'dsh-auth-caddy.service') {
        return { status: 3, stdout: 'inactive\n', stderr: '' }
      }
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'is-enabled' && command.args[2] === 'dsh-auth-caddy.service') {
        return { status: 1, stdout: 'disabled\n', stderr: '' }
      }
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'enable' && command.args.includes('dsh-auth-caddy.service')) {
        return { status: 1, stdout: '', stderr: 'synthetic start failure' }
      }
      return prior(command)
    }

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)

    expect(exitCode).toBe(6)
    expect(host.commands).toContainEqual({ executable: '/usr/bin/systemctl', args: ['stop', 'dsh-web.service'] })
    expect(host.commands).toContainEqual({ executable: '/usr/bin/systemctl', args: ['disable', '--now', 'dsh-auth-caddy.service'] })
  }, 30_000)

  it('uses a pre-recorded profile action to recover from the next journal write failure', async () => {
    const host = readyHost()
    const replace = host.replaceFile.bind(host)
    let stateWrites = 0
    host.replaceFile = (path, content, mode) => {
      if (path === '/etc/dsh-auth/install-state.json') {
        stateWrites += 1
        if (stateWrites === 2) throw new Error('synthetic state write failure')
      }
      replace(path, content, mode)
    }

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)

    expect(exitCode).toBe(6)
    expect(host.commands.some(command => command.args.includes('add') && command.args.some(argument => /^dsh-auth@\d+\.\d+\.\d+$/u.test(argument)))).toBe(true)
    expect(host.commands.some(command => command.args.includes('remove') && command.args.includes('dsh-auth'))).toBe(true)
    expect(host.readFile('/root/.dsh/profiles/web/package.json')).not.toContain('dsh-auth"')
  }, 30_000)

  it('fails closed before mutations when bundled Caddy is missing', async () => {
    const host = new FakeInstallerHost()
    host.withSystemdService()
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['plan', ...SYSTEM_ARGS], io, host)

    expect(exitCode).toBe(3)
    expect(io.outputs.join('')).toContain('CADDY_PACKAGE_MISSING')
    expect(host.fileExists('/etc/dsh-auth')).toBe(false)
    expect(host.commands.some(command => command.args[0] === 'plugin')).toBe(false)
  })

  it('fails closed when a required public port is already in use', async () => {
    const host = readyHost()
    host.busyPorts.add('10.0.0.20:8080')
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['plan', ...SYSTEM_ARGS], io, host)

    expect(exitCode).toBe(4)
    expect(io.outputs.join('')).toContain('PUBLIC_PORT_IN_USE')
    expect(host.fileExists('/etc/dsh-auth')).toBe(false)
  })

  it('removes the initial managed directory when its first journal write fails', async () => {
    const host = readyHost()
    const write = host.writeNewFile.bind(host)
    host.writeNewFile = (path, content, mode) => {
      if (path === '/etc/dsh-auth.installing.json') throw new Error('synthetic initial journal failure')
      write(path, content, mode)
    }

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)

    expect(exitCode).toBe(6)
    expect(host.fileExists('/etc/dsh-auth')).toBe(false)
    expect(host.fileExists('/etc/dsh-auth.installing.json')).toBe(false)
    expect(host.commands.some(command => ['reload', 'restart', 'start', 'stop', 'enable'].includes(command.args[0] ?? ''))).toBe(false)
  }, 30_000)

  it('doctor rejects a widened secret-file mode', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)
    host.chmod('/etc/dsh-auth/session-secret', 0o644)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['doctor', '--json'], io, host)

    expect(exitCode).toBe(8)
    expect(io.outputs.join('')).toContain('MANAGED_MODE_INVALID')
  }, 30_000)

  it('doctor detects a missing profile bundle and changed file owner', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)
    host.removeFile('/root/.dsh/profiles/web/package.json')
    host.chown('/var/lib/dsh-auth/auth-state.json', 1234, 1234)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['doctor', '--json'], io, host)

    expect(exitCode).toBe(8)
    expect(io.outputs.join('')).toContain('PROFILE_PACKAGE_MISSING')
    expect(io.outputs.join('')).toContain('MANAGED_OWNER_INVALID')
  }, 30_000)

  it('doctor rejects valid-syntax Caddy configuration drift', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)
    host.addFile('/etc/dsh-auth/Caddyfile', '{\n\tadmin :2019\n}\n', 0o644)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['doctor', '--json'], io, host)

    expect(exitCode).toBe(8)
    expect(io.outputs.join('')).toContain('MANAGED_CONTENT_INVALID')
  }, 30_000)

  it('rejects unchanged setup when a secret or owner has drifted', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)
    host.addFile('/etc/dsh-auth/session-secret', '\n', 0o640, 0, 0)
    const secretIo = new FakeCliIo(false)
    await expect(runCli(['setup', ...SYSTEM_ARGS], secretIo, host)).resolves.toBe(4)
    expect(secretIo.outputs.join('')).toContain('SESSION_SECRET_INVALID')

    host.addFile('/etc/dsh-auth/session-secret', `${Buffer.alloc(32, 0xa5).toString('base64url')}\n`, 0o640, 0, 0)
    host.chown('/etc/dsh-auth/dsh-auth.env', 1234, 1234)
    const ownerIo = new FakeCliIo(false)
    await expect(runCli(['setup', ...SYSTEM_ARGS], ownerIo, host)).resolves.toBe(4)
    expect(ownerIo.outputs.join('')).toContain('MANAGED_OWNER_DRIFT')
  }, 30_000)

  it('uses the systemd Group identity for service-readable files', async () => {
    const host = readyHost()
    const prior = host.commandHandler
    host.commandHandler = (command) => {
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'show' && command.args[1] === 'dsh-web.service' && command.args.includes('--property=Group')) {
        return { status: 0, stdout: 'dsh-auth\n', stderr: '' }
      }
      return prior(command)
    }

    await expect(runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)).resolves.toBe(0)

    expect(host.stat('/etc/dsh-auth/session-secret').gid).toBe(2000)
    expect(host.stat('/var/lib/dsh-auth').gid).toBe(2000)
    expect(host.stat('/var/lib/dsh-auth/auth-state.json')).toMatchObject({ uid: 0, gid: 2000, mode: 0o600 })
  }, 30_000)

  it('resets the password interactively and revokes existing sessions', async () => {
    const host = readyHost()
    const originalPassword = randomBytes(18).toString('base64url')
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], originalPassword), host)
    const oldHash = authPasswordHash(host)
    const oldSecret = host.readFile('/etc/dsh-auth/session-secret')
    const newPassword = randomBytes(18).toString('base64url')
    const io = new FakeCliIo(true, ['reset-password'], [newPassword, newPassword])

    const exitCode = await runCli(['reset-password'], io, host)

    expect(exitCode).toBe(0)
    const newHash = authPasswordHash(host)
    expect(newHash).not.toBe(oldHash)
    expect(host.readFile('/etc/dsh-auth/session-secret')).not.toBe(oldSecret)
    await expect(verifyPassword(newPassword, newHash)).resolves.toBe(true)
    await expect(verifyPassword(originalPassword, newHash)).resolves.toBe(false)
    expect(io.outputs.join('')).not.toContain(newPassword)
    expect(io.outputs.join('')).toContain('all existing sessions were revoked')
    expect(host.stat('/var/lib/dsh-auth/auth-state.json')).toMatchObject({ uid: 0, gid: 0, mode: 0o600 })
  }, 30_000)

  it('cancels interactive password reset before reading or changing credentials', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], randomBytes(18).toString('base64url')), host)
    const oldHash = authPasswordHash(host)
    const oldSecret = host.readFile('/etc/dsh-auth/session-secret')
    const stopCount = host.commands.filter(command => command.args[0] === 'stop').length
    const io = new FakeCliIo(true, ['cancel'])

    const exitCode = await runCli(['reset-password'], io, host)

    expect(exitCode).toBe(7)
    expect(io.hiddenReads).toBe(0)
    expect(authPasswordHash(host)).toBe(oldHash)
    expect(host.readFile('/etc/dsh-auth/session-secret')).toBe(oldSecret)
    expect(host.commands.filter(command => command.args[0] === 'stop')).toHaveLength(stopCount)
  }, 30_000)

  it('requires explicit non-interactive password-reset authorization and emits secret-free JSON', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], randomBytes(18).toString('base64url')), host)
    const password = randomBytes(18).toString('base64url')
    const denied = new FakeCliIo(false, [], [], password)

    await expect(runCli(['reset-password', '--non-interactive', '--json', '--password-stdin'], denied, host)).resolves.toBe(2)
    expect(denied.stdinReads).toBe(0)

    const allowed = new FakeCliIo(false, [], [], password)
    await expect(runCli(['reset-password', '--non-interactive', '--json', '--authorize-password-reset', '--password-stdin'], allowed, host)).resolves.toBe(0)
    const output = allowed.outputs.join('')
    expect(output).not.toContain(password)
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 2, command: 'reset-password', status: 'success', exitCode: 0, sessionsRevoked: true })
  }, 30_000)

  it('restores both credentials when the password-reset start fails', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], randomBytes(18).toString('base64url')), host)
    const oldHash = authPasswordHash(host)
    const oldSecret = host.readFile('/etc/dsh-auth/session-secret')
    const prior = host.commandHandler
    let failed = false
    host.commandHandler = (command) => {
      if (!failed && command.executable === '/usr/bin/systemctl' && command.args[0] === 'start' && command.args[1] === 'dsh-web.service') {
        failed = true
        return { status: 1, stdout: '', stderr: 'synthetic reset start failure' }
      }
      return prior(command)
    }

    const exitCode = await runCli(['reset-password', '--non-interactive', '--authorize-password-reset', '--password-stdin'], new FakeCliIo(false, [], [], randomBytes(18).toString('base64url')), host)

    expect(exitCode).toBe(6)
    expect(authPasswordHash(host)).toBe(oldHash)
    expect(host.readFile('/etc/dsh-auth/session-secret')).toBe(oldSecret)
    expect(host.commands.filter(command => command.args[0] === 'stop' && command.args[1] === 'dsh-web.service').length).toBeGreaterThanOrEqual(1)
    expect(host.commands.filter(command => command.args[0] === 'start' && command.args[1] === 'dsh-web.service')).toHaveLength(2)
  }, 30_000)

  it('refuses to overwrite an unowned Caddyfile', async () => {
    const host = readyHost()
    host.addDirectory('/etc/dsh-auth', 0o750)
    host.addFile('/etc/dsh-auth/Caddyfile', '# user-owned\n', 0o644)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], io, host)

    expect(exitCode).toBe(4)
    expect(io.stdinReads).toBe(0)
    expect(host.readFile('/etc/dsh-auth/Caddyfile')).toBe('# user-owned\n')
  })

  it('restores the owned unit when uninstall cannot stop Caddy', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)
    const prior = host.commandHandler
    let failed = false
    host.commandHandler = (command) => {
      if (!failed && command.executable === '/usr/bin/systemctl' && command.args[0] === 'disable' && command.args.includes('dsh-auth-caddy.service')) {
        failed = true
        return { status: 1, stdout: '', stderr: '' }
      }
      return prior(command)
    }

    const exitCode = await runCli(['uninstall', '--json', '--authorize-uninstall'], new FakeCliIo(false), host)

    expect(exitCode).toBe(6)
    expect(host.fileExists('/etc/dsh-auth/Caddyfile')).toBe(true)
    expect(host.fileExists('/etc/dsh-auth/install-state.json')).toBe(true)
  }, 30_000)

  it('removes issued login tokens with the owned state directories', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)
    const tokenFile = `/var/lib/dsh-auth/login-tokens/${'a'.repeat(64)}`
    host.addFile(tokenFile, '{"schemaVersion":1,"issuedAt":1,"expiresAt":2}\n', 0o600)

    const exitCode = await runCli(['uninstall', '--json', '--authorize-uninstall'], new FakeCliIo(false), host)

    expect(exitCode).toBe(0)
    expect(host.fileExists(tokenFile)).toBe(false)
    expect(host.fileExists('/var/lib/dsh-auth/login-tokens')).toBe(false)
    expect(host.fileExists('/etc/dsh-auth/install-state.json')).toBe(false)
  }, 30_000)

  it('restores every owned path, issued token, profile, and Caddy after uninstall reload fails', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)
    const state = JSON.parse(host.readFile('/etc/dsh-auth/install-state.json')) as { createdPaths: string[] }
    const tokenFile = `/var/lib/dsh-auth/login-tokens/${'b'.repeat(64)}`
    host.addFile(tokenFile, '{"schemaVersion":1,"issuedAt":1,"expiresAt":2}\n', 0o600)
    const prior = host.commandHandler
    let failed = false
    host.commandHandler = command => {
      if (!failed && command.executable === '/usr/bin/systemctl' && command.args[0] === 'daemon-reload') {
        failed = true
        return { status: 1, stdout: '', stderr: '' }
      }
      return prior(command)
    }

    const exitCode = await runCli(['uninstall', '--json', '--authorize-uninstall'], new FakeCliIo(false), host)

    expect(exitCode).toBe(6)
    expect(state.createdPaths.every(path => host.fileExists(path))).toBe(true)
    expect(host.fileExists(tokenFile)).toBe(true)
    expect(host.readFile('/root/.dsh/profiles/web/package.json')).toContain('dsh-auth')
    expect(host.commands.some(command => command.args[0] === 'enable' && command.args.includes('dsh-auth-caddy.service'))).toBe(true)
  }, 30_000)

  it('refuses a tampered ownership record that points outside exact managed targets', async () => {
    const host = readyHost()
    host.addFile('/etc/important-system-file', 'keep\n', 0o600)
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)
    const state = JSON.parse(host.readFile('/etc/dsh-auth/install-state.json')) as { paths: { environmentFile: string }; createdPaths: string[] }
    state.createdPaths = state.createdPaths.map(path => path === state.paths.environmentFile ? '/etc/important-system-file' : path)
    state.paths.environmentFile = '/etc/important-system-file'
    host.addFile('/etc/dsh-auth/install-state.json', `${JSON.stringify(state)}\n`, 0o600)

    const exitCode = await runCli(['uninstall', '--json', '--authorize-uninstall'], new FakeCliIo(false), host)

    expect(exitCode).toBe(4)
    expect(host.readFile('/etc/important-system-file')).toBe('keep\n')
  }, 30_000)
})
