import { dirname, isAbsolute, join } from 'node:path'
import { assertRootOwnedDirectory } from './discovery.js'
import { InstallerError } from './errors.js'
import { persistentRequest, renderEnvironmentFile, renderSystemdDropIn, requestFingerprint } from './config-files.js'
import { assertPublicPortsFree, CADDY_VERSION, renderCaddyfile, renderCaddyUnit, resolveCaddyPackage, SYSTEM_CADDY_BINARY, SYSTEM_CADDY_STATE, SYSTEM_CADDY_UNIT } from './caddy.js'
import { expectedManagedOwners } from './ownership.js'
import { ExitCode, type Diagnostic, type HostDiscovery, type InstallationPlan, type InstallerHost, type InstallState, type ManagedPaths, type PlanAction, type PreparedSetup, type SetupRequest } from './types.js'
import { publicOrigin, validateServiceName, validateSetupRequest } from './validation.js'

const SYSTEM_CONFIG_DIRECTORY = '/etc/dsh-auth'
const SYSTEM_AUTH_STATE_DIRECTORY = '/var/lib/dsh-auth'
const SCHEMA_V1_REMEDIATION = 'Do not overwrite, migrate, or uninstall automatically. Record the old unit, then perform a new v2 setup. Existing sessions will not work after reinstall.'

function blocked(diagnostics: readonly Diagnostic[], mode: 'system' | 'output'): InstallationPlan {
  return { schemaVersion: 2, operation: 'setup', mode, status: 'blocked', actions: [], diagnostics }
}

function managedPathsFor(request: SetupRequest, discovery: HostDiscovery): ManagedPaths | undefined {
  if (request.outputDirectory !== undefined) {
    const root = request.outputDirectory
    return {
      configDirectory: root,
      stateFile: join(root, 'install-state.json'),
      environmentFile: join(root, 'dsh-auth.env'),
      sessionSecretFile: join(root, 'session-secret'),
      caddyfile: join(root, 'Caddyfile'),
      caddyBinary: join(root, 'caddy'),
      caddyBinaryDirectory: root,
      caddyUnitFile: join(root, 'dsh-auth-caddy.service'),
      caddyStateDirectory: join(root, 'caddy-state'),
      authStateDirectory: join(root, 'state'),
      authStateFile: join(root, 'state', 'auth-state.json'),
      loginTokenDirectory: join(root, 'state', 'login-tokens'),
      systemdDropInDirectory: root,
      systemdDropInFile: join(root, 'dsh-auth.service.conf'),
    }
  }
  const service = discovery.dshService
  if (service === undefined) return undefined
  const dropInDirectory = `/etc/systemd/system/${service.name}.d`
  return {
    configDirectory: SYSTEM_CONFIG_DIRECTORY,
    stateFile: join(SYSTEM_CONFIG_DIRECTORY, 'install-state.json'),
    environmentFile: join(SYSTEM_CONFIG_DIRECTORY, 'dsh-auth.env'),
    sessionSecretFile: join(SYSTEM_CONFIG_DIRECTORY, 'session-secret'),
    caddyfile: join(SYSTEM_CONFIG_DIRECTORY, 'Caddyfile'),
    caddyBinary: SYSTEM_CADDY_BINARY,
    caddyBinaryDirectory: dirname(SYSTEM_CADDY_BINARY),
    caddyUnitFile: SYSTEM_CADDY_UNIT,
    caddyStateDirectory: SYSTEM_CADDY_STATE,
    authStateDirectory: SYSTEM_AUTH_STATE_DIRECTORY,
    authStateFile: join(SYSTEM_AUTH_STATE_DIRECTORY, 'auth-state.json'),
    loginTokenDirectory: join(SYSTEM_AUTH_STATE_DIRECTORY, 'login-tokens'),
    systemdDropInDirectory: dropInDirectory,
    systemdDropInFile: join(dropInDirectory, '50-dsh-auth.conf'),
  }
}

/** Return the adjacent crash journal used before the configuration directory exists. */
export function bootstrapStatePath(paths: ManagedPaths): string {
  return `${paths.configDirectory}.installing.json`
}

function schemaV1Error(): never {
  throw new InstallerError('existing installation uses schema v1 and cannot be migrated', ExitCode.conflict, [{
    code: 'SCHEMA_V1_UNSUPPORTED',
    severity: 'error',
    message: 'This installation uses schema v1 and cannot be migrated automatically.',
    remediation: SCHEMA_V1_REMEDIATION,
  }])
}

