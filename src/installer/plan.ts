import { dirname, isAbsolute, join } from 'node:path'
import { assertRootOwnedDirectory } from './discovery.js'
import { InstallerError } from './errors.js'
import { persistentRequest, renderEnvironmentFile, renderSystemdDropIn, requestFingerprint } from './config-files.js'
import { renderNginxConfig } from './nginx.js'
import { ExitCode, type Diagnostic, type HostDiscovery, type InstallationPlan, type InstallerHost, type InstallState, type ManagedPaths, type PlanAction, type PreparedSetup, type SetupRequest } from './types.js'
import { validateServiceName, validateSetupRequest } from './validation.js'

const SYSTEM_CONFIG_DIRECTORY = '/etc/dsh-auth'
const SYSTEM_SESSION_DIRECTORY = '/var/lib/dsh-auth'

function blocked(diagnostics: readonly Diagnostic[], mode: 'system' | 'output'): InstallationPlan {
  return { schemaVersion: 1, operation: 'setup', mode, status: 'blocked', actions: [], diagnostics }
}

function managedPaths(request: SetupRequest, discovery: HostDiscovery): ManagedPaths | undefined {
  if (request.outputDirectory !== undefined) {
    const root = request.outputDirectory
    return {
      configDirectory: root,
      stateFile: join(root, 'install-state.json'),
      environmentFile: join(root, 'dsh-auth.env'),
      passwordHashFile: join(root, 'password-hash'),
      sessionSecretFile: join(root, 'session-secret'),
      sessionDirectory: join(root, 'state'),
      sessionStoreFile: join(root, 'state', 'sessions.json'),
      systemdDropInDirectory: root,
      systemdDropInFile: join(root, 'dsh-auth.service.conf'),
      nginxConfigFile: join(root, 'dsh-auth.nginx.conf'),
    }
  }
  const service = discovery.dshService
  const nginxPath = discovery.nginx.includePath
    ?? (request.nginxPolicy === 'install' ? '/etc/nginx/conf.d/dsh-auth.conf' : undefined)
  if (service === undefined || nginxPath === undefined) return undefined
  const dropInDirectory = `/etc/systemd/system/${service.name}.d`
  return {
    configDirectory: SYSTEM_CONFIG_DIRECTORY,
    stateFile: join(SYSTEM_CONFIG_DIRECTORY, 'install-state.json'),
    environmentFile: join(SYSTEM_CONFIG_DIRECTORY, 'dsh-auth.env'),
    passwordHashFile: join(SYSTEM_CONFIG_DIRECTORY, 'password-hash'),
    sessionSecretFile: join(SYSTEM_CONFIG_DIRECTORY, 'session-secret'),
    sessionDirectory: SYSTEM_SESSION_DIRECTORY,
    sessionStoreFile: join(SYSTEM_SESSION_DIRECTORY, 'sessions.json'),
    systemdDropInDirectory: dropInDirectory,
    systemdDropInFile: join(dropInDirectory, '50-dsh-auth.conf'),
    nginxConfigFile: nginxPath,
  }
}

/** Return the adjacent crash journal used before the configuration directory exists. */
export function bootstrapStatePath(paths: ManagedPaths): string {
  return `${paths.configDirectory}.installing.json`
}

