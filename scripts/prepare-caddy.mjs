/**
 * Prepare an official fixed-version Caddy binary for isolated tests only.
 * Production setup copies the Caddy binary bundled in the published tarball.
 */
import { prepareCaddyRelease, currentCaddyPlatform } from './caddy-release.mjs'

const HELP = `Usage:
  node scripts/prepare-caddy.mjs --output ABSOLUTE_DIRECTORY [--platform PLATFORM]

Description:
  Download the fixed official Caddy test archive, verify the recorded upstream
  SHA-512 plus extracted binary/license SHA-256, and create an isolated runtime.
  This command is a test preparer; production installation must not call it.

Options:
  --output PATH       Required new or empty absolute output directory.
  --platform VALUE    linux-x64 or linux-arm64 (default: current platform).
  -h, --help          Show this help.

Outputs:
  Writes caddy, LICENSE, and receipt.json below PATH. Prints the receipt JSON to
  stdout. Diagnostics and failures go to stderr. Exit 0 means every checksum and
  the executable version matched; exit 2 means invalid arguments.

Examples:
  node scripts/prepare-caddy.mjs --output /tmp/dsh-auth-caddy
  node scripts/prepare-caddy.mjs --output /tmp/dsh-auth-caddy-arm64 --platform linux-arm64
`

const args = process.argv.slice(2).filter(argument => argument !== '--')
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}

let output
let platform
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

try {
  const receipt = await prepareCaddyRelease(output, platform ?? currentCaddyPlatform())
  process.stdout.write(`${JSON.stringify(receipt, undefined, 2)}\n`)
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