function parseInstallState(host: InstallerHost, path: string): Record<string, unknown> {
  const stateStat = host.stat(path)
  if (stateStat.isDirectory || (stateStat.mode & 0o077) !== 0 || (path.startsWith('/etc/') && stateStat.uid !== 0)) {
    throw new InstallerError('dsh-auth state file ownership or permissions are unsafe', ExitCode.conflict)
  }
  let value: unknown
  try {
    value = JSON.parse(host.readFile(path))
  } catch {
    throw new InstallerError('dsh-auth state file is invalid', ExitCode.conflict, [{
      code: 'INVALID_INSTALL_STATE',
      severity: 'error',
      message: `Cannot parse the ownership record at ${path}.`,
      remediation: 'Inspect the file manually. Do not delete system files until their ownership is established.',
    }])
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InstallerError('dsh-auth state file is invalid', ExitCode.conflict)
  }
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion === 1) schemaV1Error()
  return candidate
}

function hasSupportedIdentity(candidate: Record<string, unknown>): boolean {
  return !(
    candidate.schemaVersion !== 2
    || (candidate.status !== 'installing' && candidate.status !== 'installed')
    || typeof candidate.fingerprint !== 'string'
    || typeof candidate.dshService !== 'string'
    || typeof candidate.dshUser !== 'string'
    || typeof candidate.dshHome !== 'string'
    || typeof candidate.dshExecutable !== 'string'
    || typeof candidate.publicOrigin !== 'string'
    || typeof candidate.authStateFile !== 'string'
    || typeof candidate.loginTokenEnabled !== 'boolean'
    || typeof candidate.caddyVersion !== 'string'
    || typeof candidate.caddyBinarySha256 !== 'string'
    || typeof candidate.dshUid !== 'number'
    || typeof candidate.dshGid !== 'number'
    || typeof candidate.profilePackageInstalledByDshAuth !== 'boolean'
  )
}

function hasSupportedPaths(candidate: Record<string, unknown>): boolean {
  const paths = candidate.paths as Partial<ManagedPaths> | undefined
  const pathValues = paths === undefined ? [] : Object.values(paths)
  return candidate.request !== undefined
    && paths !== undefined
    && pathValues.length === 14
    && pathValues.every(entry => typeof entry === 'string')
    && Array.isArray(candidate.createdPaths)
    && candidate.createdPaths.every(entry => typeof entry === 'string')
}

function hasSupportedActivation(candidate: Record<string, unknown>): boolean {
  const activation = candidate.activation as InstallState['activation'] | undefined
  return activation === undefined || [
    activation.dshWasActive,
    activation.caddyWasActive,
    activation.caddyWasEnabled,
    activation.daemonReloadAttempted,
    activation.dshRestartAttempted,
    activation.caddyActivationAttempted,
  ].every(value => typeof value === 'boolean')
}

function validatedInstallState(candidate: Record<string, unknown>): InstallState {
  if (!hasSupportedIdentity(candidate) || !hasSupportedPaths(candidate) || !hasSupportedActivation(candidate)) {
    throw new InstallerError('dsh-auth state file has an unsupported format', ExitCode.conflict)
  }
  return candidate as unknown as InstallState
}

function validatePersistedRequest(state: InstallState): void {
  try {
    validateSetupRequest(state.request)
    if (state.request.outputDirectory === undefined) validateServiceName(state.dshService)
  } catch {
    throw new InstallerError('dsh-auth state file contains invalid setup values', ExitCode.conflict)
  }
}

function derivedManagedPaths(state: InstallState): ManagedPaths | undefined {
  return managedPathsFor(state.request, {
    platform: 'linux',
    arch: 'x64',
    effectiveUid: 0,
    ...(state.request.outputDirectory === undefined
      ? {
          dshService: {
            name: state.dshService,
            loadState: 'loaded',
            activeState: 'active',
            user: state.dshUser,
            group: 'root',
            uid: state.dshUid,
            gid: state.dshGid,
            dshExecutable: state.dshExecutable,
            dshHome: state.dshHome,
          },
        }
      : {}),
  })
}

function validateOwnedPaths(state: InstallState): void {
  validateStatePaths(state)
  const derived = derivedManagedPaths(state)
  if (derived === undefined || Object.entries(derived).some(([key, path]) => state.paths[key as keyof ManagedPaths] !== path)) {
    throw new InstallerError('dsh-auth state file contains unowned paths', ExitCode.conflict)
  }
  const ownedPaths = new Set(Object.values(state.paths))
  if (new Set(state.createdPaths).size !== state.createdPaths.length || state.createdPaths.some(entry => !ownedPaths.has(entry))) {
    throw new InstallerError('dsh-auth state file contains unowned paths', ExitCode.conflict)
  }
}

