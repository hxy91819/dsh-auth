import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { CADDY_SERVICE_NAME, CADDY_VERSION, renderCaddyfile, renderCaddyUnit, resolveCaddyPackage } from './caddy.js'
import { renderEnvironmentFile, renderSystemdDropIn } from './config-files.js'
import { discoverDshService } from './discovery.js'
import { InstallerError } from './errors.js'
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
    [state.paths.sessionSecretFile, 0o640],
    [state.paths.caddyfile, 0o644],
    [state.paths.caddyBinary, 0o755],
    [state.paths.caddyBinaryDirectory, 0o755],
    [state.paths.caddyUnitFile, 0o644],
    [state.paths.authStateDirectory, 0o700],
    [state.paths.authStateFile, 0o600],
    [state.paths.loginTokenDirectory, 0o700],
    [state.paths.systemdDropInFile, 0o644],
  ])
  for (const [path, mode] of expectedModes) {
    const diagnostic = permissionDiagnostic(host, path, mode)
    if (diagnostic !== undefined) diagnostics.push(diagnostic)
  }
  if (host.regularFile(state.paths.environmentFile) && /^DSH_AUTH_(?:PASSWORD_HASH|SESSION_SECRET)=/mu.test(host.readFile(state.paths.environmentFile))) {
    diagnostics.push({ code: 'INLINE_SECRET_FOUND', severity: 'error', message: 'The managed environment file contains an inline secret value.', remediation: 'Remove public reachability and reinstall with file-backed secrets.' })
  }
  const expectedFiles = new Map<string, string>([
    [state.paths.environmentFile, renderEnvironmentFile(state.request, state.paths)],
    [state.paths.systemdDropInFile, renderSystemdDropIn(state.paths)],
    [state.paths.caddyfile, renderCaddyfile(state.request, true)],
    [state.paths.caddyUnitFile, renderCaddyUnit(state.request, state.paths)],
  ])
  for (const [path, expected] of expectedFiles) {
    if (host.regularFile(path) && host.readFile(path) !== expected) {
      diagnostics.push({ code: 'MANAGED_CONTENT_INVALID', severity: 'error', message: `Managed configuration differs from the ownership record: ${path}` })
    }
  }
  if (host.regularFile(state.paths.sessionSecretFile) && !/^[A-Za-z0-9_-]{43}\n?$/u.test(host.readFile(state.paths.sessionSecretFile))) {
    diagnostics.push({ code: 'SESSION_SECRET_INVALID', severity: 'error', message: 'The managed session secret is not a valid 32-byte base64url value.' })
  }
  if (host.regularFile(state.paths.authStateFile) && !/"schemaVersion":\s*2/u.test(host.readFile(state.paths.authStateFile))) {
    diagnostics.push({ code: 'AUTH_STATE_INVALID', severity: 'error', message: 'The managed authentication state is not schema v2.' })
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
  if (state.dshUid !== service.uid || state.dshGid !== service.gid) {
    diagnostics.push({ code: 'SERVICE_IDENTITY_DRIFT', severity: 'error', message: 'Recorded DSH service UID/GID does not match the running unit.' })
  }
  return diagnostics
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function profileDiagnostics(host: InstallerHost, state: InstallState): Diagnostic[] {
  const path = profileManifestPath(state)
  if (!host.regularFile(path)) {
    return [{ code: 'PROFILE_PACKAGE_MISSING', severity: 'error', message: `DSH profile package manifest is missing: ${path}` }]
  }
  return []
}

function caddyDiagnostics(host: InstallerHost, state: InstallState): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  try {
    const pkg = resolveCaddyPackage(host)
    if (pkg.binarySha256 !== state.caddyBinarySha256) {
      diagnostics.push({ code: 'CADDY_CHECKSUM_DRIFT', severity: 'error', message: 'Installed Caddy checksum does not match the ownership record.' })
    }
  } catch (error) {
    if (error instanceof InstallerError) diagnostics.push(...error.diagnostics)
  }
  if (state.caddyVersion !== CADDY_VERSION) {
    diagnostics.push({ code: 'CADDY_VERSION_DRIFT', severity: 'error', message: `Recorded Caddy version ${state.caddyVersion} is not ${CADDY_VERSION}.` })
  }
  if (host.regularFile(state.paths.caddyBinary)) {
    if (digest(host.readFileBytes(state.paths.caddyBinary)) !== state.caddyBinarySha256) {
      diagnostics.push({ code: 'CADDY_CHECKSUM_DRIFT', severity: 'error', message: 'Managed Caddy binary does not match the ownership-record checksum.' })
    }
    const version = host.run({ executable: state.paths.caddyBinary, args: ['version'] })
    if (version.status !== 0 || !version.stdout.includes(CADDY_VERSION)) {
      diagnostics.push({ code: 'CADDY_VERSION_INVALID', severity: 'error', message: 'Managed Caddy binary did not report the frozen version.' })
    }
  }
  const systemctl = ['/usr/bin/systemctl', '/bin/systemctl'].find(candidate => host.regularFile(candidate))
  if (systemctl !== undefined) {
    const active = host.run({ executable: systemctl, args: ['is-active', '--quiet', CADDY_SERVICE_NAME] })
    if (active.status !== 0) diagnostics.push({ code: 'CADDY_SERVICE_INACTIVE', severity: 'error', message: 'dsh-auth-caddy.service is not active.' })
  }
  return diagnostics
}

function loopbackDiagnostics(state: InstallState): Diagnostic[] {
  const upstream = state.request.upstream
  if (!upstream.startsWith('127.0.0.1:') && !upstream.startsWith('[::1]:')) {
    return [{ code: 'HARNESS_NOT_LOOPBACK', severity: 'error', message: 'Harness upstream is not a loopback address.' }]
  }
  return []
}

/** Build a read-only health plan from the completed ownership record. */
export function buildDoctorPlan(host: InstallerHost, stateFile = DEFAULT_STATE_FILE): { readonly plan: InstallationPlan } {
  const state = readInstallState(host, stateFile)
  if (state === undefined) {
    return { plan: { schemaVersion: 2, operation: 'doctor', mode: 'system', status: 'blocked', actions: [], diagnostics: [{ code: 'INSTALLATION_NOT_FOUND', severity: 'error', message: 'No managed installation exists.' }] } }
  }
  if (state.request.outputDirectory !== undefined) {
    throw new InstallerError('system doctor refuses an output-mode ownership record', ExitCode.conflict)
  }
  validateStatePaths(state)
  const discovered = discoverServiceDiagnostics(host, state)
  const diagnostics = [
    ...managedFileDiagnostics(host, state),
    ...discovered.diagnostics,
    ...ownerDiagnostics(host, state, discovered.service),
    ...profileDiagnostics(host, state),
    ...caddyDiagnostics(host, state),
    ...loopbackDiagnostics(state),
  ]
  const healthy = diagnostics.every(entry => entry.severity !== 'error')
  return {
    plan: {
      schemaVersion: 2,
      operation: 'doctor',
      mode: 'system',
      status: healthy ? 'ready' : 'blocked',
      actions: healthy ? [{ id: 'verify', kind: 'check', description: 'Verify the managed Caddy edge, authentication state, and DSH service.' }] : [],
      diagnostics,
    },
  }
}

export function doctorExitCode(plan: InstallationPlan): number {
  return plan.status === 'ready' ? ExitCode.success : ExitCode.unhealthy
}

function profileManifestPath(state: InstallState): string {
  return join(state.dshHome, 'profiles', state.request.profile, 'package.json')
}
