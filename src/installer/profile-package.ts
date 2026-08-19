import { join } from 'node:path'
import { computePackageIdentity, type PackageIdentity } from './build-identity.js'
import { assertRootOwnedDirectory } from './discovery.js'
import { InstallerError } from './errors.js'
import type { Diagnostic, DshServiceDiscovery, InstallState, InstallerHost, ProfilePackageFacts, SetupRequest } from './types.js'

/** Result of inspecting the DSH profile for an existing dsh-auth package. */
export type ProfilePackageInspection =
  | { readonly kind: 'missing' }
  | AdoptableProfilePackage
  | { readonly kind: 'conflict'; readonly diagnostics: readonly Diagnostic[] }

interface AdoptableProfilePackage {
  readonly kind: 'adoptable'
  readonly facts: ProfilePackageFacts
}

function conflict(code: string, message: string, remediation?: string): { readonly kind: 'conflict'; readonly diagnostics: readonly Diagnostic[] } {
  return { kind: 'conflict', diagnostics: [{ code, severity: 'error' as const, message, ...(remediation === undefined ? {} : { remediation }) }] }
}

/** Directory the DSH profile resolves the dsh-auth bundle from. */
export function profileBundleRoot(dshHome: string, profile: string): string {
  return join(dshHome, 'profiles', profile, 'node_modules', 'dsh-auth')
}

/**
 * Inspect the profile manifest and the bundle it actually resolves. A
 * pre-installed bundle is adoptable only when its package name, version,
 * and build identity equal the running CLI's, so registry, mirror, and
 * tarball installs share one trust decision: same build product or no
 * takeover. Anything else fails closed before host changes.
 */
export function inspectProfilePackage(
  host: InstallerHost,
  request: SetupRequest,
  service: DshServiceDiscovery,
  cli: PackageIdentity,
): ProfilePackageInspection {
  if (service.user === 'root') {
    const profilesDirectory = join(service.dshHome, 'profiles')
    if (host.fileExists(profilesDirectory)) assertRootOwnedDirectory(host, profilesDirectory)
    const profileDirectory = join(profilesDirectory, request.profile)
    if (host.fileExists(profileDirectory)) assertRootOwnedDirectory(host, profileDirectory)
  }
  const manifestPath = join(service.dshHome, 'profiles', request.profile, 'package.json')
  if (!host.regularFile(manifestPath)) return { kind: 'missing' }
  let manifest: unknown
  try {
    manifest = JSON.parse(host.readFile(manifestPath))
  } catch {
    return conflict('PROFILE_MANIFEST_INVALID', `The DSH profile manifest is not valid JSON: ${manifestPath}`)
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return conflict('PROFILE_MANIFEST_INVALID', `The DSH profile manifest is not an object: ${manifestPath}`)
  }
  const record = manifest as { readonly dependencies?: Record<string, unknown>; readonly dsh?: { readonly profile?: { readonly bundles?: unknown } } }
  const dependency = record.dependencies?.['dsh-auth']
  if (dependency === undefined) return { kind: 'missing' }
  if (typeof dependency !== 'string' || dependency.length === 0) {
    return conflict('PROFILE_PACKAGE_CONFLICT', 'The profile declares a non-string dsh-auth dependency.')
  }
  const bundles = record.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes('dsh-auth')) {
    return conflict('PROFILE_BUNDLE_DECLARATION_INVALID', 'The profile declares a dsh-auth dependency that is not listed as a bundle.')
  }
  const bundleRoot = profileBundleRoot(service.dshHome, request.profile)
  if (!host.fileExists(bundleRoot)) {
    return conflict('PROFILE_PACKAGE_UNRESOLVED', `The profile declares dsh-auth but the bundle does not resolve: ${bundleRoot}`, 'Restore or remove the declared bundle with dsh plugin before running setup.')
  }
  const resolvedPath = host.realpath(bundleRoot)
  let identity: PackageIdentity
  try {
    identity = computePackageIdentity(host, resolvedPath, 'profile bundle')
  } catch (error) {
    if (error instanceof InstallerError) return { kind: 'conflict', diagnostics: error.diagnostics }
    throw error
  }
  if (identity.name !== cli.name) {
    return conflict('PROFILE_PACKAGE_NAME_MISMATCH', `The profile resolves package ${identity.name} at the dsh-auth bundle path.`, 'Remove the unexpected package and restore the dsh-auth bundle with dsh plugin before running setup.')
  }
  if (identity.version !== cli.version) {
    return conflict('PROFILE_PACKAGE_VERSION_MISMATCH', `The profile bundle is dsh-auth ${identity.version} but this CLI is ${cli.version}.`, 'Pre-install the same version, or let setup install the bundle itself.')
  }
  if (identity.buildIdentity !== cli.buildIdentity) {
    return conflict('PROFILE_PACKAGE_BUILD_MISMATCH', `The profile bundle is dsh-auth ${identity.version} from a different build than this CLI.`, 'Pre-install the same build product from a trusted source, or let setup install the bundle itself.')
  }
  return {
    kind: 'adoptable',
    facts: {
      origin: 'external',
      spec: dependency,
      version: identity.version,
      buildIdentity: identity.buildIdentity,
      resolvedPath,
    },
  }
}

/** Recorded identity fields for the ownership record; all fields or none. */
export function profilePackageStateFields(facts: {
  readonly origin: 'dsh-auth' | 'external'
  readonly spec: string
  readonly version: string
  readonly buildIdentity: string
  readonly resolvedPath: string
}): Pick<InstallState, 'profilePackageOrigin' | 'profilePackageSpec' | 'profilePackageVersion' | 'profilePackageBuildIdentity' | 'profilePackagePath'> {
  return {
    profilePackageOrigin: facts.origin,
    profilePackageSpec: facts.spec,
    profilePackageVersion: facts.version,
    profilePackageBuildIdentity: facts.buildIdentity,
    profilePackagePath: facts.resolvedPath,
  }
}
