import { dirname } from 'node:path'
import { join } from 'node:path'
import { hashPassword } from '../password.js'
import { renderEnvironmentFile, renderSystemdDropIn, serializeInstallState } from './config-files.js'
import { discoverNginx } from './nginx.js'
import { InstallerError } from './errors.js'
import { bootstrapStatePath, initialInstallState, readInstallState, validateStatePaths } from './plan.js'
import { ExitCode, type CommandSpec, type InstallState, type InstallerHost, type PreparedSetup } from './types.js'

/** Secret reader invoked only after planning and confirmation complete. */
export interface SetupSecrets {
  readPassword(): Promise<string>
}

function systemctl(host: InstallerHost): string {
  const path = ['/usr/bin/systemctl', '/bin/systemctl'].find(candidate => host.regularFile(candidate))
  if (path === undefined) throw new InstallerError('systemctl is unavailable', ExitCode.prerequisite)
  return path
}

function runChecked(host: InstallerHost, command: CommandSpec, code: string, env?: NodeJS.ProcessEnv): void {
  const result = host.run(command, env === undefined ? undefined : { env })
  if (result.error !== undefined || result.status !== 0) {
    throw new InstallerError(`command failed: ${code}`, ExitCode.execution, [{
      code,
      severity: 'error',
      message: `${command.executable} exited unsuccessfully; output was withheld to avoid leaking deployment data.`,
    }])
  }
}

function updateState(host: InstallerHost, state: InstallState, changes: Partial<InstallState>): InstallState {
  const updated = { ...state, ...changes }
  host.replaceFile(state.paths.stateFile, serializeInstallState(updated), 0o600)
  return updated
}

function appendCreated(host: InstallerHost, state: InstallState, path: string): InstallState {
  return updateState(host, state, { createdPaths: [...state.createdPaths, path] })
}

function ensureDirectory(host: InstallerHost, state: InstallState, path: string, mode: number, uid: number, gid: number): InstallState {
  if (host.fileExists(path)) {
    const stat = host.stat(path)
    if (!stat.isDirectory || stat.mode !== mode || stat.uid !== uid || stat.gid !== gid) {
      throw new InstallerError(`managed directory has unexpected ownership or permissions: ${path}`, ExitCode.conflict)
    }
    return state
  }
  const pending = appendCreated(host, state, path)
  host.mkdir(path, mode)
  host.chown(path, uid, gid)
  host.chmod(path, mode)
  return pending
}

function writeOwnedFile(
  host: InstallerHost,
  state: InstallState,
  path: string,
  content: string | Buffer,
  mode: number,
  uid: number,
  gid: number,
): InstallState {
  const pending = appendCreated(host, state, path)
  host.writeNewFile(path, content, mode)
  host.chown(path, uid, gid)
  host.chmod(path, mode)
  return pending
}

function profileCommand(host: InstallerHost, state: InstallState, args: readonly string[]): CommandSpec {
  if (state.request.outputDirectory !== undefined) throw new InstallerError('output mode has no DSH profile command', ExitCode.execution)
  if (state.dshUser === 'root') return { executable: state.dshExecutable, args }
  const runuser = ['/usr/sbin/runuser', '/usr/bin/runuser'].find(candidate => host.regularFile(candidate))
  if (runuser === undefined) throw new InstallerError('runuser is required for a non-root DSH service', ExitCode.prerequisite)
  return { executable: runuser, args: ['--user', state.dshUser, '--', state.dshExecutable, ...args] }
}

function dshEnvironment(state: InstallState): NodeJS.ProcessEnv {
  return {
    DSH_HOME: state.dshHome,
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  }
}

function assertSafeRootDirectory(host: InstallerHost, path: string): void {
  let current = path
  for (;;) {
    const stat = host.stat(current)
    if (!stat.isDirectory || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new InstallerError(`root-managed parent directory is unsafe: ${current}`, ExitCode.permission)
    }
    if (current === '/') return
    const parent = current.slice(0, current.lastIndexOf('/')) || '/'
    current = parent
  }
}

function validateInstalledNginx(host: InstallerHost, expectedConfigFile: string): ReturnType<typeof discoverNginx> {
  const nginx = discoverNginx(host)
  if (!nginx.installed || !nginx.versionSupported || !nginx.authRequestModule || nginx.includePath !== expectedConfigFile || nginx.serviceName !== 'nginx.service' || nginx.serviceLoadState !== 'loaded') {
    throw new InstallerError('installed Nginx does not satisfy the supported configuration', ExitCode.prerequisite, [{
      code: 'NGINX_POST_INSTALL_INVALID',
      severity: 'error',
      message: 'The operating-system package did not provide Nginx 1.24+, auth_request, a supported include, and nginx.service.',
      remediation: 'Keep the package for inspection, correct the Nginx installation, and rerun setup. dsh-auth never removes a shared Nginx package automatically.',
    }])
  }
  return nginx
}

