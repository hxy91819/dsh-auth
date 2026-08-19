/**
 * Drive the complete managed lifecycle of the packed artifact against real
 * DSH, systemd, and the bundled Caddy edge: official plugin pre-install,
 * dormant boot, trusted setup adoption, authentication, managed upgrade,
 * drift fail-closed and recovery, downgrade refusal, uninstall back to
 * dormancy, and a self-installed second lifecycle. The script owns every
 * generated profile, npm prefix, secret, unit, process, and port.
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { accessSync, chmodSync, constants, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'

const checkout = resolve(import.meta.dirname, '..')
const HELP = `Usage:
  node scripts/lifecycle-e2e.mjs

Description:
  Build three release candidates (0.2.0 base plus two bumped builds), then
  prove the full installation lifecycle on real DSH, systemd, and the bundled
  Caddy edge. Requires root, systemd, npm, and the local dsh dependency.

Environment:
  LIFECYCLE_KEEP_ON_FAILURE  Set to any value to keep the disposable root
                             for inspection when the run fails.
  LIFECYCLE_TARBALL_BASE     Optional prebuilt base tarball (0.2.0) used
                             instead of packing in-process.
  LIFECYCLE_TARBALL_UPGRADE  Optional prebuilt first upgrade tarball (0.2.1).
  LIFECYCLE_TARBALL_RECOVER  Optional prebuilt second upgrade tarball (0.2.2).

Outputs:
  One JSON summary on stdout and exit 0 on success. All units, prefixes,
  profiles, and files under the disposable root are removed.
`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function executable(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`)
  try {
    accessSync(path, constants.X_OK)
  } catch {
    throw new Error(`${label} is not executable: ${path}`)
  }
  return path
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}${result.stderr}`)
  return result.stdout
}

function allowFailure(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

async function availablePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  server.close()
  await once(server, 'close')
  return port
}

/** /tmp is world-writable and rejected by root-service path checks, so the disposable root lives under /root. */
const root = mkdtempSync('/root/dsh-auth-lifecycle-')
const nodeBinary = process.execPath
const dshBinDirectory = join(checkout, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
const dshCli = executable(join(checkout, 'node_modules', '.bin', 'dsh'), 'dsh')
const dshWrapper = join(root, 'bin', 'dsh')
mkdirSync(join(root, 'bin'), { mode: 0o755, recursive: true })
// DSH 0.1.0-rc.7 mounts its HMR service, which requires node internals to be
// exposed; the disposable unit owns this launch flag.
writeFileSync(dshWrapper, `#!/bin/sh\nexec ${nodeBinary} --expose-internals ${join(dshBinDirectory, 'bin.js')} "$@"\n`, { mode: 0o755 })
chmodSync(dshWrapper, 0o755)
const globalPrefix = join(root, 'global')
const summary = {}
let currentUnit

function cleanupUnit() {
  if (currentUnit === undefined) return
  for (const args of [['disable', '--now', currentUnit], ['reset-failed', currentUnit]]) {
    allowFailure('/usr/bin/systemctl', args)
  }
  for (const unitFile of [`/etc/systemd/system/${currentUnit}`, `/etc/systemd/system/${currentUnit}.d`]) {
    try {
      rmSync(unitFile, { recursive: true, force: true })
    } catch { /* best-effort cleanup */ }
  }
  allowFailure('/usr/bin/systemctl', ['daemon-reload'])
  currentUnit = undefined
}

function packVersion(version) {
  if (version === undefined) {
    checked('corepack', ['pnpm', 'pack', '--pack-destination', join(root, 'artifacts')], { cwd: checkout })
    const manifest = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'))
    return join(root, 'artifacts', `${manifest.name}-${manifest.version}.tgz`)
  }
  const manifestPath = join(checkout, 'package.json')
  const original = readFileSync(manifestPath, 'utf8')
  const bumped = JSON.parse(original)
  bumped.version = version
  try {
    writeFileSync(manifestPath, `${JSON.stringify(bumped, null, 2)}\n`)
    checked('corepack', ['pnpm', 'pack', '--pack-destination', join(root, 'artifacts')], { cwd: checkout })
  } finally {
    writeFileSync(manifestPath, original)
  }
  return join(root, 'artifacts', `dsh-auth-${version}.tgz`)
}

function prebuiltOrPack(environmentVariable, version) {
  const supplied = process.env[environmentVariable]
  if (supplied !== undefined) {
    const resolved = resolve(supplied)
    if (!resolved.endsWith('.tgz') || !statSync(resolved).isFile()) throw new Error(`${environmentVariable} must resolve to a package tarball file`)
    return resolved
  }
  return packVersion(version)
}

function installGlobalCli(tarball) {
  checked('npm', ['install', '--global', '--offline', '--prefix', globalPrefix, tarball], { cwd: root })
  return executable(join(globalPrefix, 'bin', 'dsh-auth'), 'global dsh-auth CLI')
}

async function createService(home, port) {
  const unit = `dsh-auth-lifecycle-${randomBytes(4).toString('hex')}-web.service`
  const serviceDirectory = join(home, 'service')
  mkdirSync(serviceDirectory, { mode: 0o755 })
  writeFileSync(`/etc/systemd/system/${unit}`, [
    '[Unit]',
    'Description=disposable dsh-auth lifecycle web service',
    '[Service]',
    'Type=simple',
    'User=root',
    'WorkingDirectory=/root',
    `Environment=DSH_HOME=${home}`,
    `ExecStart=${dshWrapper} web --port ${String(port)}`,
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n'), { mode: 0o644 })
  currentUnit = unit
  checked('/usr/bin/systemctl', ['daemon-reload'])
  return unit
}

async function waitWeb(port, label) {
  const deadline = Date.now() + 45_000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/`)
      if (response.status === 200) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 250))
  }
  throw new Error(`${label} did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function dormantAssertions(port, label) {
  await waitWeb(port, `${label} dormant boot`)
  const index = await (await fetch(`http://127.0.0.1:${String(port)}/`)).text()
  assert(!index.includes('"id":"dsh-auth"'), `${label}: dormant bundle entered the client roster`)
  const login = await fetch(`http://127.0.0.1:${String(port)}/auth/login`)
  const loginHtml = await login.text()
  assert(loginHtml.includes('window.__DSH_BOOT__') && !loginHtml.includes('name="password"'), `${label}: dormant bundle exposed an authentication route`)
}

async function login(edgePort, username, password) {
  const page = await fetch(`http://127.0.0.1:${String(edgePort)}/auth/login?returnTo=%2F`)
  const html = await page.text()
  const csrfCookie = (page.headers.getSetCookie?.() ?? []).find(field => field.startsWith('dsh_auth_csrf='))?.split(';')[0]
  const csrf = /<input type="hidden" name="csrf" value="([^"]*)">/u.exec(html)?.[1]
  assert(csrf !== undefined && csrfCookie !== undefined, 'login page did not provide a CSRF form')
  const response = await fetch(`http://127.0.0.1:${String(edgePort)}/auth/login`, {
    method: 'POST',
    headers: {
      origin: `http://127.0.0.1:${String(edgePort)}`,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: csrfCookie,
    },
    body: new URLSearchParams({ csrf, returnTo: '/', username, password }).toString(),
    redirect: 'manual',
  })
  assert(response.status === 303, `login did not succeed (${String(response.status)})`)
  return (response.headers.getSetCookie?.() ?? []).find(field => field.startsWith('dsh_auth_session='))?.split(';')[0]
}

function readState() {
  return JSON.parse(readFileSync('/etc/dsh-auth/install-state.json', 'utf8'))
}

function cli(command, args) {
  return allowFailure(join(globalPrefix, 'bin', 'dsh-auth'), [command, '--json', ...args], { cwd: root })
}

async function main() {
  mkdirSync(join(root, 'artifacts'), { recursive: true })
  const tarballA = prebuiltOrPack('LIFECYCLE_TARBALL_BASE')
  const tarballB = prebuiltOrPack('LIFECYCLE_TARBALL_UPGRADE', '0.2.1')
  const tarballC = prebuiltOrPack('LIFECYCLE_TARBALL_RECOVER', '0.2.2')
  summary.candidates = {
    base: `${readFileSync(tarballA).length}b`,
    upgraded: `${readFileSync(tarballB).length}b`,
    recovered: `${readFileSync(tarballC).length}b`,
  }
  installGlobalCli(tarballA)

  // A previous interrupted run on this machine may have left a managed
  // installation or edge unit behind; retire them before the lifecycle starts.
  allowFailure(join(globalPrefix, 'bin', 'dsh-auth'), ['uninstall', '--non-interactive', '--authorize-uninstall'])
  allowFailure('/usr/bin/systemctl', ['disable', '--now', 'dsh-auth-caddy.service'])
  for (const leftover of ['/etc/dsh-auth', '/etc/dsh-auth.installing.json', '/usr/lib/dsh-auth', '/etc/systemd/system/dsh-auth-caddy.service', '/var/lib/dsh-auth']) {
    try {
      rmSync(leftover, { recursive: true, force: true })
    } catch { /* best-effort cleanup */ }
  }
  allowFailure('/usr/bin/systemctl', ['daemon-reload'])

  const password = `Lifecycle-${randomBytes(12).toString('base64url')}`
  const passwordFile = join(root, 'admin-password')
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 })
  chmodSync(passwordFile, 0o600)

  const home = join(root, 'dsh-home')
  mkdirSync(join(home, 'profiles'), { mode: 0o700, recursive: true })
  const webPort = await availablePort()
  const edgePort = await availablePort()
  const unit = await createService(home, webPort)
  summary.unit = unit

  // 1. Official pre-install through dsh plugin: the bundle lands dormant.
  checked(dshCli, ['plugin', '--profile', 'web', 'add', '--offline', '--config.auto-install-peers=false', tarballA], {
    cwd: root, env: { ...process.env, DSH_HOME: home },
  })
  checked('/usr/bin/systemctl', ['start', unit])
  await dormantAssertions(webPort, 'pre-install')

  // 2. Trusted adoption by the same-build global CLI.
  const setup = cli('setup', [
    '--non-interactive', '--dsh-service', unit, '--dsh-executable', dshWrapper, '--mode', 'http', '--listen-address', '127.0.0.1',
    '--http-port', String(edgePort), '--upstream', `127.0.0.1:${String(webPort)}`,
    '--admin-bootstrap', 'password', '--admin-username', 'lifecycle-admin',
    '--login-token', 'disabled', '--password-file', passwordFile,
  ])
  assert(setup.status === 0, `adoption setup failed\n${setup.stdout}${setup.stderr}`)
  const adopted = readState()
  assert(adopted.profilePackageOrigin === 'external', 'setup did not adopt the pre-installed bundle')
  assert(adopted.profilePackageVersion === '0.2.0', 'adopted version was not the CLI build')
  await waitWeb(edgePort, 'adopted edge')
  const session = await login(edgePort, 'lifecycle-admin', password)
  assert(session !== undefined, 'adoption login produced no session cookie')
  assert(cli('doctor', []).status === 0, 'doctor rejected the adopted installation')
  summary.adoption = 'external bundle, no reinstall, doctor healthy'

  // 3. Managed upgrade to the newer CLI build; sessions survive the restart.
  installGlobalCli(tarballB)
  const upgraded = cli('upgrade', ['--non-interactive', '--authorize-upgrade', '--package', tarballB])
  assert(upgraded.status === 0, `upgrade failed\n${upgraded.stdout}${upgraded.stderr}`)
  const upgradedState = readState()
  assert(upgradedState.profilePackageVersion === '0.2.1', 'upgrade did not record the new version')
  const environment = readFileSync('/etc/dsh-auth/dsh-auth.env', 'utf8')
  assert(environment.includes('DSH_AUTH_EXPECTED_VERSION="0.2.1"'), 'environment marker was not rewritten')
  const bundleManifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'node_modules', 'dsh-auth', 'package.json'), 'utf8'))
  assert(bundleManifest.version === '0.2.1', 'profile bundle was not upgraded')
  let sessionView
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      sessionView = await fetch(`http://127.0.0.1:${String(edgePort)}/auth/session`, { headers: { cookie: session } })
      if (sessionView.status !== 502) break
    } catch { /* upstream still restarting */ }
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 250))
  }
  assert(sessionView?.status === 200, 'existing session did not survive the managed upgrade restart')
  assert(cli('doctor', []).status === 0, 'doctor rejected the upgraded installation')
  summary.upgrade = 'bundle+Caddy+record+services at 0.2.1, session preserved'

  // 4. External drift through plain dsh plugin: runtime fails closed, upgrade refuses.
  checked(dshCli, ['plugin', '--profile', 'web', 'add', '--offline', '--config.auto-install-peers=false', tarballA], {
    cwd: root, env: { ...process.env, DSH_HOME: home },
  })
  allowFailure('/usr/bin/systemctl', ['restart', unit])
  // Type=simple restarts return before the main process crashes; fail-closed
  // surfaces asynchronously as a failed unit.
  let failedClosed = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (allowFailure('/usr/bin/systemctl', ['is-failed', '--quiet', unit]).status === 0) {
      failedClosed = true
      break
    }
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 250))
  }
  assert(failedClosed, 'drifted bundle did not fail the service restart closed')
  const driftDoctor = cli('doctor', [])
  assert(driftDoctor.status === 8, `doctor did not refuse drift (${String(driftDoctor.status)})`)
  assert(driftDoctor.stdout.includes('PROFILE_PACKAGE_BUILD_DRIFT'), 'doctor missed the drift diagnostic')
  assert(driftDoctor.stdout.includes(`dsh plugin --profile web add ${upgradedState.profilePackageSpec}`), 'doctor remediation did not reference the recorded spec')
  const driftUpgrade = cli('upgrade', ['--non-interactive', '--authorize-upgrade'])
  assert(driftUpgrade.status === 8, `upgrade did not refuse drift (${String(driftUpgrade.status)})`)
  summary.drift = 'restart fails closed, doctor exit 8 with recorded-spec recovery, upgrade refused'

  // 5. Restore per the fixed recovery order, then re-upgrade to a newer build.
  checked(dshCli, ['plugin', '--profile', 'web', 'add', '--offline', '--config.auto-install-peers=false', tarballB], {
    cwd: root, env: { ...process.env, DSH_HOME: home },
  })
  checked('/usr/bin/systemctl', ['start', unit])
  await waitWeb(webPort, 'restored web')
  const restoredDoctor = cli('doctor', [])
  assert(restoredDoctor.status === 0, `doctor did not return to healthy after the recorded restore\n${restoredDoctor.stdout}${restoredDoctor.stderr}`)
  await waitWeb(edgePort, 'restored edge')
  installGlobalCli(tarballC)
  const recovered = cli('upgrade', ['--non-interactive', '--authorize-upgrade', '--package', tarballC])
  assert(recovered.status === 0, `re-covered upgrade failed\n${recovered.stdout}${recovered.stderr}`)
  assert(readState().profilePackageVersion === '0.2.2', 'recovery upgrade did not reach the newer build')
  summary.recovery = 'restore recorded build, doctor healthy, upgrade to 0.2.2'

  // 6. Downgrade refusal with an older CLI.
  installGlobalCli(tarballB)
  const downgrade = cli('upgrade', ['--non-interactive', '--authorize-upgrade'])
  assert(downgrade.status === 4 && downgrade.stdout.includes('UPGRADE_VERSION_NOT_HIGHER'), 'downgrade was not refused')
  installGlobalCli(tarballC)
  summary.downgradeRefusal = 'exit 4'

  // 7. Uninstall keeps the externally owned bundle and returns it to dormancy.
  const uninstall = cli('uninstall', ['--non-interactive', '--authorize-uninstall'])
  assert(uninstall.status === 0, `uninstall failed\n${uninstall.stdout}${uninstall.stderr}`)
  assert(statSync(join(home, 'profiles', 'web', 'node_modules', 'dsh-auth', 'package.json')).isFile(), 'uninstall removed the external bundle')
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
  assert(manifest.dependencies?.['dsh-auth'] !== undefined, 'uninstall dropped the profile bundle declaration')
  assert(!statSync('/etc/dsh-auth/install-state.json', { throwIfNoEntry: false })?.isFile(), 'uninstall left the ownership record')
  checked('/usr/bin/systemctl', ['restart', unit])
  await dormantAssertions(webPort, 'post-uninstall')
  summary.uninstall = 'external bundle preserved, dormant again'

  // 8. Self-installed lifecycle on a fresh service: uninstall removes the owned bundle.
  cleanupUnit()
  const selfHome = join(root, 'dsh-self-home')
  mkdirSync(join(selfHome, 'profiles'), { mode: 0o700, recursive: true })
  const selfPort = await availablePort()
  const selfEdge = await availablePort()
  const selfUnit = await createService(selfHome, selfPort)
  const selfSetup = cli('setup', [
    '--non-interactive', '--dsh-service', selfUnit, '--dsh-executable', dshWrapper, '--mode', 'http', '--listen-address', '127.0.0.1',
    '--http-port', String(selfEdge), '--upstream', `127.0.0.1:${String(selfPort)}`,
    '--admin-bootstrap', 'password', '--admin-username', 'self-admin',
    '--login-token', 'disabled', '--password-file', passwordFile, '--package', tarballC,
  ])
  assert(selfSetup.status === 0, `self-install setup failed\n${selfSetup.stdout}${selfSetup.stderr}`)
  const selfState = readState()
  assert(selfState.profilePackageOrigin === 'dsh-auth', 'self-install did not record dsh-auth ownership')
  await waitWeb(selfEdge, 'self-installed edge')
  const selfSession = await login(selfEdge, 'self-admin', password)
  assert(selfSession !== undefined, 'self-install login failed')
  assert(cli('doctor', []).status === 0, 'doctor rejected the self-installed lifecycle')
  const selfUninstall = cli('uninstall', ['--non-interactive', '--authorize-uninstall'])
  assert(selfUninstall.status === 0, `self uninstall failed\n${selfUninstall.stdout}${selfUninstall.stderr}`)
  assert(!statSync(join(selfHome, 'profiles', 'web', 'node_modules', 'dsh-auth'), { throwIfNoEntry: false })?.isFile?.(), 'self uninstall kept the owned bundle')
  checked('/usr/bin/systemctl', ['restart', selfUnit])
  await dormantAssertions(selfPort, 'self post-uninstall')
  summary.selfInstall = 'setup installs and owns the bundle, uninstall removes it'
  summary.harness = checked(dshCli, ['--version']).trim()

  process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`)
}

try {
  await main()
  process.exitCode = 0
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
} finally {
  if (process.exitCode === 0 || process.env.LIFECYCLE_KEEP_ON_FAILURE === undefined) {
    cleanupUnit()
    rmSync(root, { recursive: true, force: true })
  } else {
    process.stderr.write(`disposable root and units kept for inspection: ${root} (${currentUnit ?? 'no unit'})\n`)
  }
}
