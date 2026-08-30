import { isIP } from 'node:net'
import { isAbsolute, normalize } from 'node:path'
import { parseAdministratorUsername } from '../password.js'
import { InstallerError } from './errors.js'
import { ExitCode, type AdminBootstrap, type EdgeMode, type SetupRequest, type TlsMode } from './types.js'

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
function validateProfile(value: string): string {
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

function isLoopbackAddress(value: string): boolean {
  return value === '127.0.0.1' || value === '::1'
}

function validateServerName(value: string): string {
  if (isIP(value) !== 0) return value.toLowerCase()
  if (!SAFE_SERVER_NAME.test(value)) usage('server name must be a DNS hostname or literal IP address')
  return value.toLowerCase()
}

function validateCredentialPath(value: string, label: string): string {
  validateAbsolutePath(value, label)
  if (!/^[A-Za-z0-9_./+-]+$/u.test(value)) usage(`${label} contains characters unsafe for Caddy configuration`)
  return value
}

function validatePackageSource(value: string): string {
  if (/^dsh-auth@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(value)) return value
  validateAbsolutePath(value, 'package source')
  if (!value.endsWith('.tgz')) usage('offline package source must be an absolute .tgz path')
  return value
}

/** Normalize and accept a v2 administrator username. */
function normalizeAdministratorUsername(value: string): string {
  try {
    return parseAdministratorUsername(value)
  } catch (error) {
    usage(error instanceof Error
      ? error.message.replace('administrator username', 'admin username')
      : 'admin username is invalid')
  }
}

/** Accept optional token failure copy that cannot carry control characters. */
function validateTokenFailureMessage(value: string, label: string): string {
  const points = Array.from(value).length
  if (points < 1 || points > 500 || /\p{C}/u.test(value)) {
    usage(`${label} must be 1-500 Unicode code points of plain text without control characters`)
  }
  return value
}

function validateBootstrap(input: SetupRequest): void {
  if (input.adminBootstrap === 'password') {
    if (input.adminUsername === undefined) usage('--admin-bootstrap password requires --admin-username')
    return
  }
  if (input.adminUsername !== undefined) usage('--admin-bootstrap login-token does not accept --admin-username')
  if (input.passwordSource !== undefined) usage('--admin-bootstrap login-token does not accept a password source')
  if (!input.loginTokenEnabled) usage('--admin-bootstrap login-token requires --login-token enabled')
}

function validateTokenPolicy(input: SetupRequest): void {
  if (input.loginTokenEnabled) return
  if (input.loginTokenErrorMessageZh !== undefined || input.loginTokenErrorMessageEn !== undefined) {
    usage('--login-token disabled does not accept custom token failure messages')
  }
}

function validateDeploymentInputs(input: SetupRequest): void {
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
  if (input.adminUsername !== undefined) normalizeAdministratorUsername(input.adminUsername)
  if (input.loginTokenErrorMessageZh !== undefined) validateTokenFailureMessage(input.loginTokenErrorMessageZh, 'Chinese token failure message')
  if (input.loginTokenErrorMessageEn !== undefined) validateTokenFailureMessage(input.loginTokenErrorMessageEn, 'English token failure message')
}

function validateTransport(input: SetupRequest): void {
  if (input.behindTlsProxy === true && (input.mode !== 'http' || !isLoopbackAddress(input.listenAddress))) {
    usage('--behind-tls-proxy requires --mode http and a loopback --listen-address')
  }
  if (input.mode === 'http') {
    if (input.tls !== undefined || input.certificate !== undefined || input.certificateKey !== undefined || input.serverName !== undefined) {
      usage('plain HTTP mode does not accept TLS server or certificate options')
    }
    return
  }
  if (input.serverName === undefined) usage('HTTPS mode requires a valid --server-name')
  const serverName = validateServerName(input.serverName)
  const tls = input.tls ?? 'automatic'
  if (tls === 'automatic' && isIP(serverName) !== 0 && isPrivateAddress(serverName)) {
    usage('--tls automatic requires a publicly routable IP address when --server-name is an IP')
  }
  if (tls === 'automatic' && (input.certificate !== undefined || input.certificateKey !== undefined)) {
    usage('--tls automatic does not accept --certificate or --certificate-key')
  }
  if (tls === 'manual') {
    if (input.certificate === undefined || input.certificateKey === undefined) {
      usage('--tls manual requires --certificate and --certificate-key')
    }
    validateCredentialPath(input.certificate, 'certificate')
    validateCredentialPath(input.certificateKey, 'certificate key')
  }
}

/** Public origin recorded for later token issuance. */
export function publicOrigin(request: SetupRequest): string {
  if (request.mode === 'https') {
    const serverName = request.serverName
    if (serverName === undefined) usage('HTTPS mode requires a valid --server-name')
    const host = isIP(serverName) === 6 ? `[${serverName}]` : serverName
    return request.httpsPort === 443 ? `https://${host}` : `https://${host}:${String(request.httpsPort)}`
  }
  const host = request.listenAddress.includes(':') ? `[${request.listenAddress}]` : request.listenAddress
  return `http://${host}:${String(request.httpPort)}`
}

/** Accept exactly one http or https origin without userinfo, path, query, or fragment. */
export function validatePublicOrigin(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    usage('--public-origin must be an absolute http or https origin')
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username !== '' || parsed.password !== ''
    || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== ''
    || parsed.host === '') {
    usage('--public-origin must be a single origin without userinfo, path, query, or fragment')
  }
  if (parsed.protocol === 'http:' && !isPrivateAddress(parsed.hostname)) {
    usage('plain HTTP --public-origin must use a private, ULA, or loopback literal address')
  }
  return `${parsed.protocol}//${parsed.host}`
}

export function parseAdminBootstrap(value: string | undefined): AdminBootstrap | undefined {
  if (value === undefined) return undefined
  if (value !== 'password' && value !== 'login-token') usage('--admin-bootstrap must be password or login-token')
  return value
}

export function parseLoginTokenPolicy(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value !== 'enabled' && value !== 'disabled') usage('--login-token must be enabled or disabled')
  return value === 'enabled'
}

export function parseTlsMode(value: string | undefined): TlsMode | undefined {
  if (value === undefined) return undefined
  if (value !== 'automatic' && value !== 'manual') usage('--tls must be automatic or manual')
  return value
}

/** Validate and normalize all setup values before discovery or planning. */
export function validateSetupRequest(input: SetupRequest): SetupRequest {
  const adminUsername = input.adminUsername === undefined ? undefined : normalizeAdministratorUsername(input.adminUsername)
  const normalized: SetupRequest = {
    ...input,
    ...(adminUsername === undefined ? {} : { adminUsername }),
    ...(input.mode === 'https' ? { tls: input.tls ?? 'automatic' } : {}),
  }
  validateBootstrap(normalized)
  validateTokenPolicy(normalized)
  validateDeploymentInputs(normalized)
  validateTransport(normalized)
  return normalized
}
