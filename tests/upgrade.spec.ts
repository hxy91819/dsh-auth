import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runCli } from '../src/cli.js'
import { compareVersions } from '../src/installer/upgrade.js'
import type { UpgradeJournal } from '../src/installer/upgrade.js'
import { FakeCliIo, FakeInstallerHost } from './installer-helpers.js'

const PASSWORD = 'sufficient-system-password'
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { readonly version: string }).version
const SYSTEM_ARGS = [
  '--json', '--non-interactive', '--mode', 'http', '--listen-address', '10.0.0.20',
  '--dsh-service', 'dsh-web.service', '--admin-bootstrap', 'password', '--admin-username', 'admin',
  '--login-token', 'disabled',
] as const
const UPGRADE_ARGS = ['upgrade', '--json', '--non-interactive', '--authorize-upgrade'] as const
const STATE_FILE = '/etc/dsh-auth/install-state.json'
const BUNDLE_ROOT = '/root/.dsh/profiles/web/node_modules/dsh-auth'

function readyHost(): FakeInstallerHost {
  const host = new FakeInstallerHost()
  host.withSystemdService()
  host.installCliPackage(PACKAGE_VERSION)
  host.installBundledCaddy()
  return host
}

async function setupInstalled(host: FakeInstallerHost): Promise<void> {
  await expect(runCli(['setup', ...SYSTEM_ARGS, '--password-stdin'], new FakeCliIo(false, [], [], PASSWORD), host)).resolves.toBe(0)
}

interface UpgradeState {
  readonly status: string
  readonly profilePackageVersion?: string
  readonly profilePackageSpec?: string
  readonly profilePackageBuildIdentity?: string
  readonly caddyBinarySha256?: string
  readonly upgrade?: unknown
}

function stateOf(host: FakeInstallerHost): UpgradeState {
  return JSON.parse(host.readFile(STATE_FILE)) as UpgradeState
}

