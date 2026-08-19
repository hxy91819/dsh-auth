/**
 * Run the real Harness/Chrome E2E against the fixed Caddy manual and local automatic TLS modes.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { caddyReleaseManifest, currentCaddyPlatform, prepareCaddyRelease } from './caddy-release.mjs'

const HELP = `Usage:
  node scripts/caddy-e2e.mjs [--caddy ABSOLUTE_PATH] [PATH.tgz]

Description:
  Run the repository's real Harness and Chrome integration suite twice against
  Caddy v2.11.4: once with a manual certificate and once with Caddy's isolated
  internal CA. Without --caddy, download and verify the pinned official binary.

Arguments:
  PATH.tgz      Optional package artifact forwarded to real-integration.mjs.

Options:
  --caddy PATH  Use an existing absolute Caddy executable with the pinned hash.
  -h, --help    Show this help.

Outputs:
  Streams each E2E JSON result to stdout, followed by a TLS mode summary.
  Exit 0 means both modes passed and temporary Caddy state was removed.
  Invalid arguments exit 2; integrity or E2E failures exit nonzero.

Examples:
  node scripts/caddy-e2e.mjs
  node scripts/caddy-e2e.mjs --caddy /opt/dsh-auth/caddy packed/dsh-auth-0.1.15.tgz
`

function parseArguments() {
  const args = process.argv.slice(2).filter(argument => argument !== '--')
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  let caddy
  let tarball
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--caddy') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-') || caddy !== undefined) {
        process.stderr.write(HELP)
        process.exit(2)
      }
      caddy = value
      index += 1
      continue
    }
    if (argument.startsWith('-') || tarball !== undefined) {
      process.stderr.write(HELP)
      process.exit(2)
    }
    tarball = argument
  }
  if (caddy !== undefined) {
    if (!isAbsolute(caddy)) throw new Error('--caddy must be an absolute path')
    accessSync(caddy, constants.X_OK)
  }
  if (tarball !== undefined) {
    tarball = resolve(tarball)
    if (!tarball.endsWith('.tgz') || !statSync(tarball).isFile()) throw new Error('PATH.tgz must be a package tarball')
  }
  return { caddy, tarball }
}

function runE2e(caddy, tls, tarball) {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'real-integration.mjs'), ...tarball === undefined ? [] : [tarball]], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DSH_E2E_CADDY_BIN: caddy,
      DSH_E2E_CADDY_TLS: tls,
      DSH_E2E_BOOTSTRAP: 'password',
    },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`Caddy ${tls} TLS E2E failed with exit ${String(result.status)}`)
}

function verifyCaddy(caddy) {
  const manifest = caddyReleaseManifest()
  const expected = manifest.platforms[currentCaddyPlatform()].binarySha256
  const actual = createHash('sha256').update(readFileSync(caddy)).digest('hex')
  if (actual !== expected) throw new Error('Caddy binary SHA-256 mismatch')
}

const options = parseArguments()
const root = mkdtempSync(join(tmpdir(), 'dsh-auth-caddy-e2e-'))
try {
  const caddy = options.caddy ?? (await prepareCaddyRelease(join(root, 'runtime'))).binary
  verifyCaddy(caddy)
  for (const tls of ['manual', 'internal']) runE2e(caddy, tls, options.tarball)
  process.stdout.write(`${JSON.stringify({ caddy: 'v2.11.4', tlsModes: ['manual', 'internal'], cleanup: true })}\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