export function readInstallState(host: InstallerHost, path: string): InstallState | undefined {
  if (!host.fileExists(path)) return undefined
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
  const candidate = value as Partial<InstallState>
  const request = candidate.request as Partial<SetupRequest> | undefined
  const paths = candidate.paths as Partial<ManagedPaths> | undefined
  const pathValues = paths === undefined ? [] : Object.values(paths)
  if (
    candidate.schemaVersion !== 1
    || (candidate.status !== 'installing' && candidate.status !== 'installed')
    || typeof candidate.fingerprint !== 'string'
    || request === undefined
    || paths === undefined
    || pathValues.length !== 10
    || pathValues.some(entry => typeof entry !== 'string')
    || !Array.isArray(candidate.createdPaths)
    || candidate.createdPaths.some(entry => typeof entry !== 'string')
    || typeof candidate.dshService !== 'string'
    || typeof candidate.dshUser !== 'string'
    || typeof candidate.dshHome !== 'string'
    || typeof candidate.dshExecutable !== 'string'
    || typeof candidate.nginxExecutable !== 'string'
    || candidate.nginxService !== 'nginx.service'
    || typeof candidate.nginxInstalledByDshAuth !== 'boolean'
    || typeof candidate.profilePackageInstalledByDshAuth !== 'boolean'
    || (candidate.activation !== undefined && (
      typeof candidate.activation.dshWasActive !== 'boolean'
      || typeof candidate.activation.nginxWasActive !== 'boolean'
      || typeof candidate.activation.nginxWasEnabled !== 'boolean'
      || typeof candidate.activation.daemonReloadAttempted !== 'boolean'
      || typeof candidate.activation.dshRestartAttempted !== 'boolean'
      || typeof candidate.activation.nginxActivationAttempted !== 'boolean'
    ))
  ) {
    throw new InstallerError('dsh-auth state file has an unsupported format', ExitCode.conflict)
  }
  try {
    validateSetupRequest({ ...(request as SetupRequest), authorizeNginxInstall: false })
    if (request.outputDirectory === undefined) validateServiceName(candidate.dshService)
  } catch {
    throw new InstallerError('dsh-auth state file contains invalid setup values', ExitCode.conflict)
  }
  const state = candidate as InstallState
  validateStatePaths(state)
  const ownedPaths = new Set(Object.values(state.paths))
  if (new Set(state.createdPaths).size !== state.createdPaths.length || state.createdPaths.some(entry => !ownedPaths.has(entry))) {
    throw new InstallerError('dsh-auth state file contains unowned paths', ExitCode.conflict)
  }
  if (state.request.outputDirectory === undefined) {
    if (!isAbsolute(state.dshHome) || !isAbsolute(state.dshExecutable) || !host.regularFile(state.dshExecutable)) {
      throw new InstallerError('dsh-auth state file contains an invalid DSH executable', ExitCode.conflict)
    }
    if (!['/usr/sbin/nginx', '/usr/bin/nginx', '/sbin/nginx'].includes(state.nginxExecutable)) {
      throw new InstallerError('dsh-auth state file contains an invalid Nginx executable', ExitCode.conflict)
    }
  }
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
    diagnostics.push({ code: 'ROOT_REQUIRED', severity: 'error', message: 'System setup requires root to manage systemd and Nginx files.', remediation: 'Run setup through sudo, or use --output-dir without system changes.' })
  }
  if (discovery.dshService === undefined) {
    diagnostics.push({ code: 'DSH_SERVICE_REQUIRED', severity: 'error', message: 'An explicit DSH Web systemd service is required.', remediation: 'Pass the exact unit with --dsh-service and, when discovery cannot infer them, --dsh-home and --dsh-bin.' })
  }
  const nginx = discovery.nginx
  if (!nginx.installed) {
    if (request.nginxPolicy === 'require') {
      diagnostics.push({ code: 'NGINX_MISSING', severity: 'error', message: 'Nginx is not installed.', remediation: 'Install Nginx with auth_request, or rerun with --nginx install --authorize-nginx-install on a supported system.' })
    } else if (request.nginxPolicy === 'install' && discovery.packageManager === undefined) {
      diagnostics.push({ code: 'NGINX_INSTALL_UNSUPPORTED', severity: 'error', message: 'No supported operating-system package recipe is available.', remediation: 'Install Nginx 1.24+ with auth_request from a trusted system repository, then use --nginx require.' })
    }
  } else {
    if (!nginx.versionSupported) diagnostics.push({ code: 'NGINX_VERSION_UNSUPPORTED', severity: 'error', message: `Nginx ${nginx.version ?? 'unknown'} is older than the supported 1.24 baseline.`, remediation: 'Upgrade Nginx from the operating-system repository and rerun doctor.' })
    if (!nginx.authRequestModule) diagnostics.push({ code: 'NGINX_AUTH_REQUEST_MISSING', severity: 'error', message: 'Nginx lacks ngx_http_auth_request_module.', remediation: 'Install an Nginx build configured with --with-http_auth_request_module.' })
    if (nginx.configPath === undefined || nginx.includePath === undefined) diagnostics.push({ code: 'NGINX_INCLUDE_UNSUPPORTED', severity: 'error', message: 'No supported http-level conf.d or sites-enabled include was found.', remediation: 'Add a standard absolute include to nginx.conf or use --output-dir and install the rendered include explicitly.' })
    if (nginx.serviceManager !== 'systemd' || nginx.serviceName !== 'nginx.service' || nginx.serviceLoadState !== 'loaded') diagnostics.push({ code: 'NGINX_SYSTEMD_REQUIRED', severity: 'error', message: 'The supported system setup requires a loaded nginx.service under systemd.' })
  }
  if (request.mode === 'https') {
    if (request.certificate !== undefined && !host.regularFile(request.certificate)) diagnostics.push({ code: 'CERTIFICATE_NOT_FOUND', severity: 'error', message: 'The TLS certificate is not a readable regular file.' })
    if (request.certificateKey !== undefined && !host.regularFile(request.certificateKey)) diagnostics.push({ code: 'CERTIFICATE_KEY_NOT_FOUND', severity: 'error', message: 'The TLS certificate key is not a readable regular file.' })
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
    [state.paths.passwordHashFile, output ? 0o600 : 0o640],
    [state.paths.sessionSecretFile, output ? 0o600 : 0o640],
    [state.paths.sessionDirectory, 0o700],
    [state.paths.nginxConfigFile, 0o644],
    ...(output ? [] : [[state.paths.systemdDropInFile, 0o644] as const]),
  ])
  for (const path of state.createdPaths) {
    if (!host.fileExists(path)) {
      drift('MANAGED_PATH_MISSING', `Recorded path is missing: ${path}`)
    }
    const expected = modes.get(path)
    if (expected !== undefined && (host.stat(path).mode & 0o777) !== expected) {
      drift('MANAGED_MODE_DRIFT', `Recorded path has unexpected permissions: ${path}`)
    }
  }
  const service = discovery.dshService
  if (!output && service !== undefined) {
    const owners = new Map<string, readonly [number, number]>([
      [state.paths.configDirectory, [0, service.gid]],
      [state.paths.stateFile, [0, 0]],
      [state.paths.environmentFile, [0, service.gid]],
      [state.paths.passwordHashFile, [0, service.gid]],
      [state.paths.sessionSecretFile, [0, service.gid]],
      [state.paths.sessionDirectory, [service.uid, service.gid]],
      [state.paths.systemdDropInFile, [0, 0]],
      [state.paths.nginxConfigFile, [0, 0]],
    ])
    for (const [path, [uid, gid]] of owners) {
      if (!host.fileExists(path)) continue
      const actual = host.stat(path)
      if (actual.uid !== uid || actual.gid !== gid) drift('MANAGED_OWNER_DRIFT', `Recorded path has unexpected ownership: ${path}`)
    }
  }
  const expectedFiles = new Map<string, string>([
    [state.paths.environmentFile, renderEnvironmentFile(request, state.paths)],
    [state.paths.nginxConfigFile, renderNginxConfig(request)],
    ...(output ? [] : [[state.paths.systemdDropInFile, renderSystemdDropIn(state.paths)] as const]),
  ])
  for (const [path, expected] of expectedFiles) {
    if (!host.regularFile(path) || host.readFile(path) !== expected) {
      drift('MANAGED_CONTENT_DRIFT', `Recorded managed configuration differs from the requested installation: ${path}`)
    }
  }
  if (!host.regularFile(state.paths.passwordHashFile) || !/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+\n?$/u.test(host.readFile(state.paths.passwordHashFile))) {
    drift('PASSWORD_HASH_INVALID', 'The managed password hash is not a valid Argon2id PHC value.')
  }
  if (!host.regularFile(state.paths.sessionSecretFile) || !/^[A-Za-z0-9_-]{43}\n?$/u.test(host.readFile(state.paths.sessionSecretFile))) {
    drift('SESSION_SECRET_INVALID', 'The managed session secret is not a valid 32-byte base64url value.')
  }
}

