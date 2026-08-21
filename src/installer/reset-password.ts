import { authStateSecretId, parseAuthStateDocument, type AuthStateDocument } from '../auth-state.js'
import { assertAdministratorPassword, hashPassword, parsePasswordHash } from '../password.js'
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
  readonly authState: string
  readonly sessionSecret: string
  readonly authMode: number
  readonly secretMode: number
  readonly authUid: number
  readonly authGid: number
  readonly secretUid: number
  readonly secretGid: number
  readonly document: AuthStateDocument
}

function inspectCredentials(host: InstallerHost, authStateFile: string, sessionSecretFile: string, expectedUid: number, expectedGid: number): CredentialBackup {
  if (!host.regularFile(authStateFile) || host.realpath(authStateFile) !== authStateFile) {
    throw new InstallerError('managed authentication state is missing or not a regular file', ExitCode.conflict)
  }
  if (!host.regularFile(sessionSecretFile) || host.realpath(sessionSecretFile) !== sessionSecretFile) {
    throw new InstallerError('managed credential file is missing or not a regular file', ExitCode.conflict)
  }
  const authStat = host.stat(authStateFile)
  const secretStat = host.stat(sessionSecretFile)
  if (authStat.uid !== expectedUid || authStat.gid !== expectedGid || (authStat.mode & 0o777) !== 0o600) {
    throw new InstallerError('managed authentication state ownership or permissions have drifted', ExitCode.conflict)
  }
  if (secretStat.uid !== 0 || secretStat.gid !== expectedGid || (secretStat.mode & 0o777) !== 0o640) {
    throw new InstallerError('managed credential ownership or permissions have drifted', ExitCode.conflict)
  }
  const sessionSecret = host.readFile(sessionSecretFile)
  if (!/^[A-Za-z0-9_-]{43}\n?$/u.test(sessionSecret)) throw new InstallerError('managed session secret is invalid', ExitCode.conflict)
  const authState = host.readFile(authStateFile)
  let document: AuthStateDocument
  try {
    document = parseAuthStateDocument(
      JSON.parse(authState) as unknown,
      authStateSecretId(Buffer.from(sessionSecret.replace(/\r?\n$/u, ''))),
    )
  } catch {
    throw new InstallerError('managed authentication state is invalid', ExitCode.conflict)
  }
  const admin = document.accounts.find(account => account.id === 'admin')
  if (admin?.username === undefined || admin.username === null || admin.passwordHash === null) {
    throw new InstallerError('password reset requires a configured administrator', ExitCode.conflict)
  }
  parsePasswordHash(admin.passwordHash)
  return {
    authState,
    sessionSecret,
    authMode: authStat.mode,
    secretMode: secretStat.mode,
    authUid: authStat.uid,
    authGid: authStat.gid,
    secretUid: secretStat.uid,
    secretGid: secretStat.gid,
    document,
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
  const backup = inspectCredentials(host, state.paths.authStateFile, state.paths.sessionSecretFile, service.uid, service.gid)
  const password = await readPassword()
  try {
    assertAdministratorPassword(password)
  } catch (error) {
    throw new InstallerError(error instanceof Error ? error.message : 'password is invalid', ExitCode.usage)
  }
  const passwordHash = await hashPassword(password)
  const sessionSecret = host.randomBytes(32).toString('base64url')
  const document: AuthStateDocument = {
    ...backup.document,
    secretId: authStateSecretId(Buffer.from(sessionSecret)),
    accounts: backup.document.accounts.map(account => account.id === 'admin'
      ? {
          ...account,
          passwordHash,
          status: 'active',
          authVersion: account.authVersion + 1,
          configuredAt: Date.now(),
        }
      : account),
    sessions: [],
  }
  const systemctlPath = systemctl(host)
  const wasActive = service.activeState === 'active'
  let stopped = false
  try {
    if (wasActive) {
      runChecked(host, { executable: systemctlPath, args: ['stop', state.dshService] }, 'PASSWORD_RESET_DSH_STOP_FAILED')
      stopped = true
    }
    replaceCredential(host, state.paths.authStateFile, `${JSON.stringify(document)}\n`, 0o600, backup.authUid, backup.authGid)
    replaceCredential(host, state.paths.sessionSecretFile, `${sessionSecret}\n`, 0o640, 0, service.gid)
    if (wasActive) {
      runChecked(host, { executable: systemctlPath, args: ['start', state.dshService] }, 'PASSWORD_RESET_DSH_START_FAILED')
      stopped = false
    }
  } catch (error) {
    try {
      replaceCredential(host, state.paths.authStateFile, backup.authState, backup.authMode, backup.authUid, backup.authGid)
      replaceCredential(host, state.paths.sessionSecretFile, backup.sessionSecret, backup.secretMode, backup.secretUid, backup.secretGid)
      if (stopped || wasActive) {
        runChecked(host, { executable: systemctlPath, args: [wasActive ? 'start' : 'stop', state.dshService] }, 'PASSWORD_RESET_ROLLBACK_SERVICE_FAILED')
      }
    } catch (rollbackError) {
      throw new InstallerError('password reset failed and credential rollback also failed', ExitCode.execution, [
        { code: 'PASSWORD_RESET_FAILED', severity: 'error', message: error instanceof Error ? error.message : String(error) },
        { code: 'PASSWORD_RESET_ROLLBACK_FAILED', severity: 'error', message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) },
      ])
    }
    throw error
  }
}
