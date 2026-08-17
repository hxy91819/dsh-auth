/** Install one packed artifact without network and exercise its real bin plus output-mode setup. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const input = process.argv[2]
if (input === undefined) {
  process.stderr.write('Usage: node scripts/pack-smoke.mjs /absolute/path/dsh-auth-VERSION.tgz\n')
  process.exit(2)
}
const tarball = resolve(input)
if (!isAbsolute(tarball) || !tarball.endsWith('.tgz')) throw new Error('tarball must be an absolute .tgz path')
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
  if (!help.stdout.includes('dsh-auth setup')) throw new Error('packed bin help did not execute')

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
