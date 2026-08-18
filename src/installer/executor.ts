import { dirname } from 'node:path'
import { join } from 'node:path'
import { authStateSecretId, createAuthStateDocument } from '../auth-state.js'
import { ADMIN_PASSWORD_MAX_BYTES, assertAdministratorPassword, hashPassword } from '../password.js'
import { renderCaddyfile, renderCaddyUnit, resolveCaddyPackage } from './caddy.js'
import { renderEnvironmentFile, renderSystemdDropIn, serializeInstallState } from './config-files.js'
import { InstallerError } from './errors.js'
import { bootstrapStatePath, initialInstallState, readInstallState, validateStatePaths } from './plan.js'
import { ExitCode, type CommandSpec, type InstallState, type InstallerHost, type ManagedPaths, type PreparedSetup } from './types.js'

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
    current = current.slice(0, current.lastIndexOf('/')) || '/'
  }
}

interface SecretMaterial {
  readonly passwordHash?: string
  readonly sessionSecret: string
}

async function prepareSecretMaterial(host: InstallerHost, prepared: PreparedSetup, secrets: SetupSecrets): Promise<SecretMaterial> {
  const sessionSecret = host.randomBytes(32).toString('base64url')
  if (prepared.request.adminBootstrap !== 'password') return { sessionSecret }
  const password = await secrets.readPassword()
  try {
    assertAdministratorPassword(password)
  } catch (error) {
    throw new InstallerError(error instanceof Error ? error.message : 'password is invalid', ExitCode.usage)
  }
  if (Buffer.byteLength(password, 'utf8') > ADMIN_PASSWORD_MAX_BYTES) throw new InstallerError('password input is too large', ExitCode.usage)
  return { passwordHash: await hashPassword(password), sessionSecret }
}

function serviceIsActive(host: InstallerHost, systemctlPath: string, service: string): boolean {
  return host.run({ executable: systemctlPath, args: ['is-active', '--quiet', service] }).status === 0
}

function serviceIsEnabled(host: InstallerHost, systemctlPath: string, service: string): boolean {
  return host.run({ executable: systemctlPath, args: ['is-enabled', '--quiet', service] }).status === 0
}

