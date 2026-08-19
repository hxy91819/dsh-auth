import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { InstallerError } from './errors.js'
import { ExitCode, type InstallerHost } from './types.js'

/** Content identity of one extracted dsh-auth package tree. */
export interface PackageIdentity {
  readonly name: string
  readonly version: string
  readonly buildIdentity: string
}

const DIGEST_HEADER = 'dsh-auth-build-identity-v1'

function fileDigest(host: InstallerHost, path: string): string {
  return createHash('sha256').update(host.readFileBytes(path)).digest('hex')
}

function collectFiles(host: InstallerHost, root: string, relative: string, files: string[]): void {
  for (const entry of [...host.listDirectory(join(root, relative))].sort()) {
    const entryRelative = relative === '' ? entry : `${relative}/${entry}`
    if (host.stat(join(root, entryRelative)).isDirectory) collectFiles(host, root, entryRelative, files)
    else files.push(entryRelative)
  }
}

/**
 * Compute a build identity over the extracted package content. The same
 * tarball installed from a registry, a private mirror, or a local file
 * yields the same digest; any content difference yields a different one.
 * @param host - installer host adapter.
 * @param packageRoot - extracted package directory; symlinks must be resolved first.
 * @param label - operator-facing label used in failure messages.
 * @returns name, version, and sha256 build identity of the tree.
 */
export function computePackageIdentity(host: InstallerHost, packageRoot: string, label: string): PackageIdentity {
  const manifestPath = join(packageRoot, 'package.json')
  if (!host.regularFile(manifestPath)) {
    throw new InstallerError(`${label} package manifest is missing`, ExitCode.conflict, [{
      code: 'PROFILE_PACKAGE_INVALID',
      severity: 'error',
      message: `${label} package manifest is missing or not a regular file: ${manifestPath}`,
    }])
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(host.readFile(manifestPath))
  } catch {
    throw new InstallerError(`${label} package manifest is invalid`, ExitCode.conflict, [{
      code: 'PROFILE_PACKAGE_INVALID',
      severity: 'error',
      message: `${label} package manifest is not valid JSON: ${manifestPath}`,
    }])
  }
  const record = manifest as { readonly name?: unknown; readonly version?: unknown }
  if (typeof record.name !== 'string' || typeof record.version !== 'string') {
    throw new InstallerError(`${label} package manifest lacks name or version`, ExitCode.conflict, [{
      code: 'PROFILE_PACKAGE_INVALID',
      severity: 'error',
      message: `${label} package manifest must declare string name and version: ${manifestPath}`,
    }])
  }
  const files: string[] = []
  collectFiles(host, packageRoot, '', files)
  const digest = createHash('sha256')
  digest.update(`${DIGEST_HEADER}\n${record.name}\n${record.version}\n`)
  for (const file of files) digest.update(`${file}\n${fileDigest(host, join(packageRoot, file))}\n`)
  return { name: record.name, version: record.version, buildIdentity: digest.digest('hex') }
}

/**
 * Identity of the globally installed CLI package that is running now. The
 * bundle root is derived from the same injected package anchor the bundled
 * Caddy verification uses, so root privileges are never extended to code
 * resolved from the profile tree.
 */
export function resolveCliPackageIdentity(host: InstallerHost): PackageIdentity {
  return computePackageIdentity(host, dirname(dirname(host.resolveBundledCaddyRoot())), 'CLI')
}
