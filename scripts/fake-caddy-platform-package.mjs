/**
 * Write a local Caddy platform package that satisfies installer checksum checks.
 * Used only by packed-artifact smoke tests; production setup never generates binaries.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CADDY_VERSION = '2.11.4'
const CADDY_PACKAGE_VERSION = '2.11.4-dsh.1'

export function writeFakeCaddyPlatformPackage(directory, platform = 'linux-x64') {
  const name = `dsh-auth-caddy-${platform}`
  const binary = Buffer.from(`fake-caddy-${platform}`)
  const binarySha256 = createHash('sha256').update(binary).digest('hex')
  const manifest = `${JSON.stringify({
    schemaVersion: 1,
    caddyVersion: CADDY_VERSION,
    packageRevision: 'dsh.1',
    platform,
    executable: 'caddy',
    upstreamArchive: `caddy_${CADDY_VERSION}_${platform.replace('linux-', 'linux_')}.tar.gz`,
    binarySha256,
  })}\n`
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name, version: CADDY_PACKAGE_VERSION })}\n`)
  writeFileSync(join(directory, 'manifest.json'), manifest)
  writeFileSync(join(directory, 'manifest.sha256'), `${createHash('sha256').update(manifest).digest('hex')}\n`)
  writeFileSync(join(directory, 'LICENSE'), 'Caddy license placeholder\n')
  writeFileSync(join(directory, 'THIRD_PARTY.md'), 'Third-party notices\n')
  writeFileSync(join(directory, 'caddy'), binary, { mode: 0o755 })
  return { name, directory, binarySha256 }
}
