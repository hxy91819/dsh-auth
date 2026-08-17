import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.js'
import { verifyPassword } from '../src/password.js'
import { FakeCliIo, FakeInstallerHost } from './installer-helpers.js'

const SYSTEM_ARGS = [
  '--json', '--non-interactive', '--nginx', 'require', '--mode', 'http', '--listen-address', '10.0.0.20',
  '--dsh-service', 'dsh-web.service', '--user-id', 'admin', '--username', 'admin',
] as const

function readyHost(): FakeInstallerHost {
  const host = new FakeInstallerHost()
  host.withSystemdService()
  host.installNginx()
  return host
}

describe('system installer transactions', () => {
  it('rejects a user-writable DSH_HOME for a root service before mutations', async () => {
    const host = readyHost()
    host.chmod('/root/.dsh', 0o777)
    const io = new FakeCliIo(false, [], [], 'unsafe-home-password')

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
    expect(host.commands.slice(mutationCount).some(command => command.args[0] === 'plugin' || command.args[0] === 'restart' || command.args[0] === 'reload')).toBe(false)
  })

  it('rejects an unsafe password file before any managed write', async () => {
    const host = readyHost()
    host.addFile('/root/password-input', 'password', 0o644)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-file', '/root/password-input'], io, host)

    expect(exitCode).toBe(5)
    expect(host.fileExists('/etc/dsh-auth')).toBe(false)
  })

  it('installs fixed-owner files, validates Nginx before reload, and passes doctor', async () => {
    const host = readyHost()
    const password = 'system-password-not-for-output'
    const io = new FakeCliIo(false, [], [], password)

    await expect(runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], io, host)).resolves.toBe(0)

    expect(host.stat('/etc/dsh-auth').mode).toBe(0o750)
    expect(host.stat('/etc/dsh-auth/password-hash').mode).toBe(0o640)
    expect(host.stat('/etc/dsh-auth/session-secret').mode).toBe(0o640)
    expect(host.stat('/var/lib/dsh-auth').mode).toBe(0o700)
    expect(host.stat('/etc/nginx/conf.d/dsh-auth.conf').mode).toBe(0o644)
    expect(host.readFile('/etc/dsh-auth/dsh-auth.env')).not.toContain(password)
    const testIndex = host.commands.findIndex(command => command.executable === '/usr/sbin/nginx' && command.args[0] === '-t')
    const reloadIndex = host.commands.findIndex(command => command.executable === '/usr/bin/systemctl' && command.args[0] === 'reload' && command.args[1] === 'nginx.service')
    expect(testIndex).toBeGreaterThanOrEqual(0)
    expect(reloadIndex).toBeGreaterThan(testIndex)

    const doctorIo = new FakeCliIo(false)
    await expect(runCli(['doctor', '--json'], doctorIo, host)).resolves.toBe(0)
    expect(JSON.parse(doctorIo.outputs.join(''))).toMatchObject({ command: 'doctor', status: 'healthy', exitCode: 0 })
  }, 30_000)

  it('rolls back new files when nginx -t rejects the candidate configuration', async () => {
    const host = readyHost()
    const prior = host.commandHandler
    host.commandHandler = (command) => {
      if (command.executable === '/usr/sbin/nginx' && command.args[0] === '-t' && host.fileExists('/etc/nginx/conf.d/dsh-auth.conf')) {
        return { status: 1, stdout: '', stderr: 'synthetic syntax failure' }
      }
      return prior(command)
    }
    const io = new FakeCliIo(false, [], [], 'rollback-password')

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], io, host)

    expect(exitCode).toBe(6)
    expect(host.fileExists('/etc/nginx/conf.d/dsh-auth.conf')).toBe(false)
    expect(host.fileExists('/etc/dsh-auth/password-hash')).toBe(false)
    expect(host.fileExists('/etc/dsh-auth/session-secret')).toBe(false)
    expect(host.readFile('/etc/dsh-auth/install-state.json')).not.toContain('rollback-password')
    expect(host.commands.some(command => command.args.includes('remove') && command.args.includes('dsh-auth'))).toBe(true)
  }, 30_000)

  it('restores files when Nginx reload fails after a valid syntax test', async () => {
    const host = readyHost()
    const prior = host.commandHandler
    let failed = false
    host.commandHandler = (command) => {
      if (!failed && command.executable === '/usr/bin/systemctl' && command.args[0] === 'reload' && command.args[1] === 'nginx.service') {
        failed = true
        return { status: 1, stdout: '', stderr: 'synthetic reload failure' }
      }
      return prior(command)
    }

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'reload-password'), host)

    expect(exitCode).toBe(6)
    expect(host.fileExists('/etc/nginx/conf.d/dsh-auth.conf')).toBe(false)
    expect(host.fileExists('/etc/systemd/system/dsh-web.service.d/50-dsh-auth.conf')).toBe(false)
    expect(host.fileExists('/etc/dsh-auth/install-state.json')).toBe(true)
    expect(host.commands.filter(command => command.args[0] === 'reload' && command.args[1] === 'nginx.service')).toHaveLength(2)
  }, 30_000)

  it('restores inactive service states after activation fails', async () => {
    const host = readyHost()
    const prior = host.commandHandler
    host.commandHandler = (command) => {
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'show' && command.args[1] === 'dsh-web.service' && command.args.includes('--property=ActiveState')) {
        return { status: 0, stdout: 'inactive\n', stderr: '' }
      }
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'is-active' && command.args[2] === 'nginx.service') {
        return { status: 3, stdout: 'inactive\n', stderr: '' }
      }
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'is-enabled' && command.args[2] === 'nginx.service') {
        return { status: 1, stdout: 'disabled\n', stderr: '' }
      }
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'start' && command.args[1] === 'nginx.service') {
        return { status: 1, stdout: '', stderr: 'synthetic start failure' }
      }
      return prior(command)
    }

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'inactive-rollback-password'), host)

    expect(exitCode).toBe(6)
    expect(host.commands).toContainEqual({ executable: '/usr/bin/systemctl', args: ['stop', 'dsh-web.service'] })
    expect(host.commands).toContainEqual({ executable: '/usr/bin/systemctl', args: ['stop', 'nginx.service'] })
    expect(host.commands).toContainEqual({ executable: '/usr/bin/systemctl', args: ['disable', 'nginx.service'] })
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

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'journal-password'), host)

    expect(exitCode).toBe(6)
    expect(host.commands.some(command => command.args.includes('add') && command.args.includes('dsh-auth@0.1.11'))).toBe(true)
    expect(host.commands.some(command => command.args.includes('remove') && command.args.includes('dsh-auth'))).toBe(true)
    expect(host.readFile('/root/.dsh/profiles/web/package.json')).not.toContain('dsh-auth"')
  }, 30_000)

  it('uses the fixed Ubuntu package argv and records but never removes Nginx', async () => {
    const host = new FakeInstallerHost()
    host.withSystemdService()
    const prior = host.commandHandler
    host.commandHandler = (command) => {
      if (command.executable === '/usr/bin/apt-get' && command.args.join(' ') === 'install --yes nginx') {
        host.installNginx()
        return { status: 0, stdout: '', stderr: '' }
      }
      return prior(command)
    }
    const args = SYSTEM_ARGS.map(value => value === 'require' ? 'install' : value)
    const setupIo = new FakeCliIo(false, [], [], 'package-password')

    await expect(runCli(['setup', ...args, '--authorize-nginx-install', '--password-stdin'], setupIo, host)).resolves.toBe(0)

    expect(host.commands).toContainEqual({ executable: '/usr/bin/apt-get', args: ['update'] })
    expect(host.commands).toContainEqual({ executable: '/usr/bin/apt-get', args: ['install', '--yes', 'nginx'] })
    const state = JSON.parse(host.readFile('/etc/dsh-auth/install-state.json')) as { readonly nginxInstalledByDshAuth: boolean }
    expect(state.nginxInstalledByDshAuth).toBe(true)

    await expect(runCli(['uninstall', '--json', '--authorize-uninstall'], new FakeCliIo(false), host)).resolves.toBe(0)
    expect(host.fileExists('/usr/sbin/nginx')).toBe(true)
    expect(host.commands.some(command => command.executable === '/usr/bin/apt-get' && command.args.includes('remove'))).toBe(false)
  }, 30_000)

  it('keeps a recovery journal but no deployed secrets when package installation fails', async () => {
    const host = new FakeInstallerHost()
    host.withSystemdService()
    const prior = host.commandHandler
    host.commandHandler = (command) => command.executable === '/usr/bin/apt-get'
      ? { status: 1, stdout: '', stderr: 'synthetic package failure' }
      : prior(command)
    const args = SYSTEM_ARGS.map(value => value === 'require' ? 'install' : value)

    const exitCode = await runCli(['setup', ...args, '--authorize-nginx-install', '--password-stdin'], new FakeCliIo(false, [], [], 'package-failure-password'), host)

    expect(exitCode).toBe(6)
    expect(host.fileExists('/etc/dsh-auth/install-state.json')).toBe(true)
    expect(host.fileExists('/etc/dsh-auth/password-hash')).toBe(false)
    expect(host.fileExists('/etc/dsh-auth/session-secret')).toBe(false)
    expect(host.readFile('/etc/dsh-auth/install-state.json')).not.toContain('package-failure-password')
    expect(host.commands.some(command => ['reload', 'restart', 'start', 'stop', 'enable', 'disable'].includes(command.args[0] ?? ''))).toBe(false)
  })

  it('removes the initial managed directory when its first journal write fails', async () => {
    const host = readyHost()
    const write = host.writeNewFile.bind(host)
    host.writeNewFile = (path, content, mode) => {
      if (path === '/etc/dsh-auth.installing.json') throw new Error('synthetic initial journal failure')
      write(path, content, mode)
    }

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'journal-bootstrap-password'), host)

    expect(exitCode).toBe(6)
    expect(host.fileExists('/etc/dsh-auth')).toBe(false)
    expect(host.fileExists('/etc/dsh-auth.installing.json')).toBe(false)
    expect(host.commands.some(command => ['reload', 'restart', 'start', 'stop'].includes(command.args[0] ?? ''))).toBe(false)
  }, 30_000)

  it('fails closed when automatic installation has no supported OS recipe', async () => {
    const host = new FakeInstallerHost()
    host.withSystemdService()
    host.addFile('/etc/os-release', 'ID="unknown"\n', 0o644)
    const args = SYSTEM_ARGS.map(value => value === 'require' ? 'install' : value)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['plan', ...args], io, host)

    expect(exitCode).toBe(3)
    expect(io.outputs.join('')).toContain('NGINX_INSTALL_UNSUPPORTED')
    expect(host.commands.some(command => command.executable === '/usr/bin/apt-get')).toBe(false)
  })

  it('refuses an installed Nginx without a supported config include', async () => {
    const host = readyHost()
    host.addFile('/etc/nginx/nginx.conf', 'events {}\nhttp {}\n', 0o644)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['plan', ...SYSTEM_ARGS], io, host)

    expect(exitCode).toBe(3)
    expect(io.outputs.join('')).toContain('NGINX_INCLUDE_UNSUPPORTED')
  })

  it('blocks before setup when nginx.service is not loaded', async () => {
    const host = readyHost()
    const prior = host.commandHandler
    host.commandHandler = (command) => command.executable === '/usr/bin/systemctl' && command.args[0] === 'show' && command.args[1] === 'nginx.service'
      ? { status: 0, stdout: 'not-found\n', stderr: '' }
      : prior(command)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['plan', ...SYSTEM_ARGS], io, host)

    expect(exitCode).toBe(3)
    expect(io.outputs.join('')).toContain('NGINX_SYSTEMD_REQUIRED')
    expect(host.fileExists('/etc/dsh-auth')).toBe(false)
  })

  it('doctor rejects a widened secret-file mode', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'doctor-password'), host)
    host.chmod('/etc/dsh-auth/session-secret', 0o644)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['doctor', '--json'], io, host)

    expect(exitCode).toBe(8)
    expect(io.outputs.join('')).toContain('MANAGED_MODE_INVALID')
  }, 30_000)

  it('doctor detects a missing profile bundle and changed file owner', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'doctor-drift-password'), host)
    host.removeFile('/root/.dsh/profiles/web/package.json')
    host.chown('/etc/dsh-auth/password-hash', 1234, 1234)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['doctor', '--json'], io, host)

    expect(exitCode).toBe(8)
    expect(io.outputs.join('')).toContain('PROFILE_PACKAGE_MISSING')
    expect(io.outputs.join('')).toContain('MANAGED_OWNER_INVALID')
  }, 30_000)

  it('doctor rejects valid-syntax authentication config drift and an inactive include', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'doctor-config-password'), host)
    host.addFile('/etc/nginx/conf.d/dsh-auth.conf', 'server { listen 10.0.0.20:8080; location / { proxy_pass http://127.0.0.1:3080; } }\n', 0o644)
    host.addFile('/etc/nginx/nginx.conf', 'events {}\nhttp { include /etc/nginx/sites-enabled/*; }\n', 0o644)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['doctor', '--json'], io, host)

    expect(exitCode).toBe(8)
    expect(io.outputs.join('')).toContain('MANAGED_CONTENT_INVALID')
    expect(io.outputs.join('')).toContain('NGINX_INCLUDE_INACTIVE')
  }, 30_000)

  it('rejects unchanged setup when a secret or owner has drifted', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'secret-drift-password'), host)
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

    await expect(runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'group-password'), host)).resolves.toBe(0)

    expect(host.stat('/etc/dsh-auth/password-hash').gid).toBe(2000)
    expect(host.stat('/var/lib/dsh-auth').gid).toBe(2000)
  }, 30_000)

  it('resets the password interactively and revokes existing sessions', async () => {
    const host = readyHost()
    const originalPassword = randomBytes(18).toString('base64url')
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], originalPassword), host)
    const oldHash = host.readFile('/etc/dsh-auth/password-hash')
    const oldSecret = host.readFile('/etc/dsh-auth/session-secret')
    const newPassword = randomBytes(18).toString('base64url')
    const io = new FakeCliIo(true, ['reset-password'], [newPassword, newPassword])

    const exitCode = await runCli(['reset-password'], io, host)

    expect(exitCode).toBe(0)
    const newHash = host.readFile('/etc/dsh-auth/password-hash')
    expect(newHash).not.toBe(oldHash)
    expect(host.readFile('/etc/dsh-auth/session-secret')).not.toBe(oldSecret)
    await expect(verifyPassword(newPassword, newHash.trim())).resolves.toBe(true)
    await expect(verifyPassword(originalPassword, newHash.trim())).resolves.toBe(false)
    expect(io.outputs.join('')).not.toContain(newPassword)
    expect(io.outputs.join('')).toContain('all existing sessions were revoked')
    expect(host.stat('/etc/dsh-auth/password-hash')).toMatchObject({ uid: 0, gid: 0, mode: 0o640 })
  }, 30_000)

  it('cancels interactive password reset before reading or changing credentials', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], randomBytes(18).toString('base64url')), host)
    const oldHash = host.readFile('/etc/dsh-auth/password-hash')
    const oldSecret = host.readFile('/etc/dsh-auth/session-secret')
    const restartCount = host.commands.filter(command => command.args[0] === 'restart').length
    const io = new FakeCliIo(true, ['cancel'])

    const exitCode = await runCli(['reset-password'], io, host)

    expect(exitCode).toBe(7)
    expect(io.hiddenReads).toBe(0)
    expect(host.readFile('/etc/dsh-auth/password-hash')).toBe(oldHash)
    expect(host.readFile('/etc/dsh-auth/session-secret')).toBe(oldSecret)
    expect(host.commands.filter(command => command.args[0] === 'restart')).toHaveLength(restartCount)
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
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, command: 'reset-password', status: 'success', exitCode: 0, sessionsRevoked: true })
  }, 30_000)

  it('restores both credentials when the password-reset restart fails', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], randomBytes(18).toString('base64url')), host)
    const oldHash = host.readFile('/etc/dsh-auth/password-hash')
    const oldSecret = host.readFile('/etc/dsh-auth/session-secret')
    const prior = host.commandHandler
    let failed = false
    host.commandHandler = (command) => {
      if (!failed && command.executable === '/usr/bin/systemctl' && command.args[0] === 'restart' && command.args[1] === 'dsh-web.service') {
        failed = true
        return { status: 1, stdout: '', stderr: 'synthetic reset restart failure' }
      }
      return prior(command)
    }

    const exitCode = await runCli(['reset-password', '--non-interactive', '--authorize-password-reset', '--password-stdin'], new FakeCliIo(false, [], [], randomBytes(18).toString('base64url')), host)

    expect(exitCode).toBe(6)
    expect(host.readFile('/etc/dsh-auth/password-hash')).toBe(oldHash)
    expect(host.readFile('/etc/dsh-auth/session-secret')).toBe(oldSecret)
    expect(host.commands.filter(command => command.args[0] === 'restart' && command.args[1] === 'dsh-web.service')).toHaveLength(3)
  }, 30_000)

  it('refuses to overwrite an unowned Nginx include', async () => {
    const host = readyHost()
    host.addFile('/etc/nginx/conf.d/dsh-auth.conf', '# user-owned\n', 0o644)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], io, host)

    expect(exitCode).toBe(4)
    expect(io.stdinReads).toBe(0)
    expect(host.readFile('/etc/nginx/conf.d/dsh-auth.conf')).toBe('# user-owned\n')
  })

  it.each([
    ['1.22.1', true, 'NGINX_VERSION_UNSUPPORTED'],
    ['1.26.3', false, 'NGINX_AUTH_REQUEST_MISSING'],
  ])('fails closed for Nginx %s auth=%s', async (version, authRequest, expectedCode) => {
    const host = new FakeInstallerHost()
    host.withSystemdService()
    host.installNginx(version, authRequest)
    const io = new FakeCliIo(false)

    const exitCode = await runCli(['plan', ...SYSTEM_ARGS], io, host)

    expect(exitCode).toBe(3)
    expect(io.outputs.join('')).toContain(expectedCode)
    expect(host.fileExists('/etc/dsh-auth')).toBe(false)
  })

  it('restores the public config when uninstall reload fails', async () => {
    const host = readyHost()
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'uninstall-password'), host)
    const prior = host.commandHandler
    let failed = false
    host.commandHandler = (command) => {
      if (!failed && command.executable === '/usr/bin/systemctl' && command.args[0] === 'reload' && command.args[1] === 'nginx.service') {
        failed = true
        return { status: 1, stdout: '', stderr: '' }
      }
      return prior(command)
    }

    const exitCode = await runCli(['uninstall', '--json', '--authorize-uninstall'], new FakeCliIo(false), host)

    expect(exitCode).toBe(6)
    expect(host.fileExists('/etc/nginx/conf.d/dsh-auth.conf')).toBe(true)
    expect(host.fileExists('/etc/dsh-auth/install-state.json')).toBe(true)
  }, 30_000)

  it('refuses a tampered ownership record that points outside exact managed targets', async () => {
    const host = readyHost()
    host.addFile('/etc/important-system-file', 'keep\n', 0o600)
    await runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], 'state-path-password'), host)
    const state = JSON.parse(host.readFile('/etc/dsh-auth/install-state.json')) as { paths: { environmentFile: string }; createdPaths: string[] }
    state.createdPaths = state.createdPaths.map(path => path === state.paths.environmentFile ? '/etc/important-system-file' : path)
    state.paths.environmentFile = '/etc/important-system-file'
    host.addFile('/etc/dsh-auth/install-state.json', `${JSON.stringify(state)}\n`, 0o600)

    const exitCode = await runCli(['uninstall', '--json', '--authorize-uninstall'], new FakeCliIo(false), host)

    expect(exitCode).toBe(4)
    expect(host.readFile('/etc/important-system-file')).toBe('keep\n')
  }, 30_000)
})
