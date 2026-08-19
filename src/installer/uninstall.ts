import { dirname, join } from 'node:path'
import { DEFAULT_STATE_FILE } from './doctor.js'
import { InstallerError } from './errors.js'
import { readInstallState, validateStatePaths } from './plan.js'
import { offlinePluginAddFlags } from './profile-package.js'
import { ExitCode, type CommandSpec, type InstallationPlan, type InstallerHost, type InstallState } from './types.js'

function systemctl(host: InstallerHost): string {
  const executable = ['/usr/bin/systemctl', '/bin/systemctl'].find(candidate => host.regularFile(candidate))
  if (executable === undefined) throw new InstallerError('systemctl is unavailable', ExitCode.prerequisite)
  return executable
}

function runChecked(host: InstallerHost, command: CommandSpec, code: string, env?: NodeJS.ProcessEnv): void {
  const result = host.run(command, env === undefined ? undefined : { env })
  if (result.status !== 0 || result.error !== undefined) {
    throw new InstallerError(code, ExitCode.execution, [{ code, severity: 'error', message: `${command.executable} failed; output was withheld.` }])
  }
}

function dshEnvironment(state: InstallState): NodeJS.ProcessEnv {
  return {
    DSH_HOME: state.dshHome,
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  }
}

function profileCommand(host: InstallerHost, state: InstallState, verb: 'add' | 'remove'): CommandSpec {
  const source = verb === 'add' ? state.request.packageSource : 'dsh-auth'
  const args = ['plugin', '--profile', state.request.profile, verb]
  if (verb === 'add') args.push(...offlinePluginAddFlags(source))
  args.push(source)
  if (state.dshUser === 'root') return { executable: state.dshExecutable, args }
  const runuser = ['/usr/sbin/runuser', '/usr/bin/runuser'].find(candidate => host.regularFile(candidate))
  if (runuser === undefined) throw new InstallerError('runuser is required for uninstall rollback', ExitCode.prerequisite)
  return { executable: runuser, args: ['--user', state.dshUser, '--', state.dshExecutable, ...args] }
}

/** Build a secret-free uninstall plan from the ownership record. */
export function prepareUninstall(host: InstallerHost, stateFile = DEFAULT_STATE_FILE): { readonly plan: InstallationPlan; readonly state?: InstallState } {
  const state = readInstallState(host, stateFile)
  if (state === undefined) {
    return { plan: { schemaVersion: 2, operation: 'uninstall', mode: 'system', status: 'unchanged', actions: [], diagnostics: [{ code: 'INSTALLATION_NOT_FOUND', severity: 'info', message: 'No managed installation exists.' }] } }
  }
  validateStatePaths(state)
  if (state.request.outputDirectory !== undefined) throw new InstallerError('system uninstall refuses an output-mode ownership record', ExitCode.conflict)
  const actions = [
    { id: 'stop-caddy', kind: 'run-command' as const, description: 'Stop and disable the owned dsh-auth-caddy.service.', command: { executable: '/usr/bin/systemctl', args: ['disable', '--now', 'dsh-auth-caddy.service'] } },
    ...(state.profilePackageInstalledByDshAuth ? [{ id: 'remove-profile-package', kind: 'install-package' as const, description: 'Remove only the profile package installed by this setup.' }] : []),
    { id: 'remove-drop-in', kind: 'remove-file' as const, description: 'Remove the recorded project-owned systemd drop-in.', target: state.paths.systemdDropInFile },
    { id: 'remove-owned-files', kind: 'remove-file' as const, description: 'Remove the remaining files listed in the ownership record.' },
  ]
  const diagnostics = state.profilePackageOrigin === 'external'
    ? [{ code: 'PROFILE_PACKAGE_EXTERNAL', severity: 'info' as const, message: 'The externally pre-installed dsh-auth bundle is preserved; without managed configuration it stays dormant.' }]
    : []
  return {
    plan: {
      schemaVersion: 2,
      operation: 'uninstall',
      mode: 'system',
      status: 'ready',
      actions,
      diagnostics,
    },
    state,
  }
}

