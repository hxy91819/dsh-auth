import { serializeInstallState } from './config-files.js'
import { DEFAULT_STATE_FILE } from './doctor.js'
import { InstallerError } from './errors.js'
import { readInstallState, validateStatePaths } from './plan.js'
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
  if (verb === 'add' && source.startsWith('/')) args.push('--offline', '--config.auto-install-peers=false')
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
  return {
    plan: {
      schemaVersion: 2,
      operation: 'uninstall',
      mode: 'system',
      status: 'ready',
      actions,
      diagnostics: [],
    },
    state,
  }
}

interface FileBackup {
  readonly path: string
  readonly content: Buffer
  readonly mode: number
  readonly uid: number
  readonly gid: number
}

function backupFile(host: InstallerHost, path: string): FileBackup | undefined {
  if (!host.fileExists(path) || host.stat(path).isDirectory) return undefined
  const stat = host.stat(path)
  return { path, content: host.readFileBytes(path), mode: stat.mode, uid: stat.uid, gid: stat.gid }
}

function restoreBackup(host: InstallerHost, backup: FileBackup | undefined): void {
  if (backup === undefined) return
  if (host.fileExists(backup.path)) host.removeFile(backup.path)
  host.writeNewFile(backup.path, backup.content, backup.mode)
  host.chown(backup.path, backup.uid, backup.gid)
  host.chmod(backup.path, backup.mode)
}

/** Remove only recorded owned files, stopping the owned Caddy unit. */
export function executeUninstall(host: InstallerHost, state: InstallState): void {
  validateStatePaths(state)
  const systemctlPath = systemctl(host)
  const dropInBackup = backupFile(host, state.paths.systemdDropInFile)
  const caddyUnitBackup = backupFile(host, state.paths.caddyUnitFile)
  try {
    runChecked(host, { executable: systemctlPath, args: ['disable', '--now', 'dsh-auth-caddy.service'] }, 'CADDY_DISABLE_FAILED')
    if (state.profilePackageInstalledByDshAuth) {
      runChecked(host, profileCommand(host, state, 'remove'), 'PROFILE_PACKAGE_REMOVE_FAILED', dshEnvironment(state))
    }
    for (const path of [...state.createdPaths].reverse()) {
      if (host.fileExists(path) && host.stat(path).isDirectory) host.removeDirectory(path)
      else host.removeFile(path)
    }
    runChecked(host, { executable: systemctlPath, args: ['daemon-reload'] }, 'SYSTEMD_DAEMON_RELOAD_FAILED')
  } catch (error) {
    restoreBackup(host, dropInBackup)
    restoreBackup(host, caddyUnitBackup)
    if (state.profilePackageInstalledByDshAuth) {
      try {
        runChecked(host, profileCommand(host, state, 'add'), 'PROFILE_PACKAGE_RESTORE_FAILED', dshEnvironment(state))
      } catch {
        // Restore of the unit files is the primary recovery; profile restore is best-effort after that.
      }
    }
    host.replaceFile(state.paths.stateFile, serializeInstallState(state), 0o600)
    throw error
  }
}