export function readInstallState(host: InstallerHost, path: string): InstallState | undefined {
  if (!host.fileExists(path)) return undefined
  const state = validatedInstallState(parseInstallState(host, path))
  validatePersistedRequest(state)
  validateOwnedPaths(state)
  return state
}

function packageStatus(host: InstallerHost, request: SetupRequest, discovery: HostDiscovery): 'missing' | 'exact' | 'conflict' {
  const service = discovery.dshService
  if (service === undefined) return 'missing'
  if (service.user === 'root') {
    const profilesDirectory = join(service.dshHome, 'profiles')
    if (host.fileExists(profilesDirectory)) assertRootOwnedDirectory(host, profilesDirectory)
    const profileDirectory = join(profilesDirectory, request.profile)
    if (host.fileExists(profileDirectory)) assertRootOwnedDirectory(host, profileDirectory)
  }
  const manifestPath = join(service.dshHome, 'profiles', request.profile, 'package.json')
  if (!host.regularFile(manifestPath)) return 'missing'
  let manifest: unknown
  try {
    manifest = JSON.parse(host.readFile(manifestPath))
  } catch {
    return 'conflict'
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return 'conflict'
  const record = manifest as { readonly dependencies?: Record<string, unknown>; readonly dsh?: { readonly profile?: { readonly bundles?: unknown } } }
  const dependency = record.dependencies?.['dsh-auth']
  if (dependency === undefined) return 'missing'
  const bundles = record.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes('dsh-auth')) return 'conflict'
  if (request.packageSource.startsWith('dsh-auth@')) {
    return dependency === request.packageSource.slice('dsh-auth@'.length) ? 'exact' : 'conflict'
  }
  if (isAbsolute(request.packageSource)) {
    return dependency === `file:${request.packageSource}` ? 'exact' : 'conflict'
  }
  return 'conflict'
}

function systemDiagnostics(host: InstallerHost, request: SetupRequest, discovery: HostDiscovery): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  if (discovery.platform !== 'linux') {
    diagnostics.push({ code: 'UNSUPPORTED_PLATFORM', severity: 'error', message: 'System setup supports Linux only.', remediation: 'Use --output-dir for deterministic container/offline configuration output.' })
  }
  if (discovery.effectiveUid !== 0) {
    diagnostics.push({ code: 'ROOT_REQUIRED', severity: 'error', message: 'System setup requires root to manage systemd and Caddy files.', remediation: 'Run setup through sudo, or use --output-dir without system changes.' })
  }
  if (discovery.dshService === undefined) {
    diagnostics.push({ code: 'DSH_SERVICE_REQUIRED', severity: 'error', message: 'An explicit DSH Web systemd service is required.', remediation: 'Pass the exact unit with --dsh-service and, when discovery cannot infer them, --dsh-home and --dsh-executable.' })
  }
  if (request.mode === 'https' && request.tls === 'manual') {
    if (request.certificate !== undefined && !host.regularFile(request.certificate)) diagnostics.push({ code: 'CERTIFICATE_NOT_FOUND', severity: 'error', message: 'The TLS certificate is not a readable regular file.' })
    if (request.certificateKey !== undefined && !host.regularFile(request.certificateKey)) diagnostics.push({ code: 'CERTIFICATE_KEY_NOT_FOUND', severity: 'error', message: 'The TLS certificate key is not a readable regular file.' })
  }
  try {
    resolveCaddyPackage(host)
  } catch (error) {
    if (error instanceof InstallerError) diagnostics.push(...error.diagnostics)
    else diagnostics.push({ code: 'CADDY_PACKAGE_MISSING', severity: 'error', message: error instanceof Error ? error.message : String(error) })
  }
  return diagnostics
}

function commandAction(id: string, description: string, executable: string, args: readonly string[]): PlanAction {
  return { id, kind: 'run-command', description, command: { executable, args } }
}

function drift(code: string, message: string): never {
  throw new InstallerError('managed installation has drifted', ExitCode.conflict, [{ code, severity: 'error', message, remediation: 'Run doctor, then restore or uninstall the recorded installation before retrying setup.' }])
}