interface SecretMaterial {
  readonly passwordHash: string
  readonly sessionSecret: string
}

async function prepareSecretMaterial(host: InstallerHost, secrets: SetupSecrets): Promise<SecretMaterial> {
  const password = await secrets.readPassword()
  if (password.length === 0) throw new InstallerError('password must not be empty', ExitCode.usage)
  if (Buffer.byteLength(password, 'utf8') > 16 * 1024) throw new InstallerError('password input is too large', ExitCode.usage)
  return { passwordHash: await hashPassword(password), sessionSecret: host.randomBytes(32).toString('base64url') }
}

function createSecretFiles(host: InstallerHost, prepared: PreparedSetup, state: InstallState, material: SecretMaterial): InstallState {
  const paths = state.paths
  const service = prepared.discovery.dshService
  const uid = prepared.plan.mode === 'system' ? 0 : (host.effectiveUid ?? 0)
  const gid = prepared.plan.mode === 'system' ? (service?.gid ?? 0) : (process.getegid?.() ?? 0)
  let current = writeOwnedFile(host, state, paths.passwordHashFile, `${material.passwordHash}\n`, prepared.plan.mode === 'system' ? 0o640 : 0o600, uid, gid)
  current = writeOwnedFile(host, current, paths.sessionSecretFile, `${material.sessionSecret}\n`, prepared.plan.mode === 'system' ? 0o640 : 0o600, uid, gid)
  return current
}

function serviceIsActive(host: InstallerHost, systemctlPath: string, service: string): boolean {
  return host.run({ executable: systemctlPath, args: ['is-active', '--quiet', service] }).status === 0
}

function serviceIsEnabled(host: InstallerHost, systemctlPath: string, service: string): boolean {
  return host.run({ executable: systemctlPath, args: ['is-enabled', '--quiet', service] }).status === 0
}

function activateSystem(host: InstallerHost, initial: InstallState, nginxWasInstalled: boolean): InstallState {
  const systemctlPath = systemctl(host)
  let state = initial
  const activation = state.activation
  if (activation === undefined) throw new InstallerError('service activation journal is missing', ExitCode.execution)
  state = updateState(host, state, { activation: { ...activation, daemonReloadAttempted: true } })
  runChecked(host, { executable: systemctlPath, args: ['daemon-reload'] }, 'SYSTEMD_DAEMON_RELOAD_FAILED')
  runChecked(host, { executable: state.nginxExecutable, args: ['-t'] }, 'NGINX_CONFIG_TEST_FAILED')
  const afterReload = state.activation
  if (afterReload === undefined) throw new InstallerError('service activation journal is missing', ExitCode.execution)
  state = updateState(host, state, { activation: { ...afterReload, dshRestartAttempted: true } })
  runChecked(host, { executable: systemctlPath, args: ['restart', state.dshService] }, 'DSH_RESTART_FAILED')
  const afterDshRestart = state.activation
  if (afterDshRestart === undefined) throw new InstallerError('service activation journal is missing', ExitCode.execution)
  state = updateState(host, state, { activation: { ...afterDshRestart, nginxActivationAttempted: true } })
  if (nginxWasInstalled) {
    runChecked(host, { executable: systemctlPath, args: ['enable', '--now', state.nginxService] }, 'NGINX_ENABLE_FAILED')
    return state
  }
  runChecked(host, { executable: systemctlPath, args: [activation.nginxWasActive ? 'reload' : 'start', state.nginxService] }, 'NGINX_ACTIVATION_FAILED')
  return state
}

function rollbackProfilePackage(host: InstallerHost, state: InstallState): void {
  if (!state.profilePackageInstalledByDshAuth) return
  const manifestPath = join(state.dshHome, 'profiles', state.request.profile, 'package.json')
  if (!host.regularFile(manifestPath)) return
  try {
    const manifest = JSON.parse(host.readFile(manifestPath)) as { readonly dependencies?: Record<string, unknown>; readonly dsh?: { readonly profile?: { readonly bundles?: unknown } } }
    if (manifest.dependencies?.['dsh-auth'] === undefined || !Array.isArray(manifest.dsh?.profile?.bundles) || !manifest.dsh.profile.bundles.includes('dsh-auth')) return
  } catch {
    throw new InstallerError('cannot reconcile the DSH profile during rollback', ExitCode.conflict)
  }
  const args = ['plugin', '--profile', state.request.profile, 'remove', 'dsh-auth']
  runChecked(host, profileCommand(host, state, args), 'PROFILE_PACKAGE_ROLLBACK_FAILED', dshEnvironment(state))
}

