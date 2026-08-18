/**
 * Resolve the npm latest DeepSeek Harness, require it to equal the repository
 * pin, install it in a disposable prefix, and run the canonical real E2E.
 * Diagnostics go to stderr so stdout remains the E2E JSON document.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const checkout = resolve(import.meta.dirname, '..')
const HELP = `Usage:
  corepack pnpm run test:e2e:latest-dsh
  node scripts/latest-harness-e2e.mjs [PATH.tgz]

Description:
  Resolve @deepseek-ai/dsh from npm's latest dist-tag, fail if it differs from
  the exact repository pin, install that version in a disposable npm prefix,
  and run the canonical real authentication E2E with the isolated DSH binary.

Arguments:
  PATH.tgz  Optional local dsh-auth package artifact forwarded to the E2E.

Outputs:
  Writes only the canonical E2E JSON document to stdout. Version and install
  diagnostics go to stderr. Exit 0 means latest equals the pin and E2E passed;
  exit 2 means invalid arguments; other nonzero exits mean validation failed.

Examples:
  corepack pnpm run test:e2e:latest-dsh
  node scripts/latest-harness-e2e.mjs release/dsh-auth-0.1.13.tgz
`

const args = process.argv.slice(2).filter(argument => argument !== '--')
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (args.length > 1 || args.some(argument => argument.startsWith('-'))) {
  process.stderr.write(HELP)
  process.exit(2)
}

function checked(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${String(result.status)}\n${result.stdout}${result.stderr}`)
  }
  return result.stdout
}

function singleVersion(raw, label) {
  const parsed = JSON.parse(raw)
  const values = Array.isArray(parsed) ? [...new Set(parsed)] : [parsed]
  if (values.length !== 1 || typeof values[0] !== 'string' || values[0].length === 0) {
    throw new Error(`${label} did not resolve to exactly one version`)
  }
  return values[0]
}

const manifest = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'))
const pinnedVersion = manifest.devDependencies?.['@deepseek-ai/dsh']
if (typeof pinnedVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(pinnedVersion)) {
  throw new Error('package.json must pin @deepseek-ai/dsh to one exact version')
}

const latestVersion = singleVersion(
  checked('npm', ['view', '@deepseek-ai/dsh', 'dist-tags.latest', '--json'], { cwd: checkout }),
  'npm latest dist-tag',
)
if (latestVersion !== pinnedVersion) {
  throw new Error(
    `latest Harness ${latestVersion} differs from repository pin ${pinnedVersion}; refresh and verify the baseline first`,
  )
}

const isolatedPrefix = mkdtempSync(join(tmpdir(), 'dsh-auth-latest-harness-'))
try {
  process.stderr.write(`Using npm latest @deepseek-ai/dsh ${latestVersion} (repository pin matches)\n`)
  const installOutput = checked('npm', [
    'install', '--prefix', isolatedPrefix, '--no-audit', '--no-fund', '--save=false',
    `@deepseek-ai/dsh@${latestVersion}`,
  ], { cwd: checkout })
  process.stderr.write(installOutput)

  const e2e = spawnSync(process.execPath, [join(checkout, 'scripts/real-integration.mjs'), ...args], {
    cwd: checkout,
    env: {
      ...process.env,
      DSH_E2E_DSH_BIN: join(isolatedPrefix, 'node_modules', '.bin', 'dsh'),
    },
    stdio: 'inherit',
  })
  if (e2e.error !== undefined) throw e2e.error
  if (e2e.status !== 0) process.exitCode = e2e.status ?? 1
} finally {
  rmSync(isolatedPrefix, { recursive: true, force: true })
}
