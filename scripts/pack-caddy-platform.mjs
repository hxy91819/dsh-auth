/**
 * Build the bundled Caddy vendor tree from the pinned official release.
 * Production setup copies from this already-published tree and never downloads.
 *
 * Definition:
 *   Maintainer packer for `vendor/caddy`. Not a setup, preinstall, or
 *   postinstall path. Downloads happen only in this packer and release pack.
 *
 * Parameters:
 *   --output PATH   Absolute vendor directory. Default: <checkout>/vendor/caddy.
 *   --clean         Replace an existing output directory.
 *
 * Outputs:
 *   Writes manifest.json, manifest.sha256, LICENSE, THIRD_PARTY.md, and the
 *   linux-x64 / linux-arm64 Caddy binaries. Prints a JSON receipt to stdout.
 *   Exit 0 on success, 2 for usage errors, 1 for packing failures.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { caddyReleaseManifest, prepareCaddyRelease } from './caddy-release.mjs'

const HELP = `Usage:
  node scripts/pack-caddy-platform.mjs [--output ABSOLUTE_DIRECTORY] [--clean]

Description:
  Download and verify the pinned official Caddy archives, then write both
  linux-x64 and linux-arm64 binaries into the dsh-auth vendor layout. This is
  a maintainer packer used by npm pack/prepack. Setup never downloads Caddy.

Options:
  --output PATH  Absolute vendor directory. Default: <checkout>/vendor/caddy.
  --clean        Replace the output directory if it already exists.
  -h, --help     Show this help.

Outputs:
  Writes vendor/caddy/manifest.json, manifest.sha256, LICENSE, THIRD_PARTY.md,
  linux-x64/caddy, and linux-arm64/caddy. Prints one JSON receipt to stdout.
  Exit 0 means every checksum matched; exit 2 means invalid arguments.

Examples:
  node scripts/pack-caddy-platform.mjs --clean
  node scripts/pack-caddy-platform.mjs --output /tmp/dsh-auth-vendor-caddy --clean
`

const CHECKOUT = resolve(import.meta.dirname, '..')
const DEFAULT_OUTPUT = join(CHECKOUT, 'vendor/caddy')
const PLATFORMS = Object.freeze(['linux-x64', 'linux-arm64'])

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Write the self-contained vendor/caddy layout for both Linux architectures.
 * @param {string} outputDirectory
 * @param {{ readonly clean?: boolean }} [options]
 */
export async function writeBundledCaddyVendor(outputDirectory, options = {}) {
  if (!isAbsolute(outputDirectory)) throw new Error('output directory must be absolute')
  const clean = options.clean === true
  if (existsSync(outputDirectory)) {
    const stat = lstatSync(outputDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('output must be a real directory')
    if (!clean) throw new Error('output directory exists; pass --clean to replace it')
    rmSync(outputDirectory, { recursive: true, force: true })
  }
  mkdirSync(outputDirectory, { recursive: true, mode: 0o755 })
  const manifest = caddyReleaseManifest()
  const staging = join(outputDirectory, '.staging')
  mkdirSync(staging, { mode: 0o700 })
  /** @type {Record<string, { executable: string, binarySha256: string, upstreamArchive: string, upstreamUrl: string }>} */
  const platforms = {}
  try {
    let licenseBytes
    for (const selected of PLATFORMS) {
      const entry = manifest.platforms[selected]
      const receipt = await prepareCaddyRelease(join(staging, selected), selected)
      mkdirSync(join(outputDirectory, selected), { mode: 0o755 })
      const binary = readFileSync(receipt.binary)
      if (digest(binary) !== entry.binarySha256) throw new Error(`bundled Caddy ${selected} SHA-256 mismatch`)
      writeFileSync(join(outputDirectory, selected, 'caddy'), binary, { mode: 0o755 })
      chmodSync(join(outputDirectory, selected, 'caddy'), 0o755)
      platforms[selected] = {
        executable: `${selected}/caddy`,
        binarySha256: receipt.binarySha256,
        upstreamArchive: entry.archive,
        upstreamUrl: `${manifest.releaseBaseUrl}/${entry.archive}`,
      }
      const nextLicense = readFileSync(receipt.license)
      if (digest(nextLicense) !== manifest.licenseSha256) throw new Error('bundled Caddy LICENSE SHA-256 mismatch')
      if (licenseBytes === undefined) licenseBytes = nextLicense
      else if (!licenseBytes.equals(nextLicense)) throw new Error('Caddy LICENSE files differ across architectures')
    }
    if (licenseBytes === undefined) throw new Error('bundled Caddy LICENSE is missing')
    writeFileSync(join(outputDirectory, 'LICENSE'), licenseBytes, { mode: 0o644 })
    writeFileSync(
      join(outputDirectory, 'THIRD_PARTY.md'),
      'This package redistributes the unmodified official Caddy binaries and LICENSE from https://github.com/caddyserver/caddy.\n',
      { mode: 0o644 },
    )
    const packageManifest = `${JSON.stringify({
      schemaVersion: 1,
      caddyVersion: manifest.caddyVersion,
      packageRevision: 'dsh.1',
      licenseSha256: manifest.licenseSha256,
      platforms,
    }, undefined, 2)}\n`
    writeFileSync(join(outputDirectory, 'manifest.json'), packageManifest, { mode: 0o644 })
    writeFileSync(join(outputDirectory, 'manifest.sha256'), `${digest(packageManifest)}\n`, { mode: 0o644 })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return {
    caddyVersion: manifest.caddyVersion,
    packageRevision: 'dsh.1',
    directory: outputDirectory,
    platforms,
  }
}

function parseArgs(argv) {
  const args = argv.filter(argument => argument !== '--')
  if (args.includes('--help') || args.includes('-h')) return { help: true }
  let output = DEFAULT_OUTPUT
  let clean = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--clean') {
      clean = true
      continue
    }
    if (argument !== '--output') {
      throw Object.assign(new Error(`unknown argument: ${argument}`), { exitCode: 2 })
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('-')) {
      throw Object.assign(new Error('--output requires an absolute directory'), { exitCode: 2 })
    }
    output = value
    index += 1
  }
  if (!isAbsolute(output)) {
    throw Object.assign(new Error('--output must be an absolute directory'), { exitCode: 2 })
  }
  return { help: false, output, clean }
}

const isMainModule = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMainModule) {
  const parsed = (() => {
    try {
      return parseArgs(process.argv.slice(2))
    } catch (error) {
      const exitCode = error instanceof Error && 'exitCode' in error && typeof error.exitCode === 'number' ? error.exitCode : 1
      if (exitCode === 2) process.stderr.write(HELP)
      process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(exitCode)
    }
  })()
  if (parsed.help) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  writeBundledCaddyVendor(parsed.output, { clean: parsed.clean }).then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt, undefined, 2)}\n`)
  }).catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