/** Build one redacted plan used by dry-run and execution. */
export function prepareSetup(host: InstallerHost, request: SetupRequest, discovery: HostDiscovery, options: { readonly execute: boolean }): PreparedSetup {
  const mode = request.outputDirectory === undefined ? 'system' : 'output'
  const diagnostics = mode === 'system' ? systemDiagnostics(host, request, discovery) : []
  if (diagnostics.some(entry => entry.severity === 'error')) {
    return { plan: blocked(diagnostics, mode), request, discovery }
  }
  if (options.execute && request.nginxPolicy === 'install' && !discovery.nginx.installed && !request.authorizeNginxInstall) {
    return {
      plan: blocked([{
        code: 'NGINX_INSTALL_NOT_AUTHORIZED',
        severity: 'error',
        message: 'Nginx package installation requires explicit execution authorization.',
        remediation: 'Review `dsh-auth plan`, then add --authorize-nginx-install to the setup command.',
      }], mode),
      request,
      discovery,
    }
  }
  const paths = managedPaths(request, discovery)
  if (paths === undefined) return { plan: blocked([{ code: 'PATH_DISCOVERY_FAILED', severity: 'error', message: 'Managed paths could not be resolved.' }], mode), request, discovery }
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
  if (state?.status === 'installed') {
    verifyInstalledState(host, state, request, discovery)
    return {
      plan: { schemaVersion: 1, operation: 'setup', mode, status: 'unchanged', actions: [{ id: 'verify', kind: 'check', description: 'Verify the existing managed installation.' }], diagnostics: [], fingerprint },
      request,
      discovery,
      state,
      paths,
      fingerprint,
    }
  }

  const conflicts = [paths.sessionDirectory, paths.environmentFile, paths.passwordHashFile, paths.sessionSecretFile, paths.systemdDropInFile, paths.nginxConfigFile]
    .filter(path => host.fileExists(path) && state === undefined)
  if (conflicts.length > 0) {
    throw new InstallerError('refusing to overwrite files not owned by dsh-auth', ExitCode.conflict, conflicts.map(path => ({
      code: 'UNOWNED_FILE_CONFLICT', severity: 'error' as const, message: `Existing file is not recorded as dsh-auth-owned: ${path}`,
    })))
  }

  const actions: PlanAction[] = []
  if (!discovery.nginx.installed && request.nginxPolicy === 'install') {
    for (const [index, command] of (discovery.packageManager?.commands ?? []).entries()) {
      actions.push({ id: `install-nginx-${String(index + 1)}`, kind: 'install-package', description: `Install Nginx from ${discovery.packageManager?.source ?? 'the system repository'}.`, command })
    }
  }
  if (mode === 'system') {
    const packageState = packageStatus(host, request, discovery)
    const recoverableOwnedPackage = state?.status === 'installing' && state.profilePackageInstalledByDshAuth && packageState === 'exact'
    if (packageState !== 'missing' && !recoverableOwnedPackage) {
      throw new InstallerError('existing DSH profile already contains dsh-auth outside installer ownership', ExitCode.conflict, [{ code: 'PROFILE_PACKAGE_CONFLICT', severity: 'error', message: 'The profile already contains dsh-auth without a dsh-auth ownership record.', remediation: 'Preserve or remove that package manually before allowing setup to own the installation.' }])
    }
    const service = discovery.dshService
    if (service === undefined) throw new InstallerError('DSH service discovery is missing', ExitCode.prerequisite)
    const offline = isAbsolute(request.packageSource)
    actions.push({
      id: 'install-profile-package',
      kind: 'install-package',
      description: `Install the pinned dsh-auth bundle into profile ${request.profile}.`,
      command: {
        executable: service.dshExecutable,
        args: ['plugin', '--profile', request.profile, 'add', ...(offline ? ['--offline', '--config.auto-install-peers=false'] : []), request.packageSource],
      },
    })
  }
  actions.push(
    { id: 'create-config-directory', kind: 'create-directory', description: 'Create the permission-restricted configuration directory.', target: paths.configDirectory },
    { id: 'write-password-hash', kind: 'write-file', description: 'Hash the password from the selected non-argv input and write only the Argon2id hash.', target: paths.passwordHashFile, sensitive: true },
    { id: 'write-session-secret', kind: 'write-file', description: 'Generate and write a new session-signing secret.', target: paths.sessionSecretFile, sensitive: true },
    { id: 'write-environment', kind: 'write-file', description: 'Write the DSH environment file containing secret-file paths, not secret values.', target: paths.environmentFile },
    { id: 'write-nginx', kind: 'write-file', description: mode === 'system' ? 'Install the project-owned Nginx include.' : 'Render the Nginx include for an image or offline deployment.', target: paths.nginxConfigFile },
  )
  if (mode === 'system') {
    actions.push(
      { id: 'write-systemd-drop-in', kind: 'write-file', description: 'Install the project-owned EnvironmentFile drop-in without replacing the DSH unit.', target: paths.systemdDropInFile },
      commandAction('systemd-daemon-reload', 'Reload systemd unit metadata.', '/usr/bin/systemctl', ['daemon-reload']),
      commandAction('nginx-test', 'Validate the complete Nginx configuration before activation.', discovery.nginx.executable ?? '/usr/sbin/nginx', ['-t']),
      commandAction('restart-dsh', 'Restart the exact DSH service to load the managed environment.', '/usr/bin/systemctl', ['restart', discovery.dshService?.name ?? '']),
      commandAction('reload-nginx', 'Reload nginx.service only after validation succeeds.', '/usr/bin/systemctl', ['reload', 'nginx.service']),
    )
  }
  if (state?.status === 'installing') {
    actions.unshift({ id: 'recover-interrupted-install', kind: 'remove-file', description: 'Rollback the recorded interrupted installation before retrying.' })
  }
  return {
    plan: { schemaVersion: 1, operation: 'setup', mode, status: 'ready', actions, diagnostics: [], fingerprint },
    request,
    discovery,
    ...(state === undefined ? {} : { state }),
    paths,
    fingerprint,
  }
}