/** Roll back only paths and the profile package proven owned by a state record. */
export function rollbackInstallation(host: InstallerHost, state: InstallState, options: { readonly preserveState: boolean }): InstallState {
  validateStatePaths(state)
  rollbackProfilePackage(host, state)
  const statePath = state.paths.stateFile
  const created = [...state.createdPaths].reverse()
  for (const path of created) {
    if (path === statePath && options.preserveState) continue
    const isDirectory = host.fileExists(path) && host.stat(path).isDirectory
    if (isDirectory) host.removeDirectory(path)
    else host.removeFile(path)
  }
  host.removeFile(bootstrapStatePath(state.paths))
  const cleaned: InstallState = {
    ...state,
    profilePackageInstalledByDshAuth: false,
    createdPaths: options.preserveState ? [state.paths.configDirectory, statePath].filter(path => host.fileExists(path)) : [],
    ...(state.activation === undefined ? {} : { activation: { ...state.activation, daemonReloadAttempted: false, dshRestartAttempted: false, nginxActivationAttempted: false } }),
  }
  if (options.preserveState && host.fileExists(statePath)) {
    host.replaceFile(statePath, serializeInstallState(cleaned), 0o600)
  }
  if (state.request.outputDirectory === undefined && state.activation !== undefined) {
    const systemctlPath = systemctl(host)
    if (state.activation.daemonReloadAttempted) {
      runChecked(host, { executable: systemctlPath, args: ['daemon-reload'] }, 'ROLLBACK_SYSTEMD_RELOAD_FAILED')
    }
    if (state.activation.nginxActivationAttempted) {
      const nginx = discoverNginx(host)
      if (nginx.installed && nginx.executable !== undefined) {
      runChecked(host, { executable: nginx.executable, args: ['-t'] }, 'ROLLBACK_NGINX_TEST_FAILED')
      }
      runChecked(host, { executable: systemctlPath, args: [state.activation.nginxWasActive ? 'reload' : 'stop', state.nginxService] }, 'ROLLBACK_NGINX_SERVICE_FAILED')
      if (!state.activation.nginxWasEnabled) {
        runChecked(host, { executable: systemctlPath, args: ['disable', state.nginxService] }, 'ROLLBACK_NGINX_DISABLE_FAILED')
      }
    }
    if (state.activation.dshRestartAttempted) {
      runChecked(host, { executable: systemctlPath, args: [state.activation.dshWasActive ? 'restart' : 'stop', state.dshService] }, 'ROLLBACK_DSH_SERVICE_FAILED')
    }
  }
  return cleaned
}

