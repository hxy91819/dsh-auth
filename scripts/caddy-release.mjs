import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const checkout = resolve(import.meta.dirname, '..')
const manifestPath = join(checkout, 'deploy/caddy/release-manifest.json')

export function caddyReleaseManifest() {
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest('hex')
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout}${result.stderr}`)
  return result.stdout
}

function emptyDirectory(path) {
  if (!isAbsolute(path)) throw new Error('output directory must be absolute')
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('output must be a real directory')
    if (readdirSync(path).length !== 0) throw new Error('output directory must be empty')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    mkdirSync(path, { mode: 0o700, recursive: false })
  }
}

function platformEntry(manifest, platform) {
  const entry = manifest.platforms?.[platform]
  if (entry === undefined) throw new Error(`unsupported Caddy test platform: ${platform}`)
  for (const [key, length] of [['archiveSha512', 128], ['binarySha256', 64]]) {
    if (typeof entry[key] !== 'string' || entry[key].length !== length || !/^[a-f0-9]+$/u.test(entry[key])) {
      throw new Error(`Caddy release manifest has an invalid ${key}`)
    }
  }
  return entry
}

export function currentCaddyPlatform() {
  if (process.platform !== 'linux') throw new Error(`unsupported Caddy test operating system: ${process.platform}`)
  if (process.arch === 'x64') return 'linux-x64'
  if (process.arch === 'arm64') return 'linux-arm64'
  throw new Error(`unsupported Caddy test architecture: ${process.arch}`)
}

export async function prepareCaddyRelease(outputDirectory, platform = currentCaddyPlatform()) {
  emptyDirectory(outputDirectory)
  const manifest = caddyReleaseManifest()
  const entry = platformEntry(manifest, platform)
  const url = `${manifest.releaseBaseUrl}/${entry.archive}`
  const archive = join(outputDirectory, entry.archive)
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`Caddy archive download failed with status ${String(response.status)}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (digest('sha512', bytes) !== entry.archiveSha512) throw new Error('Caddy archive SHA-512 mismatch')
    writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 })
    checked('tar', ['-xzf', archive, '-C', outputDirectory, 'caddy', 'LICENSE'])

    const binary = join(outputDirectory, 'caddy')
    const license = join(outputDirectory, 'LICENSE')
    if (digest('sha256', readFileSync(binary)) !== entry.binarySha256) throw new Error('Caddy binary SHA-256 mismatch')
    if (digest('sha256', readFileSync(license)) !== manifest.licenseSha256) throw new Error('Caddy license SHA-256 mismatch')
    chmodSync(binary, 0o755)
    chmodSync(license, 0o644)
    const version = checked(binary, ['version']).trim().split(/\s+/u)[0]
    if (version !== `v${manifest.caddyVersion}`) throw new Error(`unexpected Caddy version: ${version}`)
    rmSync(archive)
    const receipt = {
      version,
      platform,
      source: url,
      binary,
      binarySha256: entry.binarySha256,
      license,
      licenseSha256: manifest.licenseSha256,
    }
    writeFileSync(join(outputDirectory, 'receipt.json'), `${JSON.stringify(receipt, undefined, 2)}\n`, { mode: 0o600 })
    return receipt
  } catch (error) {
    rmSync(outputDirectory, { recursive: true, force: true })
    throw error
  }
}