interface StagedPath {
  readonly original: string
  readonly staged: string
}

function removalRoots(paths: readonly string[]): readonly string[] {
  const owned = new Set(paths)
  return paths.filter(path => {
    let parent = dirname(path)
    while (parent !== dirname(parent)) {
      if (owned.has(parent)) return false
      parent = dirname(parent)
    }
    return true
  })
}

function stageRemoval(host: InstallerHost, paths: readonly string[]): StagedPath[] {
  const staged: StagedPath[] = []
  try {
    for (const original of removalRoots(paths)) {
      if (!host.fileExists(original)) continue
      let target: string
      do target = join(dirname(original), `.dsh-auth-uninstall-${host.randomBytes(16).toString('hex')}`)
      while (host.fileExists(target))
      host.renameFile(original, target)
      staged.push({ original, staged: target })
    }
    return staged
  } catch (error) {
    restoreStaged(host, staged)
    throw error
  }
}

function restoreStaged(host: InstallerHost, paths: readonly StagedPath[]): void {
  for (const path of [...paths].reverse()) {
    if (host.fileExists(path.staged)) host.renameFile(path.staged, path.original)
  }
}

function removeTree(host: InstallerHost, path: string): void {
  if (!host.stat(path).isDirectory) {
    host.removeFile(path)
    return
  }
  for (const entry of host.listDirectory(path)) removeTree(host, join(path, entry))
  host.removeDirectory(path)
  if (host.fileExists(path)) throw new Error(`managed directory could not be removed: ${path}`)
}

function restoreServiceState(host: InstallerHost, systemctlPath: string, paths: readonly StagedPath[], state: InstallState, profileAttempted: boolean, caddyAttempted: boolean): void {
  try {
    restoreStaged(host, paths)
    if (paths.length > 0) runChecked(host, { executable: systemctlPath, args: ['daemon-reload'] }, 'SYSTEMD_DAEMON_RELOAD_RESTORE_FAILED')
  } catch {
    // Later recovery steps can still restore the profile and service availability.
  }
  if (profileAttempted && state.profilePackageInstalledByDshAuth) {
    try {
      runChecked(host, profileCommand(host, state, 'add'), 'PROFILE_PACKAGE_RESTORE_FAILED', dshEnvironment(state))
    } catch {
      // A failed external package restore must not prevent the Caddy recovery attempt.
    }
  }
  if (caddyAttempted) {
    try {
      runChecked(host, { executable: systemctlPath, args: ['enable', '--now', 'dsh-auth-caddy.service'] }, 'CADDY_ENABLE_RESTORE_FAILED')
    } catch {
      // Preserve the original uninstall error after attempting every recovery action.
    }
  }
}

/** Remove only recorded owned files, stopping the owned Caddy unit. */
export function executeUninstall(host: InstallerHost, state: InstallState): void {
  validateStatePaths(state)
  const systemctlPath = systemctl(host)
  let caddyAttempted = false
  let profileAttempted = false
  let staged: StagedPath[] = []
  try {
    caddyAttempted = true
    runChecked(host, { executable: systemctlPath, args: ['disable', '--now', 'dsh-auth-caddy.service'] }, 'CADDY_DISABLE_FAILED')
    if (state.profilePackageInstalledByDshAuth) {
      profileAttempted = true
      runChecked(host, profileCommand(host, state, 'remove'), 'PROFILE_PACKAGE_REMOVE_FAILED', dshEnvironment(state))
    }
    staged = stageRemoval(host, state.createdPaths)
    runChecked(host, { executable: systemctlPath, args: ['daemon-reload'] }, 'SYSTEMD_DAEMON_RELOAD_FAILED')
  } catch (error) {
    restoreServiceState(host, systemctlPath, staged, state, profileAttempted, caddyAttempted)
    throw error
  }
  for (const path of staged) removeTree(host, path.staged)
}