/** Execute a prepared setup with transactional rollback and crash journal updates. */
export async function executeSetup(host: InstallerHost, prepared: PreparedSetup, secrets: SetupSecrets): Promise<InstallState | undefined> {
  if (prepared.plan.status === 'blocked') throw new InstallerError('setup prerequisites are not satisfied', ExitCode.prerequisite, prepared.plan.diagnostics)
  if (prepared.plan.status === 'unchanged') return prepared.state
  const paths = prepared.paths
  if (paths === undefined) throw new InstallerError('setup paths are unresolved', ExitCode.execution)
  const secretMaterial = await prepareSecretMaterial(host, secrets)

  let carriedNginxOwnership = prepared.state?.nginxInstalledByDshAuth ?? false
  if (prepared.state?.status === 'installing') {
    const cleaned = rollbackInstallation(host, prepared.state, { preserveState: true })
    carriedNginxOwnership = cleaned.nginxInstalledByDshAuth
  }

  const configUid = prepared.plan.mode === 'system' ? 0 : (host.effectiveUid ?? 0)
  const serviceGid = prepared.plan.mode === 'system' ? (prepared.discovery.dshService?.gid ?? 0) : (process.getegid?.() ?? 0)
  const configGid = prepared.plan.mode === 'system' ? serviceGid : (process.getegid?.() ?? 0)
  const configMode = prepared.plan.mode === 'system' ? 0o750 : 0o700
  const configExisted = host.fileExists(paths.configDirectory)
  const systemctlPath = prepared.plan.mode === 'system' ? systemctl(host) : undefined
  let state: InstallState = {
    ...initialInstallState(prepared),
    nginxInstalledByDshAuth: carriedNginxOwnership,
    createdPaths: [...(configExisted ? [] : [paths.configDirectory]), paths.stateFile],
    ...(systemctlPath === undefined ? {} : {
      activation: {
        dshWasActive: prepared.discovery.dshService?.activeState === 'active',
        nginxWasActive: serviceIsActive(host, systemctlPath, 'nginx.service'),
        nginxWasEnabled: serviceIsEnabled(host, systemctlPath, 'nginx.service'),
        daemonReloadAttempted: false,
        dshRestartAttempted: false,
        nginxActivationAttempted: false,
      },
    }),
  }

  try {
    if (!configExisted) {
      const bootstrapPath = bootstrapStatePath(paths)
      host.writeNewFile(bootstrapPath, serializeInstallState(state), 0o600)
      host.mkdir(paths.configDirectory, configMode)
      host.chown(paths.configDirectory, configUid, configGid)
      host.chmod(paths.configDirectory, configMode)
      host.renameFile(bootstrapPath, paths.stateFile)
    } else {
      const configStat = host.stat(paths.configDirectory)
      if (!configStat.isDirectory || configStat.uid !== configUid || configStat.gid !== configGid || configStat.mode !== configMode) {
        throw new InstallerError('managed configuration directory has unsafe ownership or permissions', ExitCode.permission)
      }
      if (host.fileExists(paths.stateFile)) host.replaceFile(paths.stateFile, serializeInstallState(state), 0o600)
      else host.writeNewFile(paths.stateFile, serializeInstallState(state), 0o600)
    }
    if (!prepared.discovery.nginx.installed && prepared.request.nginxPolicy === 'install') {
      for (const command of prepared.discovery.packageManager?.commands ?? []) {
        if (command.args.includes('install') && command.args.includes('nginx') && !state.nginxInstalledByDshAuth) {
          state = updateState(host, state, { nginxInstalledByDshAuth: true })
        }
        runChecked(host, command, 'NGINX_PACKAGE_INSTALL_FAILED')
      }
      const nginx = validateInstalledNginx(host, paths.nginxConfigFile)
      state = updateState(host, state, { nginxExecutable: nginx.executable ?? state.nginxExecutable, nginxInstalledByDshAuth: true })
    }

    const packageAction = prepared.plan.actions.find(action => action.id === 'install-profile-package')
    if (packageAction?.command !== undefined) {
      state = updateState(host, state, { profilePackageInstalledByDshAuth: true })
      runChecked(host, profileCommand(host, state, packageAction.command.args), 'PROFILE_PACKAGE_INSTALL_FAILED', dshEnvironment(state))
    }

    if (prepared.plan.mode === 'system') {
      assertSafeRootDirectory(host, dirname(paths.nginxConfigFile))
      assertSafeRootDirectory(host, dirname(paths.systemdDropInDirectory))
      state = ensureDirectory(host, state, paths.sessionDirectory, 0o700, prepared.discovery.dshService?.uid ?? 0, prepared.discovery.dshService?.gid ?? 0)
      state = ensureDirectory(host, state, paths.systemdDropInDirectory, 0o755, 0, 0)
    } else {
      state = ensureDirectory(host, state, paths.sessionDirectory, 0o700, configUid, configGid)
    }
    state = createSecretFiles(host, prepared, state, secretMaterial)
    state = writeOwnedFile(host, state, paths.environmentFile, renderEnvironmentFile(prepared.request, paths), prepared.plan.mode === 'system' ? 0o640 : 0o600, configUid, configGid)
    const { renderNginxConfig } = await import('./nginx.js')
    state = writeOwnedFile(host, state, paths.nginxConfigFile, renderNginxConfig(prepared.request), 0o644, configUid, prepared.plan.mode === 'system' ? 0 : configGid)
    if (prepared.plan.mode === 'system') {
      state = writeOwnedFile(host, state, paths.systemdDropInFile, renderSystemdDropIn(paths), 0o644, 0, 0)
      state = activateSystem(host, state, state.nginxInstalledByDshAuth && !prepared.discovery.nginx.installed)
    }
    state = {
      ...state,
      status: 'installed',
      ...(state.activation === undefined ? {} : { activation: { ...state.activation, daemonReloadAttempted: false, dshRestartAttempted: false, nginxActivationAttempted: false } }),
    }
    host.replaceFile(state.paths.stateFile, serializeInstallState(state), 0o600)
    return state
  } catch (error) {
    try {
      rollbackInstallation(host, readInstallState(host, paths.stateFile) ?? state, { preserveState: true })
    } catch (rollbackError) {
      throw new InstallerError('setup failed and rollback also failed', ExitCode.execution, [
        { code: 'SETUP_FAILED', severity: 'error', message: error instanceof Error ? error.message : String(error) },
        { code: 'ROLLBACK_FAILED', severity: 'error', message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError), remediation: `Run dsh-auth doctor and inspect the ownership record at ${paths.stateFile}.` },
      ])
    }
    throw error
  }
}
