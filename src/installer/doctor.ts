import { join } from 'node:path'
import { renderEnvironmentFile, renderSystemdDropIn } from './config-files.js'
import { discoverDshService, discoverPackageManager } from './discovery.js'
import { InstallerError } from './errors.js'
import { discoverNginx, renderNginxConfig } from './nginx.js'
import { expectedManagedOwners } from './ownership.js'
import { readInstallState, validateStatePaths } from './plan.js'
import { ExitCode, type Diagnostic, type DshServiceDiscovery, type InstallationPlan, type InstallerHost, type InstallState } from './types.js'

export const DEFAULT_STATE_FILE = '/etc/dsh-auth/install-state.json'

function permissionDiagnostic(host: InstallerHost, path: string, expected: number): Diagnostic | undefined {
  if (!host.fileExists(path)) return { code: 'MANAGED_FILE_MISSING', severity: 'error', message: `Managed path is missing: ${path}` }
  const actual = host.stat(path).mode & 0o777
  if (actual !== expected) return { code: 'MANAGED_MODE_INVALID', severity: 'error', message: `Managed path ${path} has mode ${actual.toString(8)}; expected ${expected.toString(8)}.` }
  return undefined
}

function managedFileDiagnostics(host: InstallerHost, state: InstallState): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  if (state.status !== 'installed') diagnostics.push({ code: 'INSTALLATION_INTERRUPTED', severity: 'error', message: 'The ownership record shows an interrupted setup.', remediation: 'Rerun setup with the same options to perform recorded recovery before retrying.' })
  const expectedModes = new Map<string, number>([
    [state.paths.configDirectory, 0o750],
    [state.paths.stateFile, 0o600],
    [state.paths.environmentFile, 0o640],
    [state.paths.passwordHashFile, 0o640],
    [state.paths.sessionSecretFile, 0o640],
    [state.paths.sessionDirectory, 0o700],
    [state.paths.systemdDropInFile, 0o644],
    [state.paths.nginxConfigFile, 0o644],
  ])
  for (const [path, mode] of expectedModes) {
    const diagnostic = permissionDiagnostic(host, path, mode)
    if (diagnostic !== undefined) diagnostics.push(diagnostic)
  }
  if (host.regularFile(state.paths.environmentFile) && /^DSH_AUTH_(?:PASSWORD_HASH|SESSION_SECRET)=/mu.test(host.readFile(state.paths.environmentFile))) {
    diagnostics.push({ code: 'INLINE_SECRET_FOUND', severity: 'error', message: 'The managed environment file contains an inline secret value.', remediation: 'Remove public reachability and reinstall with file-backed secrets.' })
  }
  const request = { ...state.request, authorizeNginxInstall: false }
  const expectedFiles = new Map<string, string>([
    [state.paths.environmentFile, renderEnvironmentFile(request, state.paths)],
    [state.paths.systemdDropInFile, renderSystemdDropIn(state.paths)],
    [state.paths.nginxConfigFile, renderNginxConfig(request)],
  ])
  for (const [path, expected] of expectedFiles) {
    if (host.regularFile(path) && host.readFile(path) !== expected) diagnostics.push({ code: 'MANAGED_CONTENT_INVALID', severity: 'error', message: `Managed configuration differs from the ownership record: ${path}` })
  }
  if (host.regularFile(state.paths.passwordHashFile) && !/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+\n?$/u.test(host.readFile(state.paths.passwordHashFile))) {
    diagnostics.push({ code: 'PASSWORD_HASH_INVALID', severity: 'error', message: 'The managed password hash is not a valid Argon2id PHC value.' })
  }
  if (host.regularFile(state.paths.sessionSecretFile) && !/^[A-Za-z0-9_-]{43}\n?$/u.test(host.readFile(state.paths.sessionSecretFile))) {
    diagnostics.push({ code: 'SESSION_SECRET_INVALID', severity: 'error', message: 'The managed session secret is not a valid 32-byte base64url value.' })
  }
  return diagnostics
}

function discoverServiceDiagnostics(host: InstallerHost, state: InstallState): { readonly diagnostics: readonly Diagnostic[]; readonly service?: DshServiceDiscovery } {
  try {
    const service = discoverDshService(host, state.dshService, { dshHome: state.dshHome, dshExecutable: state.dshExecutable })
    const diagnostics = service.activeState === 'active'
      ? []
      : [{ code: 'DSH_SERVICE_INACTIVE', severity: 'error' as const, message: `DSH service ${state.dshService} is not active.` }]
    return { diagnostics, service }
  } catch (error) {
    if (!(error instanceof InstallerError)) throw error
    const diagnostics = error.diagnostics.length > 0
      ? error.diagnostics
      : [{ code: 'DSH_SERVICE_INVALID', severity: 'error' as const, message: error.message }]
    return { diagnostics }
  }
}

function ownerDiagnostics(host: InstallerHost, state: InstallState, service: DshServiceDiscovery | undefined): Diagnostic[] {
  if (service === undefined) return []
  const diagnostics: Diagnostic[] = []
  const expectedOwners = expectedManagedOwners(state.paths, service.uid, service.gid)
  for (const [path, [uid, gid]] of expectedOwners) {
    if (!host.fileExists(path)) continue
    const stat = host.stat(path)
    if (stat.uid !== uid || stat.gid !== gid) diagnostics.push({ code: 'MANAGED_OWNER_INVALID', severity: 'error', message: `Managed path has unexpected owner or group: ${path}` })
  }
  return diagnostics
}

