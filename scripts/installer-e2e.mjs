/**
 * End-to-end test the packed interactive and non-interactive setup interfaces.
 * Input is one local .tgz path. The script installs it offline in a temporary
 * directory, runs its real npm bin, verifies outputs, and removes all fixtures.
 */
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const HELP = `Usage:
  node scripts/installer-e2e.mjs PATH.tgz

Description:
  Install a local dsh-auth tarball with npm --offline, then exercise both the
  real non-interactive JSON CLI and the real interactive CLI through a PTY.

Arguments:
  PATH.tgz  Required absolute or cwd-relative npm tarball path.

Output:
  Prints one success summary. Missing prompts, leaked secrets, invalid files,
  or subprocess failures exit nonzero. Temporary files are always removed.

Examples:
  node scripts/installer-e2e.mjs packed/dsh-auth-0.1.12.tgz
  node scripts/installer-e2e.mjs /tmp/artifacts/dsh-auth-0.1.12.tgz
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
const scriptExecutable = '/usr/bin/script'
const root = mkdtempSync(join(tmpdir(), 'dsh-auth-installer-e2e-'))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with status ${String(result.status)}; output withheld`)
  return result
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function verifyOutput(output, expectedUsername, password) {
  const state = JSON.parse(readFileSync(join(output, 'install-state.json'), 'utf8'))
  if (state.status !== 'installed') throw new Error('installer ownership record is not installed')
  const environment = readFileSync(join(output, 'dsh-auth.env'), 'utf8')
  const passwordHash = readFileSync(join(output, 'password-hash'), 'utf8')
  const sessionSecret = readFileSync(join(output, 'session-secret'), 'utf8').trim()
  if (!environment.includes(`DSH_AUTH_USERNAME="${expectedUsername}"`)) throw new Error('installer environment has the wrong username')
  if (!passwordHash.startsWith('$argon2id$')) throw new Error('installer password hash is invalid')
  if (`${environment}${passwordHash}${sessionSecret}`.includes(password)) throw new Error('installer persisted the plaintext password')
  if ((statSync(join(output, 'password-hash')).mode & 0o777) !== 0o600) throw new Error('installer password hash mode is not 0600')
  if ((statSync(join(output, 'session-secret')).mode & 0o777) !== 0o600) throw new Error('installer session secret mode is not 0600')
  return sessionSecret
}

function runInteractive(bin, output, password) {
  const command = [bin, 'setup', '--output-dir', output, '--nginx', 'skip', '--package', tarball].map(shellQuote).join(' ')
  const child = spawn(scriptExecutable, ['-qefc', command, '/dev/null'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  const steps = [
    ['Stable user id [admin]:', 'admin-e2e\n'],
    ['Login username [admin]:', 'operator-e2e\n'],
    ['Edge mode (https/http) [https]:', 'http\n'],
    ['Trusted-network HTTP listen address:', '127.0.0.1\n'],
    ['Type install to apply this exact plan:', 'install\n'],
    ['Password:', `${password}\n`],
    ['Confirm password:', `${password}\n`],
  ]
  return new Promise((resolvePromise, rejectPromise) => {
    let transcript = ''
    let step = 0
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error === undefined) resolvePromise(transcript)
      else rejectPromise(error)
    }
    const consume = (chunk) => {
      transcript += chunk.toString('utf8')
      if (transcript.includes(password)) {
        child.kill()
        finish(new Error('interactive installer echoed the password'))
        return
      }
      const current = steps[step]
      if (current !== undefined && transcript.includes(current[0])) {
        child.stdin.write(current[1])
        step += 1
      }
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.on('error', error => finish(error))
    child.on('close', (code) => {
      if (code !== 0) finish(new Error(`interactive installer exited with status ${String(code)}; output withheld`))
      else if (step !== steps.length) finish(new Error(`interactive installer exited before prompt ${String(step + 1)}`))
      else if (!transcript.includes('dsh-auth setup completed successfully.')) finish(new Error('interactive installer did not report success'))
      else finish()
    })
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error(`interactive installer timed out before prompt ${String(step + 1)}`))
    }, 20_000)
  })
}

try {
  if (!isAbsolute(scriptExecutable)) throw new Error('PTY driver path must be absolute')
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball])
  const bin = join(root, 'node_modules', '.bin', 'dsh-auth')

  const nonInteractivePassword = randomBytes(24).toString('base64url')
  const nonInteractiveOutput = join(root, 'non-interactive')
  const nonInteractive = run(bin, [
    'setup', '--non-interactive', '--json', '--nginx', 'skip', '--output-dir', nonInteractiveOutput,
    '--package', tarball, '--user-id', 'admin-e2e', '--username', 'operator-e2e', '--password-stdin',
    '--mode', 'http', '--listen-address', '127.0.0.1',
  ], { input: nonInteractivePassword })
  const result = JSON.parse(nonInteractive.stdout)
  if (result.status !== 'success' || result.exitCode !== 0) throw new Error('non-interactive installer JSON reported failure')
  if (`${nonInteractive.stdout}${nonInteractive.stderr}`.includes(nonInteractivePassword)) throw new Error('non-interactive installer leaked the password')
  const nonInteractiveSecret = verifyOutput(nonInteractiveOutput, 'operator-e2e', nonInteractivePassword)
  if (`${nonInteractive.stdout}${nonInteractive.stderr}`.includes(nonInteractiveSecret)) throw new Error('non-interactive installer leaked the session secret')

  const interactivePassword = randomBytes(24).toString('base64url')
  const interactiveOutput = join(root, 'interactive')
  const transcript = await runInteractive(bin, interactiveOutput, interactivePassword)
  const interactiveSecret = verifyOutput(interactiveOutput, 'operator-e2e', interactivePassword)
  if (transcript.includes(interactiveSecret)) throw new Error('interactive installer leaked the session secret')

  process.stdout.write('Packed interactive and non-interactive installer end-to-end tests passed.\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
