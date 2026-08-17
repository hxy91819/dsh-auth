/**
 * Install one local npm tarball without network and exercise its published bin.
 * Input is one absolute or cwd-relative .tgz path. Success prints one summary;
 * validation or subprocess failures exit nonzero without printing credentials.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const HELP = `Usage:
  node scripts/pack-smoke.mjs PATH.tgz

Description:
  Install a local dsh-auth tarball with npm --offline, execute its published
  CLI, and verify secret-safe output-mode files and permissions.

Arguments:
  PATH.tgz  Required absolute or cwd-relative npm tarball path.

Output:
  Prints one success summary. Validation and subprocess failures exit nonzero.

Examples:
  node scripts/pack-smoke.mjs packed/dsh-auth-0.1.13.tgz
  node scripts/pack-smoke.mjs /tmp/artifacts/dsh-auth-0.1.13.tgz
`

const input = process.argv[2]
if (input === '--help' || input === '-h') {
  process.stdout.write(HELP)
  process.exit(0)
}
if (input === undefined || process.argv.length !== 3) {
  process.stderr.write(HELP)
  process.exit(2)
}
const tarball = resolve(input)
if (!isAbsolute(tarball) || !tarball.endsWith('.tgz')) throw new Error('tarball must resolve to an absolute .tgz path')
const root = mkdtempSync(join(tmpdir(), 'dsh-auth-pack-smoke-'))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with status ${String(result.status)}\n${result.stdout}${result.stderr}`)
  return result
}

try {
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball])
  const bin = join(root, 'node_modules', '.bin', 'dsh-auth')
  const help = run(bin, ['--help'])
  if (!help.stdout.includes('dsh-auth setup') || !help.stdout.includes('dsh-auth reset-password')) throw new Error('packed bin help is missing a public command')

  const password = 'pack-smoke-password-not-for-output'
  const output = join(root, 'rendered')
  const setup = run(bin, [
    'setup', '--non-interactive', '--json', '--nginx', 'skip', '--output-dir', output,
    '--package', tarball, '--user-id', 'admin', '--username', 'admin', '--password-stdin',
    '--mode', 'http', '--listen-address', '127.0.0.1',
  ], { input: password })
  const result = JSON.parse(setup.stdout)
  if (result.status !== 'success' || result.exitCode !== 0) throw new Error('packed setup JSON reported failure')
  if (`${setup.stdout}${setup.stderr}`.includes(password)) throw new Error('packed setup leaked the password')
  if (readFileSync(join(output, 'password-hash'), 'utf8').includes(password)) throw new Error('packed setup stored the password')
  if ((statSync(join(output, 'password-hash')).mode & 0o777) !== 0o600) throw new Error('packed password hash mode is not 0600')
  if ((statSync(join(output, 'session-secret')).mode & 0o777) !== 0o600) throw new Error('packed session secret mode is not 0600')
  process.stdout.write('Packed artifact installs offline and its real dsh-auth bin completes a secret-safe setup.\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