function verifyInstalledState(host: InstallerHost, state: InstallState, request: SetupRequest, discovery: HostDiscovery): void {
  const output = request.outputDirectory !== undefined
  const modes = new Map<string, number>([
    [state.paths.configDirectory, output ? 0o700 : 0o750],
    [state.paths.stateFile, 0o600],
    [state.paths.environmentFile, output ? 0o600 : 0o640],
    [state.paths.sessionSecretFile, output ? 0o600 : 0o640],
    [state.paths.caddyfile, 0o644],
    [state.paths.caddyBinary, 0o755],
    [state.paths.caddyBinaryDirectory, output ? 0o700 : 0o755],
    [state.paths.authStateDirectory, 0o700],
    [state.paths.authStateFile, 0o600],
    [state.paths.loginTokenDirectory, 0o700],
    ...(output ? [] : [[state.paths.systemdDropInFile, 0o644] as const, [state.paths.caddyUnitFile, 0o644] as const]),
  ])
  for (const path of state.createdPaths) {
    if (!host.fileExists(path)) drift('MANAGED_PATH_MISSING', `Recorded path is missing: ${path}`)
    const expected = modes.get(path)
    if (expected !== undefined && (host.stat(path).mode & 0o777) !== expected) {
      drift('MANAGED_MODE_DRIFT', `Recorded path has unexpected permissions: ${path}`)
    }
  }
  const service = discovery.dshService
  if (!output && service !== undefined) {
    const owners = expectedManagedOwners(state.paths, service.uid, service.gid)
    for (const [path, [uid, gid]] of owners) {
      if (!host.fileExists(path)) continue
      const actual = host.stat(path)
      if (actual.uid !== uid || actual.gid !== gid) drift('MANAGED_OWNER_DRIFT', `Recorded path has unexpected ownership: ${path}`)
    }
  }
  const system = !output
  const expectedFiles = new Map<string, string>([
    [state.paths.environmentFile, renderEnvironmentFile(request, state.paths)],
    [state.paths.caddyfile, renderCaddyfile(request, system, state.paths.caddyStateDirectory)],
    ...(output ? [] : [
      [state.paths.systemdDropInFile, renderSystemdDropIn(state.paths)] as const,
      [state.paths.caddyUnitFile, renderCaddyUnit(request, state.paths)] as const,
    ]),
  ])
  for (const [path, expected] of expectedFiles) {
    if (!host.regularFile(path) || host.readFile(path) !== expected) {
      drift('MANAGED_CONTENT_DRIFT', `Recorded managed configuration differs from the requested installation: ${path}`)
    }
  }
  if (!host.regularFile(state.paths.sessionSecretFile) || !/^[A-Za-z0-9_-]{43}\n?$/u.test(host.readFile(state.paths.sessionSecretFile))) {
    drift('SESSION_SECRET_INVALID', 'The managed session secret is not a valid 32-byte base64url value.')
  }
}

type SetupMode = 'system' | 'output'

interface SetupContext {
  readonly mode: SetupMode
  readonly paths: ManagedPaths
  readonly state?: InstallState
  readonly fingerprint: string
}

function resolveSetupContext(host: InstallerHost, request: SetupRequest, discovery: HostDiscovery, mode: SetupMode): SetupContext | undefined {
  const paths = managedPathsFor(request, discovery)
  if (paths === undefined) return undefined
  const fingerprint = requestFingerprint(request)
  const bootstrapPath = bootstrapStatePath(paths)
  if (host.fileExists(paths.stateFile) && host.fileExists(bootstrapPath)) {
    throw new InstallerError('both final and bootstrap ownership records exist', ExitCode.conflict)
  }
  const state = readInstallState(host, paths.stateFile) ?? readInstallState(host, bootstrapPath)
  if (state !== undefined && (state.fingerprint !== fingerprint || state.dshService !== (discovery.dshService?.name ?? 'output'))) {
    throw new InstallerError('existing dsh-auth installation has different settings', ExitCode.conflict, [{
      code: 'INSTALLATION_CONFLICT',
      severity: 'error',
      message: 'The managed installation already exists with a different non-secret configuration.',
      remediation: 'Run doctor, then uninstall the owned installation before applying different settings.',
    }])
  }
  return { mode, paths, ...(state === undefined ? {} : { state }), fingerprint }
}

