import { dirname, join } from 'node:path'
import { DEFAULT_STATE_FILE } from './doctor.js'
import { InstallerError } from './errors.js'
import { readInstallState, validateStatePaths } from './plan.js'
import { ExitCode, type InstallerHost, type InstallState } from './types.js'
import { publicOrigin, validateAbsolutePath, validatePublicOrigin } from './validation.js'

/** Fully validated inputs the token store and URL builder need. */
export interface LoginTokenIssueContext {
  readonly authStateFile: string
  readonly tokenDirectory: string
  readonly publicOrigin: string
  readonly owner: { readonly uid: number; readonly gid: number } | undefined
}

function conflict(message: string, code: string): never {
  throw new InstallerError(message, ExitCode.conflict, [{ code, severity: 'error', message }])
}

function requireStateFile(host: InstallerHost, path: string): void {
  if (!host.regularFile(path) || host.realpath(path) !== path) {
    conflict(`the authentication state file is missing or not a regular file: ${path}`, 'AUTH_STATE_INVALID')
  }
}

function requireTokenDirectory(host: InstallerHost, path: string, uid: number, gid: number): void {
  let directory
  try {
    directory = host.inspectDirectory(path)
  } catch {
    conflict(`the login token directory is missing or not a real directory: ${path}`, 'LOGIN_TOKEN_DIRECTORY_INVALID')
  }
  if (host.realpath(path) !== path) {
    conflict(`the login token directory is missing or not a real directory: ${path}`, 'LOGIN_TOKEN_DIRECTORY_INVALID')
  }
  if ((directory.mode & 0o777) !== 0o700 || directory.uid !== uid || directory.gid !== gid) {
    conflict('the login token directory has unexpected permissions or ownership', 'LOGIN_TOKEN_DIRECTORY_INVALID')
  }
}

function requireAuthStateShape(host: InstallerHost, path: string, uid: number, gid: number): void {
  requireStateFile(host, path)
  const stat = host.stat(path)
  if ((stat.mode & 0o777) !== 0o600 || stat.uid !== uid || stat.gid !== gid) {
    conflict('the managed authentication state has unexpected permissions or ownership', 'AUTH_STATE_INVALID')
  }
}

function completedSystemState(host: InstallerHost): InstallState {
  const state = readInstallState(host, DEFAULT_STATE_FILE)
  if (state === undefined) {
    conflict('managed dsh-auth installation was not found', 'INSTALLATION_NOT_FOUND')
  }
  validateStatePaths(state)
  if (state.status !== 'installed' || state.request.outputDirectory !== undefined) {
    conflict('login token issue requires a completed system installation', 'INSTALLATION_INCOMPLETE')
  }
  return state
}

/** Derive issue inputs from the default v2 system ownership record; root only. */
export function resolveSystemdLoginTokenContext(host: InstallerHost): LoginTokenIssueContext {
  if (host.effectiveUid !== 0) {
    throw new InstallerError('systemd login token issue requires root', ExitCode.permission, [{
      code: 'LOGIN_TOKEN_ROOT_REQUIRED',
      severity: 'error',
      message: 'Run the command as root, or pass --auth-state-file and --public-origin for an explicit container state.',
    }])
  }
  const state = completedSystemState(host)
  if (!state.loginTokenEnabled) {
    throw new InstallerError('login tokens are disabled for this installation', ExitCode.prerequisite, [{
      code: 'LOGIN_TOKEN_DISABLED',
      severity: 'error',
      message: 'The recorded installation was set up with --login-token disabled.',
      remediation: 'Run setup again with --login-token enabled to allow login token issue.',
    }])
  }
  if (state.publicOrigin !== publicOrigin(state.request)) {
    conflict('the recorded public origin does not match the recorded installation request', 'INSTALL_STATE_INCONSISTENT')
  }
  requireAuthStateShape(host, state.paths.authStateFile, state.dshUid, state.dshGid)
  requireTokenDirectory(host, state.paths.loginTokenDirectory, state.dshUid, state.dshGid)
  return {
    authStateFile: state.paths.authStateFile,
    tokenDirectory: state.paths.loginTokenDirectory,
    publicOrigin: state.publicOrigin,
    owner: { uid: state.dshUid, gid: state.dshGid },
  }
}

const ENABLED_PATTERN = /^DSH_AUTH_LOGIN_TOKEN_ENABLED=(true|false)$/mu

function requireContainerTokenEnabled(host: InstallerHost, authStateFile: string): void {
  const environmentFile = join(dirname(dirname(authStateFile)), 'dsh-auth.env')
  if (!host.regularFile(environmentFile) || host.realpath(environmentFile) !== environmentFile) {
    throw new InstallerError('adjacent dsh-auth.env policy file is missing', ExitCode.prerequisite, [{
      code: 'LOGIN_TOKEN_POLICY_MISSING',
      severity: 'error',
      message: 'The sibling deployment environment file could not be read.',
      remediation: 'Run the command from the layout produced by setup --output-dir so dsh-auth.env sits next to the state directory.',
    }])
  }
  const match = ENABLED_PATTERN.exec(host.readFile(environmentFile))
  if (match === null) {
    conflict('the adjacent environment file does not declare DSH_AUTH_LOGIN_TOKEN_ENABLED', 'LOGIN_TOKEN_POLICY_INVALID')
  }
  if (match[1] !== 'true') {
    throw new InstallerError('login tokens are disabled for this deployment', ExitCode.prerequisite, [{
      code: 'LOGIN_TOKEN_DISABLED',
      severity: 'error',
      message: 'The deployment environment file sets DSH_AUTH_LOGIN_TOKEN_ENABLED=false.',
      remediation: 'Regenerate the deployment with --login-token enabled to allow login token issue.',
    }])
  }
}

/** Validate explicit container inputs; root or the sole authentication-state owner may issue. */
export function resolveContainerLoginTokenContext(host: InstallerHost, authStateFileValue: string, publicOriginValue: string): LoginTokenIssueContext {
  const authStateFile = validateAbsolutePath(authStateFileValue, 'auth state file')
  const origin = validatePublicOrigin(publicOriginValue)
  const caller = host.effectiveUid
  if (caller === undefined) {
    throw new InstallerError('login token issue requires a POSIX user identity', ExitCode.permission)
  }
  requireStateFile(host, authStateFile)
  const stat = host.stat(authStateFile)
  if ((stat.mode & 0o777) !== 0o600) {
    conflict('the authentication state file must have mode 0600', 'AUTH_STATE_INVALID')
  }
  if (caller !== 0 && caller !== stat.uid) {
    throw new InstallerError('login token issue requires root or the authentication state owner', ExitCode.permission, [{
      code: 'LOGIN_TOKEN_CALLER_NOT_AUTHORIZED',
      severity: 'error',
      message: 'Run as root or as the user that owns the authentication state file.',
    }])
  }
  const tokenDirectory = join(dirname(authStateFile), 'login-tokens')
  requireTokenDirectory(host, tokenDirectory, stat.uid, stat.gid)
  requireContainerTokenEnabled(host, authStateFile)
  return {
    authStateFile,
    tokenDirectory,
    publicOrigin: origin,
    owner: caller === 0 ? { uid: stat.uid, gid: stat.gid } : undefined,
  }
}