function activateSystem(host: InstallerHost, initial: InstallState): InstallState {
  const systemctlPath = systemctl(host)
  let state = initial
  const activation = state.activation
  if (activation === undefined) throw new InstallerError('service activation journal is missing', ExitCode.execution)
  runChecked(host, { executable: state.paths.caddyBinary, args: ['validate', '--config', state.paths.caddyfile] }, 'CADDY_CONFIG_VALIDATE_FAILED')
  state = updateState(host, state, { activation: { ...activation, daemonReloadAttempted: true } })
  runChecked(host, { executable: systemctlPath, args: ['daemon-reload'] }, 'SYSTEMD_DAEMON_RELOAD_FAILED')
  const afterReload = state.activation
  if (afterReload === undefined) throw new InstallerError('service activation journal is missing', ExitCode.execution)
  state = updateState(host, state, { activation: { ...afterReload, dshRestartAttempted: true } })
  runChecked(host, { executable: systemctlPath, args: ['restart', state.dshService] }, 'DSH_RESTART_FAILED')
  const afterDsh = state.activation
  if (afterDsh === undefined) throw new InstallerError('service activation journal is missing', ExitCode.execution)
  state = updateState(host, state, { activation: { ...afterDsh, caddyActivationAttempted: true } })
  runChecked(host, { executable: systemctlPath, args: ['enable', '--now', 'dsh-auth-caddy.service'] }, 'CADDY_ENABLE_FAILED')
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

function removeCreatedPaths(host: InstallerHost, state: InstallState, preserveState: boolean): void {
  for (const path of [...state.createdPaths].reverse()) {
    if (path === state.paths.stateFile && preserveState) continue
    const isDirectory = host.fileExists(path) && host.stat(path).isDirectory
    if (isDirectory) host.removeDirectory(path)
    else host.removeFile(path)
  }
  host.removeFile(bootstrapStatePath(state.paths))
}

function rollbackServices(host: InstallerHost, state: InstallState): void {
  if (state.request.outputDirectory !== undefined || state.activation === undefined) return
  const activation = state.activation
  const systemctlPath = systemctl(host)
  if (activation.caddyActivationAttempted) {
    runChecked(host, { executable: systemctlPath, args: ['disable', '--now', 'dsh-auth-caddy.service'] }, 'ROLLBACK_CADDY_SERVICE_FAILED')
  }
  if (activation.daemonReloadAttempted) {
    runChecked(host, { executable: systemctlPath, args: ['daemon-reload'] }, 'ROLLBACK_SYSTEMD_RELOAD_FAILED')
  }
  if (activation.dshRestartAttempted) {
    runChecked(host, { executable: systemctlPath, args: [activation.dshWasActive ? 'restart' : 'stop', state.dshService] }, 'ROLLBACK_DSH_SERVICE_FAILED')
  }
}

function rollbackInstallation(host: InstallerHost, state: InstallState, options: { readonly preserveState: boolean }): InstallState {
  validateStatePaths(state)
  rollbackProfilePackage(host, state)
  const statePath = state.paths.stateFile
  removeCreatedPaths(host, state, options.preserveState)
  const cleaned: InstallState = {
    ...state,
    profilePackageInstalledByDshAuth: false,
    createdPaths: options.preserveState ? [state.paths.configDirectory, statePath].filter(path => host.fileExists(path)) : [],
    ...(state.activation === undefined ? {} : { activation: { ...state.activation, daemonReloadAttempted: false, dshRestartAttempted: false, caddyActivationAttempted: false } }),
  }
  if (options.preserveState && host.fileExists(statePath)) {
    host.replaceFile(statePath, serializeInstallState(cleaned), 0o600)
  }
  rollbackServices(host, state)
  return cleaned
}

interface ExecutionContext {
  readonly configUid: number
  readonly configGid: number
  readonly serviceUid: number
  readonly serviceGid: number
  readonly configMode: number
  readonly configExisted: boolean
}

function recoverInterruptedSetup(host: InstallerHost, prepared: PreparedSetup): void {
  if (prepared.state?.status === 'installing') rollbackInstallation(host, prepared.state, { preserveState: true })
}

function executionContext(
  host: InstallerHost,
  prepared: PreparedSetup,
  paths: ManagedPaths,
  caddyBinarySha256: string,
): { readonly context: ExecutionContext; readonly state: InstallState } {
  const system = prepared.plan.mode === 'system'
  const configUid = system ? 0 : (host.effectiveUid ?? 0)
  const processGid = process.getegid?.() ?? 0
  const serviceUid = system ? (prepared.discovery.dshService?.uid ?? 0) : configUid
  const serviceGid = system ? (prepared.discovery.dshService?.gid ?? 0) : processGid
  const configGid = system ? serviceGid : processGid
  const configMode = system ? 0o750 : 0o700
  const configExisted = host.fileExists(paths.configDirectory)
  const systemctlPath = system ? systemctl(host) : undefined
  const state: InstallState = {
    ...initialInstallState(prepared, caddyBinarySha256),
    createdPaths: [...(configExisted ? [] : [paths.configDirectory]), paths.stateFile],
    ...(systemctlPath === undefined ? {} : {
      activation: {
        dshWasActive: prepared.discovery.dshService?.activeState === 'active',
        caddyWasActive: serviceIsActive(host, systemctlPath, 'dsh-auth-caddy.service'),
        caddyWasEnabled: serviceIsEnabled(host, systemctlPath, 'dsh-auth-caddy.service'),
        daemonReloadAttempted: false,
        dshRestartAttempted: false,
        caddyActivationAttempted: false,
      },
    }),
  }
  return { context: { configUid, configGid, serviceUid, serviceGid, configMode, configExisted }, state }
}

function writeOwnershipJournal(host: InstallerHost, paths: ManagedPaths, context: ExecutionContext, state: InstallState): void {
  if (!context.configExisted) {
    const bootstrapPath = bootstrapStatePath(paths)
    host.writeNewFile(bootstrapPath, serializeInstallState(state), 0o600)
    host.mkdir(paths.configDirectory, context.configMode)
    host.chown(paths.configDirectory, context.configUid, context.configGid)
    host.chmod(paths.configDirectory, context.configMode)
    host.renameFile(bootstrapPath, paths.stateFile)
    return
  }
  const configStat = host.stat(paths.configDirectory)
  if (!configStat.isDirectory || configStat.uid !== context.configUid || configStat.gid !== context.configGid || configStat.mode !== context.configMode) {
    throw new InstallerError('managed configuration directory has unsafe ownership or permissions', ExitCode.permission)
  }
  if (host.fileExists(paths.stateFile)) host.replaceFile(paths.stateFile, serializeInstallState(state), 0o600)
  else host.writeNewFile(paths.stateFile, serializeInstallState(state), 0o600)
}

function installProfilePackage(host: InstallerHost, prepared: PreparedSetup, initial: InstallState): InstallState {
  const packageAction = prepared.plan.actions.find(action => action.id === 'install-profile-package')
  if (packageAction?.command === undefined) return initial
  const state = updateState(host, initial, { profilePackageInstalledByDshAuth: true })
  runChecked(host, profileCommand(host, state, packageAction.command.args), 'PROFILE_PACKAGE_INSTALL_FAILED', dshEnvironment(state))
  return state
}

function createManagedDirectories(host: InstallerHost, prepared: PreparedSetup, paths: ManagedPaths, context: ExecutionContext, initial: InstallState): InstallState {
  let state = initial
  const system = prepared.plan.mode === 'system'
  if (system) {
    const binaryDirectory = dirname(paths.caddyBinary)
    assertSafeRootDirectory(host, host.fileExists(binaryDirectory) ? binaryDirectory : dirname(binaryDirectory))
    assertSafeRootDirectory(host, dirname(paths.systemdDropInDirectory))
    state = ensureDirectory(host, state, binaryDirectory, 0o755, 0, 0)
    state = ensureDirectory(host, state, paths.caddyStateDirectory, 0o700, 0, 0)
    state = ensureDirectory(host, state, paths.systemdDropInDirectory, 0o755, 0, 0)
  } else {
    state = ensureDirectory(host, state, paths.caddyStateDirectory, 0o700, context.configUid, context.configGid)
  }
  state = ensureDirectory(host, state, paths.authStateDirectory, 0o700, context.serviceUid, context.serviceGid)
  return ensureDirectory(host, state, paths.loginTokenDirectory, 0o700, context.serviceUid, context.serviceGid)
}

function writeAuthState(host: InstallerHost, prepared: PreparedSetup, paths: ManagedPaths, context: ExecutionContext, material: SecretMaterial, initial: InstallState): InstallState {
  const secretId = authStateSecretId(Buffer.from(material.sessionSecret))
  const username = prepared.request.adminUsername
  const document = prepared.request.adminBootstrap === 'password' && material.passwordHash !== undefined && username !== undefined
    ? createAuthStateDocument(secretId, { username, passwordHash: material.passwordHash, configuredAt: Date.now() })
    : createAuthStateDocument(secretId)
  return writeOwnedFile(host, initial, paths.authStateFile, `${JSON.stringify(document)}\n`, 0o600, context.serviceUid, context.serviceGid)
}

function writeManagedConfiguration(
  host: InstallerHost,
  prepared: PreparedSetup,
  paths: ManagedPaths,
  context: ExecutionContext,
  material: SecretMaterial,
  caddySource: string,
  initial: InstallState,
): InstallState {
  const system = prepared.plan.mode === 'system'
  const secretMode = system ? 0o640 : 0o600
  let state = writeOwnedFile(host, initial, paths.caddyBinary, host.readFileBytes(caddySource), 0o755, context.configUid, system ? 0 : context.configGid)
  state = writeOwnedFile(host, state, paths.sessionSecretFile, `${material.sessionSecret}\n`, secretMode, context.configUid, context.configGid)
  state = writeAuthState(host, prepared, paths, context, material, state)
  state = writeOwnedFile(host, state, paths.environmentFile, renderEnvironmentFile(prepared.request, paths), secretMode, context.configUid, context.configGid)
  state = writeOwnedFile(host, state, paths.caddyfile, renderCaddyfile(prepared.request, system), 0o644, context.configUid, system ? 0 : context.configGid)
  if (!system) {
    return writeOwnedFile(host, state, paths.caddyUnitFile, renderCaddyUnit(prepared.request, paths), 0o644, context.configUid, context.configGid)
  }
  state = writeOwnedFile(host, state, paths.systemdDropInFile, renderSystemdDropIn(paths), 0o644, 0, 0)
  state = writeOwnedFile(host, state, paths.caddyUnitFile, renderCaddyUnit(prepared.request, paths), 0o644, 0, 0)
  return activateSystem(host, state)
}

function finishInstallation(host: InstallerHost, state: InstallState): InstallState {
  const installed: InstallState = {
    ...state,
    status: 'installed',
    ...(state.activation === undefined ? {} : { activation: { ...state.activation, daemonReloadAttempted: false, dshRestartAttempted: false, caddyActivationAttempted: false } }),
  }
  host.replaceFile(installed.paths.stateFile, serializeInstallState(installed), 0o600)
  return installed
}

/** Execute a prepared setup with transactional rollback and crash journal updates. */
export async function executeSetup(host: InstallerHost, prepared: PreparedSetup, secrets: SetupSecrets): Promise<InstallState | undefined> {
  if (prepared.plan.status === 'blocked') throw new InstallerError('setup prerequisites are not satisfied', ExitCode.prerequisite, prepared.plan.diagnostics)
  if (prepared.plan.status === 'unchanged') return prepared.state
  const paths = prepared.paths
  if (paths === undefined) throw new InstallerError('setup paths are unresolved', ExitCode.execution)
  const caddy = resolveCaddyPackage(host)
  const secretMaterial = await prepareSecretMaterial(host, prepared, secrets)
  recoverInterruptedSetup(host, prepared)
  const execution = executionContext(host, prepared, paths, caddy.binarySha256)
  let state = execution.state

  try {
    writeOwnershipJournal(host, paths, execution.context, state)
    state = installProfilePackage(host, prepared, state)
    state = createManagedDirectories(host, prepared, paths, execution.context, state)
    state = writeManagedConfiguration(host, prepared, paths, execution.context, secretMaterial, caddy.executable, state)
    return finishInstallation(host, state)
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
