/**
 * Build the exact Caddy platform npm packages from the pinned official release.
 * Production setup copies from an already-installed package and never downloads.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { caddyReleaseManifest, prepareCaddyRelease } from './caddy-release.mjs'

const HELP = `Usage:
  node scripts/pack-caddy-platform.mjs --output ABSOLUTE_DIRECTORY [--platform PLATFORM]

Description:
  Download and verify the pinned official Caddy archive, then write an npm
  platform package layout. This is a maintainer packer, not a setup path.

Options:
  --output PATH       Required new or empty absolute output directory.
  --platform VALUE    linux-x64, linux-arm64, or all (default: all).
  -h, --help          Show this help.
`

const CADDY_PACKAGE_VERSION = '2.11.4-dsh.1'
const args = process.argv.slice(2).filter(argument => argument !== '--')
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}

let output
let platform = 'all'
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  if (argument !== '--output' && argument !== '--platform') {
    process.stderr.write(HELP)
    process.exit(2)
  }
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) {
    process.stderr.write(`ERROR: ${argument} requires a value\n`)
    process.exit(2)
  }
  if (argument === '--output') output = value
  else platform = value
  index += 1
}
if (output === undefined) {
  process.stderr.write('ERROR: --output is required\n')
  process.exit(2)
}
if (platform !== 'all' && platform !== 'linux-x64' && platform !== 'linux-arm64') {
  process.stderr.write('ERROR: --platform must be linux-x64, linux-arm64, or all\n')
  process.exit(2)
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function packPlatform(root, selected) {
  const manifest = caddyReleaseManifest()
  const entry = manifest.platforms[selected]
  const runtime = join(root, `.runtime-${selected}`)
  const receipt = await prepareCaddyRelease(runtime, selected)
  const name = `dsh-auth-caddy-${selected}`
  const directory = join(root, name)
  mkdirSync(directory, { mode: 0o755 })
  const packageManifest = `${JSON.stringify({
    schemaVersion: 1,
    caddyVersion: manifest.caddyVersion,
    packageRevision: 'dsh.1',
    platform: selected,
    executable: 'caddy',
    upstreamArchive: entry.archive,
    upstreamUrl: `${manifest.releaseBaseUrl}/${entry.archive}`,
    binarySha256: receipt.binarySha256,
    licenseSha256: receipt.licenseSha256,
  }, undefined, 2)}\n`
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
    name,
    version: CADDY_PACKAGE_VERSION,
    description: `Unmodified Caddy v${manifest.caddyVersion} for dsh-auth on ${selected}`,
    license: 'Apache-2.0',
    files: ['caddy', 'manifest.json', 'manifest.sha256', 'LICENSE', 'THIRD_PARTY.md'],
    os: ['linux'],
    cpu: [selected === 'linux-x64' ? 'x64' : 'arm64'],
  }, undefined, 2)}\n`)
  writeFileSync(join(directory, 'manifest.json'), packageManifest)
  writeFileSync(join(directory, 'manifest.sha256'), `${digest(packageManifest)}\n`)
  writeFileSync(join(directory, 'LICENSE'), readFileSync(join(runtime, 'LICENSE')))
  writeFileSync(
    join(directory, 'THIRD_PARTY.md'),
    'This package redistributes the unmodified official Caddy binary and LICENSE from https://github.com/caddyserver/caddy.\n',
  )
  writeFileSync(join(directory, 'caddy'), readFileSync(join(runtime, 'caddy')), { mode: 0o755 })
  chmodSync(join(directory, 'caddy'), 0o755)
  return { name, version: CADDY_PACKAGE_VERSION, directory, binarySha256: receipt.binarySha256 }
}

const platforms = platform === 'all' ? ['linux-x64', 'linux-arm64'] : [platform]
const packed = []
try {
  for (const selected of platforms) packed.push(await packPlatform(output, selected))
  process.stdout.write(`${JSON.stringify({ caddy: 'v2.11.4', packages: packed }, undefined, 2)}\n`)
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