function unchangedPreparation(host: InstallerHost, request: SetupRequest, discovery: HostDiscovery, context: SetupContext): PreparedSetup | undefined {
  if (context.state?.status !== 'installed') return undefined
  verifyInstalledState(host, context.state, request, discovery)
  return {
    plan: { schemaVersion: 2, operation: 'setup', mode: context.mode, status: 'unchanged', actions: [{ id: 'verify', kind: 'check', description: 'Verify the existing managed installation.' }], diagnostics: [], fingerprint: context.fingerprint },
    request,
    discovery,
    state: context.state,
    paths: context.paths,
    fingerprint: context.fingerprint,
  }
}

function assertNoUnownedFiles(host: InstallerHost, context: SetupContext): void {
  const paths = context.paths
  const conflicts = [paths.environmentFile, paths.sessionSecretFile, paths.caddyfile, paths.caddyBinary, paths.caddyUnitFile, paths.authStateDirectory, paths.systemdDropInFile]
    .filter(path => host.fileExists(path) && context.state === undefined)
  if (conflicts.length === 0) return
  throw new InstallerError('refusing to overwrite files not owned by dsh-auth', ExitCode.conflict, conflicts.map(path => ({
    code: 'UNOWNED_FILE_CONFLICT', severity: 'error' as const, message: `Existing file is not recorded as dsh-auth-owned: ${path}`,
  })))
}

function profileInstallAction(host: InstallerHost, request: SetupRequest, discovery: HostDiscovery, context: SetupContext): PlanAction {
  const packageState = packageStatus(host, request, discovery)
  const recoverableOwnedPackage = context.state?.status === 'installing'
    && context.state.profilePackageInstalledByDshAuth
    && packageState === 'exact'
  if (packageState !== 'missing' && !recoverableOwnedPackage) {
    throw new InstallerError('existing DSH profile already contains dsh-auth outside installer ownership', ExitCode.conflict, [{ code: 'PROFILE_PACKAGE_CONFLICT', severity: 'error', message: 'The profile already contains dsh-auth without a dsh-auth ownership record.', remediation: 'Preserve or remove that package manually before allowing setup to own the installation.' }])
  }
  const service = discovery.dshService
  if (service === undefined) throw new InstallerError('DSH service discovery is missing', ExitCode.prerequisite)
  const offline = isAbsolute(request.packageSource)
  return {
    id: 'install-profile-package',
    kind: 'install-package',
    description: `Install the pinned dsh-auth bundle into profile ${request.profile}.`,
    command: {
      executable: service.dshExecutable,
      args: ['plugin', '--profile', request.profile, 'add', ...(offline ? ['--offline', '--config.auto-install-peers=false'] : []), request.packageSource],
    },
  }
}

function managedFileActions(request: SetupRequest, context: SetupContext): PlanAction[] {
  const paths = context.paths
  const passwordAction = request.adminBootstrap === 'password'
    ? [{ id: 'write-auth-state', kind: 'write-file' as const, description: 'Write the v2 authentication state with the hashed administrator password.', target: paths.authStateFile, sensitive: true }]
    : [{ id: 'write-auth-state', kind: 'write-file' as const, description: 'Write an unset v2 authentication state for token initialization.', target: paths.authStateFile }]
  return [
    { id: 'create-config-directory', kind: 'create-directory', description: 'Create the permission-restricted configuration directory.', target: paths.configDirectory },
    { id: 'install-caddy-binary', kind: 'write-file', description: 'Copy the checksum-verified Caddy binary bundled in this dsh-auth package.', target: paths.caddyBinary },
    { id: 'write-session-secret', kind: 'write-file', description: 'Generate and write a new session-signing secret.', target: paths.sessionSecretFile, sensitive: true },
    ...passwordAction,
    { id: 'write-environment', kind: 'write-file', description: 'Write the DSH environment file containing secret-file paths, not secret values.', target: paths.environmentFile },
    { id: 'write-caddyfile', kind: 'write-file', description: context.mode === 'system' ? 'Install the project-owned Caddyfile.' : 'Render the Caddyfile for an image or offline deployment.', target: paths.caddyfile },
  ]
}

function activationActions(discovery: HostDiscovery, paths: ManagedPaths): PlanAction[] {
  return [
    { id: 'write-systemd-drop-in', kind: 'write-file', description: 'Install the project-owned EnvironmentFile drop-in without replacing the DSH unit.', target: paths.systemdDropInFile },
    { id: 'write-caddy-unit', kind: 'write-file', description: 'Install the independent dsh-auth-caddy.service unit.', target: paths.caddyUnitFile },
    commandAction('caddy-validate', 'Validate the managed Caddy configuration before activation.', paths.caddyBinary, ['validate', '--config', paths.caddyfile]),
    commandAction('systemd-daemon-reload', 'Reload systemd unit metadata.', '/usr/bin/systemctl', ['daemon-reload']),
    commandAction('restart-dsh', 'Restart the exact DSH service to load the managed environment.', '/usr/bin/systemctl', ['restart', discovery.dshService?.name ?? '']),
    commandAction('enable-caddy', 'Enable and start the independent Caddy edge without touching other services.', '/usr/bin/systemctl', ['enable', '--now', 'dsh-auth-caddy.service']),
  ]
}

