import { hashPassword, parsePasswordHash } from '../password.js'
import { discoverDshService } from './discovery.js'
import { DEFAULT_STATE_FILE } from './doctor.js'
import { InstallerError } from './errors.js'
import { readInstallState, validateStatePaths } from './plan.js'
import { ExitCode, type CommandSpec, type InstallerHost } from './types.js'

function systemctl(host: InstallerHost): string {
  const executable = ['/usr/bin/systemctl', '/bin/systemctl'].find(candidate => host.regularFile(candidate))
  if (executable === undefined) throw new InstallerError('systemctl is unavailable', ExitCode.prerequisite)
  return executable
}

function runChecked(host: InstallerHost, command: CommandSpec, code: string): void {
  const result = host.run(command)
  if (result.status !== 0 || result.error !== undefined) {
    throw new InstallerError('password reset command failed', ExitCode.execution, [{ code, severity: 'error', message: `${command.executable} failed; output was withheld.` }])
  }
}

interface CredentialBackup {
  readonly passwordHash: string
  readonly sessionSecret: string
  readonly hashMode: number
  readonly secretMode: number
  readonly uid: number
  readonly gid: number
}

function inspectCredentials(host: InstallerHost, passwordHashFile: string, sessionSecretFile: string, expectedGid: number): CredentialBackup {
  for (const path of [passwordHashFile, sessionSecretFile]) {
    if (!host.regularFile(path) || host.realpath(path) !== path) throw new InstallerError('managed credential file is missing or not a regular file', ExitCode.conflict)
    const stat = host.stat(path)
    if (stat.uid !== 0 || stat.gid !== expectedGid || (stat.mode & 0o777) !== 0o640) {
      throw new InstallerError('managed credential ownership or permissions have drifted', ExitCode.conflict)
    }
  }
  const passwordHash = host.readFile(passwordHashFile)
  const sessionSecret = host.readFile(sessionSecretFile)
  const encodedHash = passwordHash.endsWith('\n') ? passwordHash.slice(0, -1) : passwordHash
  try {
    if (encodedHash.includes('\n')) throw new Error('password hash contains multiple lines')
    parsePasswordHash(encodedHash)
  } catch {
    throw new InstallerError('managed password hash is invalid', ExitCode.conflict)
  }
  if (!/^[A-Za-z0-9_-]{43}\n?$/u.test(sessionSecret)) throw new InstallerError('managed session secret is invalid', ExitCode.conflict)
  return {
    passwordHash,
    sessionSecret,
    hashMode: host.stat(passwordHashFile).mode,
    secretMode: host.stat(sessionSecretFile).mode,
    uid: 0,
    gid: expectedGid,
  }
}

function replaceCredential(host: InstallerHost, path: string, content: string, mode: number, uid: number, gid: number): void {
  host.replaceFile(path, content, mode)
  host.chown(path, uid, gid)
  host.chmod(path, mode)
}

/** Replace managed credentials and revoke sessions without changing non-secret installation settings. */
export async function resetManagedPassword(host: InstallerHost, readPassword: () => Promise<string>, stateFile = DEFAULT_STATE_FILE): Promise<void> {
  if (host.effectiveUid !== 0) throw new InstallerError('password reset requires root', ExitCode.permission)
  const state = readInstallState(host, stateFile)
  if (state === undefined) throw new InstallerError('managed dsh-auth installation was not found', ExitCode.conflict)
  validateStatePaths(state)
  if (state.status !== 'installed' || state.request.outputDirectory !== undefined) throw new InstallerError('password reset requires a completed system installation', ExitCode.conflict)
  const service = discoverDshService(host, state.dshService, { dshHome: state.dshHome, dshExecutable: state.dshExecutable })
  if (!['active', 'inactive', 'failed'].includes(service.activeState)) throw new InstallerError('DSH service is changing state; retry password reset after it settles', ExitCode.prerequisite)
  const backup = inspectCredentials(host, state.paths.passwordHashFile, state.paths.sessionSecretFile, service.gid)
  const password = await readPassword()
  if (password.length === 0) throw new InstallerError('password must not be empty', ExitCode.usage)
  if (Buffer.byteLength(password, 'utf8') > 16 * 1024) throw new InstallerError('password input is too large', ExitCode.usage)
  const passwordHash = await hashPassword(password)
  const sessionSecret = host.randomBytes(32).toString('base64url')
  const systemctlPath = systemctl(host)
  let restartAttempted = false
  try {
    replaceCredential(host, state.paths.passwordHashFile, `${passwordHash}\n`, 0o640, 0, service.gid)
    replaceCredential(host, state.paths.sessionSecretFile, `${sessionSecret}\n`, 0o640, 0, service.gid)
    if (service.activeState === 'active') {
      restartAttempted = true
      runChecked(host, { executable: systemctlPath, args: ['restart', state.dshService] }, 'PASSWORD_RESET_DSH_RESTART_FAILED')
    }
  } catch (error) {
    try {
      replaceCredential(host, state.paths.passwordHashFile, backup.passwordHash, backup.hashMode, backup.uid, backup.gid)
      replaceCredential(host, state.paths.sessionSecretFile, backup.sessionSecret, backup.secretMode, backup.uid, backup.gid)
      if (restartAttempted) runChecked(host, { executable: systemctlPath, args: ['restart', state.dshService] }, 'PASSWORD_RESET_ROLLBACK_RESTART_FAILED')
    } catch (rollbackError) {
      throw new InstallerError('password reset failed and credential rollback also failed', ExitCode.execution, [
        { code: 'PASSWORD_RESET_FAILED', severity: 'error', message: error instanceof Error ? error.message : String(error) },
        { code: 'PASSWORD_RESET_ROLLBACK_FAILED', severity: 'error', message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) },
      ])
    }
    throw error
  }
}
