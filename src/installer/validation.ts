import { isIP } from 'node:net'
import { isAbsolute, normalize } from 'node:path'
import { InstallerError } from './errors.js'
import { ExitCode, type EdgeMode, type SetupRequest } from './types.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const SAFE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,126}\.service$/u
const SAFE_SERVER_NAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u

function usage(message: string): never {
  throw new InstallerError(message, ExitCode.usage, [{ code: 'INVALID_ARGUMENT', severity: 'error', message }])
}

/** Validate an absolute filesystem path accepted by root-executed actions. */
export function validateAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes('\0') || normalize(value) !== value || value === '/') {
    usage(`${label} must be a normalized absolute path below the filesystem root`)
  }
  return value
}

/** Validate a systemd unit name without permitting path syntax. */
export function validateServiceName(value: string): string {
  if (!SAFE_SERVICE.test(value) || value.includes('..')) usage('dsh service must be a valid .service unit name')
  return value
}

/** Validate a DSH profile name used as one path segment. */
export function validateProfile(value: string): string {
  if (!SAFE_PROFILE.test(value) || value === '.' || value === '..') usage('profile must be a safe 1-64 character name')
  return value
}

function validatePort(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) usage(`${label} must be an integer from 1 to 65535`)
  return value
}

function validateHostPort(value: string, label: string): string {
  const match = /^(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/u.exec(value)
  if (match === null) usage(`${label} must be a loopback address and port, for example 127.0.0.1:3080`)
  validatePort(Number(match[2]), label)
  return value
}

function isPrivateAddress(value: string): boolean {
  if (value === '127.0.0.1' || value === '::1') return true
  if (value.startsWith('10.') || value.startsWith('192.168.')) return true
  const match = /^172\.(\d{1,2})\./u.exec(value)
  if (match !== null) {
    const second = Number(match[1])
    return second >= 16 && second <= 31
  }
  return /^f[cd][0-9a-f]{0,2}:/iu.test(value)
}

function validateListenAddress(value: string, mode: EdgeMode): string {
  if (isIP(value) === 0) usage('listen address must be a literal IP address')
  if (mode === 'http' && !isPrivateAddress(value)) {
    usage('plain HTTP listen address must be loopback or an RFC1918/ULA private address')
  }
  return value
}

function validateCredentialPath(value: string, label: string): string {
  validateAbsolutePath(value, label)
  if (!/^[A-Za-z0-9_./+-]+$/u.test(value)) usage(`${label} contains characters unsafe for Nginx configuration`)
  return value
}

function validatePackageSource(value: string): string {
  if (/^dsh-auth@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(value)) return value
  validateAbsolutePath(value, 'package source')
  if (!value.endsWith('.tgz')) usage('offline package source must be an absolute .tgz path')
  return value
}

/** Validate and normalize all setup values before discovery or planning. */
export function validateSetupRequest(input: SetupRequest): SetupRequest {
  if (!SAFE_ID.test(input.userId)) usage('user id must be a 1-128 character stable identifier')
  if (input.username.length === 0 || input.username.length > 128 || /[\p{C}\r\n]/u.test(input.username)) {
    usage('username must be 1-128 characters without control characters')
  }
  if (input.roles.length === 0 || input.roles.length > 32 || input.roles.some(role => !SAFE_ID.test(role))) {
    usage('roles must contain 1-32 safe identifiers')
  }
  if (new Set(input.roles).size !== input.roles.length) usage('roles must not contain duplicates')
  validateProfile(input.profile)
  validateHostPort(input.upstream, 'upstream')
  validateListenAddress(input.listenAddress, input.mode)
  validatePort(input.httpPort, 'HTTP port')
  validatePort(input.httpsPort, 'HTTPS port')
  validatePackageSource(input.packageSource)
  if (input.dshService !== undefined) validateServiceName(input.dshService)
  if (input.dshHome !== undefined) validateAbsolutePath(input.dshHome, 'DSH home')
  if (input.dshExecutable !== undefined) validateAbsolutePath(input.dshExecutable, 'DSH executable')
  if (input.outputDirectory !== undefined) validateAbsolutePath(input.outputDirectory, 'output directory')
  if (input.passwordSource?.kind === 'file') validateAbsolutePath(input.passwordSource.path, 'password file')

  if (input.mode === 'https') {
    if (input.serverName === undefined || !SAFE_SERVER_NAME.test(input.serverName)) {
      usage('HTTPS mode requires a valid --server-name')
    }
    if (input.certificate === undefined || input.certificateKey === undefined) {
      usage('HTTPS mode requires --certificate and --certificate-key')
    }
    validateCredentialPath(input.certificate, 'certificate')
    validateCredentialPath(input.certificateKey, 'certificate key')
  } else if (input.serverName !== undefined || input.certificate !== undefined || input.certificateKey !== undefined) {
    usage('plain HTTP mode does not accept TLS server or certificate options')
  }

  if (input.nginxPolicy === 'skip' && input.outputDirectory === undefined) {
    usage('--nginx skip is allowed only with --output-dir')
  }
  if (input.outputDirectory !== undefined && input.nginxPolicy !== 'skip') {
    usage('--output-dir requires --nginx skip')
  }
  if (input.authorizeNginxInstall && input.nginxPolicy !== 'install') {
    usage('--authorize-nginx-install requires --nginx install')
  }
  return input
}