describe('managed upgrade', () => {
  it('compares release versions with semver ordering and prerelease precedence', () => {
    expect(compareVersions('0.3.0', '0.2.0')).toBeGreaterThan(0)
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.2.0', '0.3.0')).toBeLessThan(0)
    expect(compareVersions('0.3.0', '0.3.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('0.3.0-rc.2', '0.3.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('0.3.0-rc.1', '0.3.0')).toBeLessThan(0)
    expect(() => compareVersions('latest', '0.2.0')).toThrow(/not a comparable release version/u)
  })

  it('moves bundle, Caddy, record, and services to the CLI build and keeps credentials', async () => {
    const host = readyHost()
    await setupInstalled(host)
    const authStateBefore = host.readFileBytes('/var/lib/dsh-auth/auth-state.json')
    const secretBefore = host.readFileBytes('/etc/dsh-auth/session-secret')
    host.promoteCliPackage('0.3.0')

    const io = new FakeCliIo(false)
    await expect(runCli([...UPGRADE_ARGS], io, host)).resolves.toBe(0)

    const state = stateOf(host)
    expect(state.status).toBe('installed')
    expect(state.profilePackageVersion).toBe('0.3.0')
    expect(state.profilePackageSpec).toBe('0.3.0')
    expect(state.upgrade).toBeUndefined()
    expect(JSON.parse(host.readFile(`${BUNDLE_ROOT}/package.json`))).toMatchObject({ version: '0.3.0' })
    expect(host.readFile('/etc/dsh-auth/dsh-auth.env')).toContain('DSH_AUTH_EXPECTED_VERSION="0.3.0"')
    expect(host.readFileBytes('/var/lib/dsh-auth/auth-state.json')).toEqual(authStateBefore)
    expect(host.readFileBytes('/etc/dsh-auth/session-secret')).toEqual(secretBefore)
    expect(host.commands.some(command => command.args.includes('add') && command.args.includes('dsh-auth@0.3.0'))).toBe(true)
    expect(host.commands).toContainEqual({ executable: '/usr/bin/systemctl', args: ['restart', 'dsh-web.service'] })
    expect(host.commands).toContainEqual({ executable: '/usr/bin/systemctl', args: ['restart', 'dsh-auth-caddy.service'] })
    expect(host.commands.some(command => command.executable === '/usr/lib/dsh-auth/caddy' && command.args[0] === 'validate')).toBe(true)
    await expect(runCli(['doctor', '--json'], new FakeCliIo(false), host)).resolves.toBe(0)
  }, 30_000)

  it('refuses same-version and downgrade targets before any mutation', async () => {
    const same = readyHost()
    await setupInstalled(same)
    const io = new FakeCliIo(false)
    const setupCommands = same.commands.length
    await expect(runCli([...UPGRADE_ARGS], io, same)).resolves.toBe(4)
    expect(io.outputs.join('')).toContain('UPGRADE_VERSION_NOT_HIGHER')
    expect(same.commands.slice(setupCommands).some(command => command.args[0] === 'plugin')).toBe(false)
    expect(stateOf(same).profilePackageVersion).toBe(PACKAGE_VERSION)

    const downgrade = readyHost()
    await setupInstalled(downgrade)
    downgrade.promoteCliPackage('0.1.0')
    const downgradeIo = new FakeCliIo(false)
    await expect(runCli([...UPGRADE_ARGS], downgradeIo, downgrade)).resolves.toBe(4)
    expect(downgradeIo.outputs.join('')).toContain('UPGRADE_VERSION_NOT_HIGHER')
  }, 30_000)

  it('rolls the installation back when the target does not resolve to this build', async () => {
    const host = readyHost()
    await setupInstalled(host)
    host.promoteCliPackage('0.3.0')
    const prior = host.commandHandler
    host.commandHandler = command => {
      const result = prior(command)
      if (command.executable === '/opt/dsh/bin/dsh' && command.args.includes('add') && command.args.at(-1) === 'dsh-auth@0.3.0') {
        host.addFile(`${BUNDLE_ROOT}/lib/foreign-build.txt`, 'not this build\n')
      }
      return result
    }

    const io = new FakeCliIo(false)
    await expect(runCli([...UPGRADE_ARGS], io, host)).resolves.toBe(6)
    expect(io.outputs.join('')).toContain('UPGRADE_TARGET_BUILD_MISMATCH')

    const state = stateOf(host)
    expect(state.status).toBe('installed')
    expect(state.profilePackageVersion).toBe(PACKAGE_VERSION)
    expect(state.upgrade).toBeUndefined()
    expect(host.commands.some(command => command.args.includes('add') && command.args.at(-1) === PACKAGE_VERSION)).toBe(true)
    expect(JSON.parse(host.readFile(`${BUNDLE_ROOT}/package.json`))).toMatchObject({ version: PACKAGE_VERSION })
    expect(host.readFile('/etc/dsh-auth/dsh-auth.env')).toContain(`DSH_AUTH_EXPECTED_VERSION="${PACKAGE_VERSION}"`)
    await expect(runCli(['doctor', '--json'], new FakeCliIo(false), host)).resolves.toBe(0)
  }, 30_000)

  it('rolls the bundle, binary, environment, and record back when Caddy validation fails', async () => {
    const host = readyHost()
    await setupInstalled(host)
    host.promoteCliPackage('0.3.0')
    const prior = host.commandHandler
    let failedOnce = false
    host.commandHandler = command => {
      if (!failedOnce && command.executable === '/usr/lib/dsh-auth/caddy' && command.args[0] === 'validate' && host.fileExists('/etc/dsh-auth/Caddyfile') && stateOf(host).status === 'installing') {
        failedOnce = true
        return { status: 1, stdout: '', stderr: 'synthetic upgrade validation failure' }
      }
      return prior(command)
    }

    const io = new FakeCliIo(false)
    await expect(runCli([...UPGRADE_ARGS], io, host)).resolves.toBe(6)

    const state = stateOf(host)
    expect(state.status).toBe('installed')
    expect(state.profilePackageVersion).toBe(PACKAGE_VERSION)
    expect(state.upgrade).toBeUndefined()
    expect(JSON.parse(host.readFile(`${BUNDLE_ROOT}/package.json`))).toMatchObject({ version: PACKAGE_VERSION })
    expect(host.readFile('/etc/dsh-auth/dsh-auth.env')).toContain(`DSH_AUTH_EXPECTED_VERSION="${PACKAGE_VERSION}"`)
    expect(host.commands).toContainEqual({ executable: '/usr/bin/systemctl', args: ['restart', 'dsh-web.service'] })
    await expect(runCli(['doctor', '--json'], new FakeCliIo(false), host)).resolves.toBe(0)
  }, 30_000)

  it('refuses missing installations, v1 records, and interrupted setups', async () => {
    const missing = readyHost()
    const missingIo = new FakeCliIo(false)
    await expect(runCli([...UPGRADE_ARGS], missingIo, missing)).resolves.toBe(8)
    expect(missingIo.outputs.join('')).toContain('INSTALLATION_NOT_FOUND')

    const v1 = readyHost()
    v1.addFile(STATE_FILE, '{"schemaVersion":1}\n', 0o600)
    await expect(runCli([...UPGRADE_ARGS], new FakeCliIo(false), v1)).resolves.toBe(4)

    const interrupted = readyHost()
    await setupInstalled(interrupted)
    const state = stateOf(interrupted) as { status: string }
    const tampered = { ...state, status: 'installing' }
    interrupted.addFile(STATE_FILE, `${JSON.stringify(tampered)}\n`, 0o600)
    const interruptedIo = new FakeCliIo(false)
    await expect(runCli([...UPGRADE_ARGS], interruptedIo, interrupted)).resolves.toBe(8)
    expect(interruptedIo.outputs.join('')).toContain('INSTALLATION_INTERRUPTED')
  }, 30_000)

  it('refuses drifted bundles with the fixed three-step recovery order', async () => {
    const host = readyHost()
    await setupInstalled(host)
    host.addFile(`${BUNDLE_ROOT}/lib/drifted.txt`, 'externally updated\n')
    host.promoteCliPackage('0.3.0')

    const setupCommands = host.commands.length
    const io = new FakeCliIo(false)
    await expect(runCli([...UPGRADE_ARGS], io, host)).resolves.toBe(8)
    const output = io.outputs.join('')
    expect(output).toContain('PROFILE_PACKAGE_BUILD_DRIFT')
    expect(output).toContain(`dsh plugin --profile web add ${PACKAGE_VERSION}`)
    expect(output).toContain('rerun dsh-auth doctor')
    expect(output).toContain('run dsh-auth upgrade')
    expect(host.commands.slice(setupCommands).some(command => command.args[0] === 'plugin' || command.args[0] === 'restart')).toBe(false)
  }, 30_000)

  it('recovers a crash-interrupted upgrade and completes a fresh attempt', async () => {
    const host = readyHost()
    await setupInstalled(host)
    host.promoteCliPackage('0.3.0')
    const recorded = stateOf(host)
    // Simulate a crash after the bundle was swapped to the target build.
    host.run({ executable: '/opt/dsh/bin/dsh', args: ['plugin', '--profile', 'web', 'add', 'dsh-auth@0.3.0'] })
    const journal: UpgradeJournal = {
      fromVersion: PACKAGE_VERSION,
      fromSpec: PACKAGE_VERSION,
      fromBuildIdentity: recorded.profilePackageBuildIdentity ?? '',
      targetVersion: '0.3.0',
      targetBuildIdentity: 'not-recorded-for-crash',
      phase: 'bundle',
    }
    host.addFile(STATE_FILE, `${JSON.stringify({ ...recorded, status: 'installing', upgrade: journal })}\n`, 0o600)

    const io = new FakeCliIo(false)
    await expect(runCli([...UPGRADE_ARGS], io, host)).resolves.toBe(0)

    const state = stateOf(host)
    expect(state.status).toBe('installed')
    expect(state.profilePackageVersion).toBe('0.3.0')
    expect(state.upgrade).toBeUndefined()
    expect(JSON.parse(host.readFile(`${BUNDLE_ROOT}/package.json`))).toMatchObject({ version: '0.3.0' })
    await expect(runCli(['doctor', '--json'], new FakeCliIo(false), host)).resolves.toBe(0)
  }, 30_000)

  it('prints the secret-free plan for --dry-run and enforces interactive confirmation', async () => {
    const host = readyHost()
    await setupInstalled(host)
    host.promoteCliPackage('0.3.0')

    const setupCommands = host.commands.length
    const dryIo = new FakeCliIo(false)
    await expect(runCli(['upgrade', '--json', '--dry-run', '--non-interactive'], dryIo, host)).resolves.toBe(0)
    const document = JSON.parse(dryIo.outputs.join('')) as { command: string; plan: { status: string; actions: { id: string }[] } }
    expect(document.command).toBe('upgrade')
    expect(document.plan.status).toBe('ready')
    expect(document.plan.actions.map(action => action.id)).toContain('install-profile-package')
    expect(host.commands.slice(setupCommands).some(command => command.args[0] === 'plugin' || command.args[0] === 'restart')).toBe(false)

    const cancelled = new FakeCliIo(true, ['no'])
    await expect(runCli(['upgrade', '--json'], cancelled, host)).resolves.toBe(7)
    expect(host.commands.slice(setupCommands).some(command => command.args[0] === 'plugin')).toBe(false)

    const unauthorized = new FakeCliIo(false)
    await expect(runCli(['upgrade', '--json', '--non-interactive'], unauthorized, host)).resolves.toBe(2)

    const confirmed = new FakeCliIo(true, ['upgrade'])
    await expect(runCli(['upgrade', '--json'], confirmed, host)).resolves.toBe(0)
    expect(stateOf(host).profilePackageVersion).toBe('0.3.0')
  }, 30_000)
})
