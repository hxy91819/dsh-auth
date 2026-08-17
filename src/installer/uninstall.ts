import { serializeInstallState } from './config-files.js'
import { DEFAULT_STATE_FILE } from './doctor.js'
import { InstallerError } from './errors.js'
import { discoverNginx } from './nginx.js'
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
    return { plan: { schemaVersion: 1, operation: 'uninstall', mode: 'system', status: 'unchanged', actions: [], diagnostics: [{ code: 'INSTALLATION_NOT_FOUND', severity: 'info', message: 'No managed installation exists.' }] } }
  }
  validateStatePaths(state)
  if (state.request.outputDirectory !== undefined) throw new InstallerError('system uninstall refuses an output-mode ownership record', ExitCode.conflict)
  const actions = [
    { id: 'remove-nginx-config', kind: 'remove-file' as const, description: 'Remove the recorded project-owned Nginx include.', target: state.paths.nginxConfigFile },
    { id: 'nginx-test-reload', kind: 'run-command' as const, description: 'Validate and reload Nginx after removing public routing.', command: { executable: state.nginxExecutable, args: ['-t'] } },
    ...(state.profilePackageInstalledByDshAuth ? [{ id: 'remove-profile-package', kind: 'install-package' as const, description: 'Remove only the profile package installed by this setup.' }] : []),
    { id: 'remove-drop-in', kind: 'remove-file' as const, description: 'Remove the recorded project-owned systemd drop-in.', target: state.paths.systemdDropInFile },
    { id: 'remove-owned-files', kind: 'remove-file' as const, description: 'Remove the remaining files listed in the ownership record.' },
  ]
  return {
    plan: {
      schemaVersion: 1,
      operation: 'uninstall',
      mode: 'system',
      status: 'ready',
      actions,
      diagnostics: state.nginxInstalledByDshAuth ? [{ code: 'NGINX_RETAINED', severity: 'info', message: 'Nginx was installed during setup but will be retained because it is a shared system package.' }] : [],
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

function restoreFile(host: InstallerHost, backup: FileBackup): void {
  if (host.fileExists(backup.path)) host.removeFile(backup.path)
  host.writeNewFile(backup.path, backup.content, backup.mode)
  host.chown(backup.path, backup.uid, backup.gid)
  host.chmod(backup.path, backup.mode)
}

/** Uninstall only recorded paths, with Nginx validation before each reload. */
export function executeUninstall(host: InstallerHost, state: InstallState): void {
  validateStatePaths(state)
  if (state.request.packageSource.startsWith('/') && state.profilePackageInstalledByDshAuth && !host.regularFile(state.request.packageSource)) {
    throw new InstallerError('offline package is required to guarantee uninstall rollback', ExitCode.prerequisite, [{ code: 'OFFLINE_ROLLBACK_SOURCE_MISSING', severity: 'error', message: 'The recorded offline tarball is unavailable.', remediation: 'Restore the exact tarball at its recorded path, then rerun uninstall.' }])
  }
  const backups = state.createdPaths.map(path => backupFile(host, path)).filter((value): value is FileBackup => value !== undefined)
  const nginxBackup = backups.find(backup => backup.path === state.paths.nginxConfigFile)
  const systemctlPath = systemctl(host)
  let packageRemoved = false
  try {
    host.removeFile(state.paths.nginxConfigFile)
    runChecked(host, { executable: state.nginxExecutable, args: ['-t'] }, 'UNINSTALL_NGINX_TEST_FAILED')
    const nginxActive = host.run({ executable: systemctlPath, args: ['is-active', '--quiet', state.nginxService] })
    if (nginxActive.status === 0) runChecked(host, { executable: systemctlPath, args: ['reload', state.nginxService] }, 'UNINSTALL_NGINX_RELOAD_FAILED')

    if (state.profilePackageInstalledByDshAuth) {
      runChecked(host, profileCommand(host, state, 'remove'), 'UNINSTALL_PROFILE_PACKAGE_FAILED', dshEnvironment(state))
      packageRemoved = true
    }
    host.removeFile(state.paths.systemdDropInFile)
    runChecked(host, { executable: systemctlPath, args: ['daemon-reload'] }, 'UNINSTALL_SYSTEMD_RELOAD_FAILED')
    runChecked(host, { executable: systemctlPath, args: ['restart', state.dshService] }, 'UNINSTALL_DSH_RESTART_FAILED')

    const paths = [...state.createdPaths].reverse()
    for (const path of paths) {
      if (path === state.paths.nginxConfigFile || path === state.paths.systemdDropInFile) continue
      if (!host.fileExists(path)) continue
      if (host.stat(path).isDirectory) host.removeDirectory(path)
      else host.removeFile(path)
    }
  } catch (error) {
    for (const backup of backups) {
      if (!host.fileExists(backup.path)) {
        const parent = backup.path.slice(0, backup.path.lastIndexOf('/'))
        if (!host.fileExists(parent)) host.mkdir(parent, 0o750)
        restoreFile(host, backup)
      }
    }
    if (packageRemoved) runChecked(host, profileCommand(host, state, 'add'), 'UNINSTALL_PROFILE_RESTORE_FAILED', dshEnvironment(state))
    host.replaceFile(state.paths.stateFile, serializeInstallState(state), 0o600)
    runChecked(host, { executable: systemctlPath, args: ['daemon-reload'] }, 'UNINSTALL_ROLLBACK_SYSTEMD_FAILED')
    runChecked(host, { executable: systemctlPath, args: ['restart', state.dshService] }, 'UNINSTALL_ROLLBACK_DSH_FAILED')
    if (nginxBackup !== undefined) {
      const nginx = discoverNginx(host)
      if (nginx.executable !== undefined) runChecked(host, { executable: nginx.executable, args: ['-t'] }, 'UNINSTALL_ROLLBACK_NGINX_TEST_FAILED')
      runChecked(host, { executable: systemctlPath, args: ['reload', state.nginxService] }, 'UNINSTALL_ROLLBACK_NGINX_RELOAD_FAILED')
    }
    throw error
  }
}