/** Construct the initial persisted state used as a crash-recovery journal. */
export function initialInstallState(prepared: PreparedSetup): InstallState {
  const paths = prepared.paths
  const service = prepared.discovery.dshService
  const nginxExecutable = prepared.discovery.nginx.executable ?? '/usr/sbin/nginx'
  if (paths === undefined || prepared.fingerprint === undefined) throw new InstallerError('setup plan is not executable', ExitCode.execution)
  return {
    schemaVersion: 1,
    status: 'installing',
    fingerprint: prepared.fingerprint,
    request: persistentRequest(prepared.request),
    paths,
    dshService: service?.name ?? 'output',
    dshUser: service?.user ?? '',
    dshHome: service?.dshHome ?? prepared.request.outputDirectory ?? '',
    dshExecutable: service?.dshExecutable ?? '',
    nginxExecutable,
    nginxService: 'nginx.service',
    nginxInstalledByDshAuth: false,
    profilePackageInstalledByDshAuth: false,
    createdPaths: [],
  }
}

/** Ensure a state record contains only normalized absolute managed paths before deletion. */
export function validateStatePaths(state: InstallState): void {
  const paths: readonly string[] = [
    state.paths.configDirectory,
    state.paths.stateFile,
    state.paths.environmentFile,
    state.paths.passwordHashFile,
    state.paths.sessionSecretFile,
    state.paths.sessionDirectory,
    state.paths.sessionStoreFile,
    state.paths.systemdDropInDirectory,
    state.paths.systemdDropInFile,
    state.paths.nginxConfigFile,
  ]
  for (const path of paths) {
    if (!isAbsolute(path) || path === '/' || path.includes('..')) {
      throw new InstallerError('state contains an unsafe managed path', ExitCode.conflict)
    }
  }
  if (dirname(state.paths.stateFile) !== state.paths.configDirectory) {
    throw new InstallerError('state file is outside its recorded configuration directory', ExitCode.conflict)
  }
  const output = state.request.outputDirectory
  if (output !== undefined) {
    const expected: ManagedPaths = {
      configDirectory: output,
      stateFile: join(output, 'install-state.json'),
      environmentFile: join(output, 'dsh-auth.env'),
      passwordHashFile: join(output, 'password-hash'),
      sessionSecretFile: join(output, 'session-secret'),
      sessionDirectory: join(output, 'state'),
      sessionStoreFile: join(output, 'state', 'sessions.json'),
      systemdDropInDirectory: output,
      systemdDropInFile: join(output, 'dsh-auth.service.conf'),
      nginxConfigFile: join(output, 'dsh-auth.nginx.conf'),
    }
    for (const key of Object.keys(expected) as (keyof ManagedPaths)[]) {
      if (state.paths[key] !== expected[key]) throw new InstallerError('output state paths do not match the recorded output directory', ExitCode.conflict)
    }
    if (state.dshService !== 'output') throw new InstallerError('output state has an invalid service marker', ExitCode.conflict)
    return
  }
  validateServiceName(state.dshService)
  const expectedSystem: Omit<ManagedPaths, 'nginxConfigFile'> = {
    configDirectory: SYSTEM_CONFIG_DIRECTORY,
    stateFile: join(SYSTEM_CONFIG_DIRECTORY, 'install-state.json'),
    environmentFile: join(SYSTEM_CONFIG_DIRECTORY, 'dsh-auth.env'),
    passwordHashFile: join(SYSTEM_CONFIG_DIRECTORY, 'password-hash'),
    sessionSecretFile: join(SYSTEM_CONFIG_DIRECTORY, 'session-secret'),
    sessionDirectory: SYSTEM_SESSION_DIRECTORY,
    sessionStoreFile: join(SYSTEM_SESSION_DIRECTORY, 'sessions.json'),
    systemdDropInDirectory: `/etc/systemd/system/${state.dshService}.d`,
    systemdDropInFile: `/etc/systemd/system/${state.dshService}.d/50-dsh-auth.conf`,
  }
  for (const key of Object.keys(expectedSystem) as (keyof typeof expectedSystem)[]) {
    if (state.paths[key] !== expectedSystem[key]) throw new InstallerError('system state paths do not match dsh-auth managed targets', ExitCode.conflict)
  }
  if (!['/etc/nginx/conf.d/dsh-auth.conf', '/etc/nginx/sites-enabled/dsh-auth.conf'].includes(state.paths.nginxConfigFile)) {
    throw new InstallerError('system state contains an unsupported Nginx target', ExitCode.conflict)
  }
}