function profilePackageDiagnostic(host: InstallerHost, state: InstallState): Diagnostic | undefined {
  if (!state.profilePackageInstalledByDshAuth) return undefined
  const manifestPath = join(state.dshHome, 'profiles', state.request.profile, 'package.json')
  let packagePresent = false
  if (host.regularFile(manifestPath)) {
    try {
      const manifest = JSON.parse(host.readFile(manifestPath)) as { readonly dependencies?: Record<string, unknown>; readonly dsh?: { readonly profile?: { readonly bundles?: unknown } } }
      packagePresent = typeof manifest.dependencies?.['dsh-auth'] === 'string' && Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes('dsh-auth')
    } catch {
      packagePresent = false
    }
  }
  return packagePresent
    ? undefined
    : { code: 'PROFILE_PACKAGE_MISSING', severity: 'error', message: `The recorded DSH profile ${state.request.profile} no longer contains the dsh-auth bundle.` }
}

function recordedStateDiagnostics(host: InstallerHost, state: InstallState): Diagnostic[] {
  if (state.request.outputDirectory !== undefined) throw new InstallerError('system doctor refuses an output-mode ownership record', ExitCode.conflict)
  validateStatePaths(state)
  const diagnostics = managedFileDiagnostics(host, state)
  const serviceResult = discoverServiceDiagnostics(host, state)
  diagnostics.push(...serviceResult.diagnostics)
  diagnostics.push(...ownerDiagnostics(host, state, serviceResult.service))
  const packageDiagnostic = profilePackageDiagnostic(host, state)
  if (packageDiagnostic !== undefined) diagnostics.push(packageDiagnostic)
  return diagnostics
}

function nginxDiagnostics(host: InstallerHost, state: InstallState | undefined): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const nginx = discoverNginx(host)
  const packageManager = discoverPackageManager(host)
  if (packageManager !== undefined) diagnostics.push({ code: 'PACKAGE_MANAGER_AVAILABLE', severity: 'info', message: `Supported Nginx package source detected: ${packageManager.source}.` })
  if (!nginx.installed) {
    diagnostics.push({ code: 'NGINX_MISSING', severity: 'error', message: 'Nginx is not installed.', remediation: packageManager === undefined ? 'Install Nginx 1.24+ with auth_request from a trusted system repository.' : 'Review plan, then run setup with --nginx install --authorize-nginx-install.' })
    if (packageManager === undefined) diagnostics.push({ code: 'NGINX_INSTALL_UNSUPPORTED', severity: 'error', message: 'No supported operating-system package recipe is available.' })
  } else {
    if (!nginx.versionSupported) diagnostics.push({ code: 'NGINX_VERSION_UNSUPPORTED', severity: 'error', message: `Nginx ${nginx.version ?? 'unknown'} is below the supported 1.24 baseline.` })
    if (!nginx.authRequestModule) diagnostics.push({ code: 'NGINX_AUTH_REQUEST_MISSING', severity: 'error', message: 'Nginx lacks ngx_http_auth_request_module.' })
    if (nginx.serviceName !== 'nginx.service' || nginx.serviceLoadState !== 'loaded') diagnostics.push({ code: 'NGINX_SERVICE_UNAVAILABLE', severity: 'error', message: 'nginx.service is not loaded under systemd.' })
    if (state !== undefined && nginx.includePath !== state.paths.nginxConfigFile) diagnostics.push({ code: 'NGINX_INCLUDE_INACTIVE', severity: 'error', message: 'The recorded dsh-auth Nginx include is not selected by the active main configuration.' })
    if (nginx.executable !== undefined) {
      const test = host.run({ executable: nginx.executable, args: ['-t'] })
      if (test.status !== 0 || test.error !== undefined) diagnostics.push({ code: 'NGINX_CONFIG_TEST_FAILED', severity: 'error', message: 'nginx -t failed; command output was withheld.' })
    }
  }
  const systemctl = ['/usr/bin/systemctl', '/bin/systemctl'].find(candidate => host.regularFile(candidate))
  if (systemctl === undefined) diagnostics.push({ code: 'SYSTEMD_MISSING', severity: 'error', message: 'systemd is unavailable.' })
  else if (host.run({ executable: systemctl, args: ['is-active', '--quiet', 'nginx.service'] }).status !== 0) {
    diagnostics.push({ code: 'NGINX_SERVICE_INACTIVE', severity: 'error', message: 'nginx.service is not active.' })
  }
  return diagnostics
}

/** Run read-only health checks over the host and the recorded installation. */
export function buildDoctorPlan(host: InstallerHost, stateFile = DEFAULT_STATE_FILE): { readonly plan: InstallationPlan; readonly state?: InstallState } {
  const diagnostics: Diagnostic[] = []
  const state = readInstallState(host, stateFile)
  if (state === undefined) {
    diagnostics.push({ code: 'INSTALLATION_NOT_FOUND', severity: 'error', message: 'No managed dsh-auth installation was found.', remediation: 'Run dsh-auth setup, or pass --output-dir when preparing an image.' })
  } else {
    diagnostics.push(...recordedStateDiagnostics(host, state))
  }
  diagnostics.push(...nginxDiagnostics(host, state))
  const healthy = diagnostics.every(entry => entry.severity !== 'error')
  const plan: InstallationPlan = {
    schemaVersion: 1,
    operation: 'doctor',
    mode: 'system',
    status: healthy ? 'ready' : 'blocked',
    actions: [
      { id: 'state', kind: 'check', description: 'Check the ownership record and managed file permissions.' },
      { id: 'dsh-service', kind: 'check', description: 'Check the exact DSH systemd service and executable safety.' },
      { id: 'nginx', kind: 'check', description: 'Check Nginx version, auth_request, configuration syntax, and service state.' },
    ],
    diagnostics,
  }
  return state === undefined ? { plan } : { plan, state }
}

/** Convert a doctor result to its stable process exit code. */
export function doctorExitCode(plan: InstallationPlan): number {
  return plan.status === 'ready' ? ExitCode.success : ExitCode.unhealthy
}