/** Build one redacted plan used by dry-run and execution. */
export function prepareSetup(host: InstallerHost, request: SetupRequest, discovery: HostDiscovery, options: { readonly execute: boolean }): PreparedSetup {
  void options.execute
  const mode = request.outputDirectory === undefined ? 'system' : 'output'
  const diagnostics = mode === 'system' ? systemDiagnostics(host, request, discovery) : []
  if (mode === 'output') {
    try {
      resolveCaddyPackage(host)
    } catch (error) {
      if (error instanceof InstallerError) return { plan: blocked(error.diagnostics, mode), request, discovery }
      return { plan: blocked([{ code: 'CADDY_PACKAGE_MISSING', severity: 'error', message: error instanceof Error ? error.message : String(error) }], mode), request, discovery }
    }
  }
  if (diagnostics.some(entry => entry.severity === 'error')) return { plan: blocked(diagnostics, mode), request, discovery }
  if (mode === 'system') assertPublicPortsFree(host, request)
  const context = resolveSetupContext(host, request, discovery, mode)
  if (context === undefined) return { plan: blocked([{ code: 'PATH_DISCOVERY_FAILED', severity: 'error', message: 'Managed paths could not be resolved.' }], mode), request, discovery }
  const unchanged = unchangedPreparation(host, request, discovery, context)
  if (unchanged !== undefined) return unchanged
  assertNoUnownedFiles(host, context)
  const actions = [
    ...(mode === 'system' ? [profileInstallAction(host, request, discovery, context)] : []),
    ...managedFileActions(request, context),
    ...(mode === 'system' ? activationActions(discovery, context.paths) : []),
  ]
  if (context.state?.status === 'installing') {
    actions.unshift({ id: 'recover-interrupted-install', kind: 'remove-file', description: 'Rollback the recorded interrupted installation before retrying.' })
  }
  return {
    plan: { schemaVersion: 2, operation: 'setup', mode, status: 'ready', actions, diagnostics: [], fingerprint: context.fingerprint },
    request,
    discovery,
    ...(context.state === undefined ? {} : { state: context.state }),
    paths: context.paths,
    fingerprint: context.fingerprint,
  }
}

/** Construct the initial persisted state used as a crash-recovery journal. */
export function initialInstallState(prepared: PreparedSetup, caddyBinarySha256: string): InstallState {
  const paths = prepared.paths
  const service = prepared.discovery.dshService
  if (paths === undefined || prepared.fingerprint === undefined) throw new InstallerError('setup plan is not executable', ExitCode.execution)
  return {
    schemaVersion: 2,
    status: 'installing',
    fingerprint: prepared.fingerprint,
    request: persistentRequest(prepared.request),
    paths,
    dshService: service?.name ?? 'output',
    dshUser: service?.user ?? '',
    dshUid: service?.uid ?? (prepared.discovery.effectiveUid ?? 0),
    dshGid: service?.gid ?? 0,
    dshHome: service?.dshHome ?? prepared.request.outputDirectory ?? '',
    dshExecutable: service?.dshExecutable ?? '',
    publicOrigin: publicOrigin(prepared.request),
    authStateFile: paths.authStateFile,
    loginTokenEnabled: prepared.request.loginTokenEnabled,
    caddyVersion: CADDY_VERSION,
    caddyBinarySha256,
    profilePackageInstalledByDshAuth: false,
    createdPaths: [],
  }
}

/** Ensure a state record contains only normalized absolute managed paths before deletion. */
export function validateStatePaths(state: InstallState): void {
  const paths: readonly string[] = Object.values(state.paths)
  for (const path of paths) {
    if (!isAbsolute(path) || path === '/' || path.includes('..')) {
      throw new InstallerError('state contains an unsafe managed path', ExitCode.conflict)
    }
  }
  if (dirname(state.paths.stateFile) !== state.paths.configDirectory) {
    throw new InstallerError('state file is outside its recorded configuration directory', ExitCode.conflict)
  }
}
