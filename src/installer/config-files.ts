import { createHash } from 'node:crypto'
import type { InstallState, ManagedPaths, SetupRequest } from './types.js'

function quoteEnvironment(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** Render the DSH service environment without embedding secret values. */
export function renderEnvironmentFile(request: SetupRequest, paths: ManagedPaths, expectedVersion?: string): string {
  const lines = [
    '# Managed by dsh-auth. Secret values live in separate permission-restricted files.',
    `DSH_AUTH_STATE_FILE=${quoteEnvironment(paths.authStateFile)}`,
    `DSH_AUTH_SESSION_SECRET_FILE=${quoteEnvironment(paths.sessionSecretFile)}`,
    `DSH_AUTH_LOGIN_TOKEN_ENABLED=${request.loginTokenEnabled ? 'true' : 'false'}`,
    `DSH_AUTH_SECURE_COOKIES=${request.mode === 'https' ? 'true' : 'false'}`,
    'DSH_AUTH_TRUSTED_PROXY_ADDRESSES="127.0.0.1,::1"',
  ]
  if (expectedVersion !== undefined) {
    // Runtime fail-closed marker: the bundle refuses to activate when its own
    // version differs from the managed installation that wrote this file.
    lines.push(`DSH_AUTH_EXPECTED_VERSION=${quoteEnvironment(expectedVersion)}`)
  }
  if (request.loginTokenEnabled) {
    lines.push(`DSH_AUTH_LOGIN_TOKEN_DIRECTORY=${quoteEnvironment(paths.loginTokenDirectory)}`)
    if (request.loginTokenErrorMessageZh !== undefined) {
      lines.push(`DSH_AUTH_LOGIN_TOKEN_FAILURE_MESSAGE_ZH=${quoteEnvironment(request.loginTokenErrorMessageZh)}`)
    }
    if (request.loginTokenErrorMessageEn !== undefined) {
      lines.push(`DSH_AUTH_LOGIN_TOKEN_FAILURE_MESSAGE_EN=${quoteEnvironment(request.loginTokenErrorMessageEn)}`)
    }
    lines.push('DSH_AUTH_LOGIN_TOKEN_WINDOW_SECONDS="60"')
    lines.push('DSH_AUTH_LOGIN_TOKEN_MAX_ATTEMPTS="10"')
    lines.push('DSH_AUTH_LOGIN_TOKEN_BLOCK_SECONDS="300"')
  }
  lines.push('')
  return lines.join('\n')
}

/** Render the only systemd drop-in owned by setup. */
export function renderSystemdDropIn(paths: ManagedPaths): string {
  return `[Service]\nEnvironmentFile=${paths.environmentFile}\n`
}

/** Return the persistent, secret-free subset of a request. */
export function persistentRequest(request: SetupRequest): InstallState['request'] {
  return {
    mode: request.mode,
    ...(request.outputDirectory === undefined ? {} : { outputDirectory: request.outputDirectory }),
    ...(request.dshService === undefined ? {} : { dshService: request.dshService }),
    ...(request.dshHome === undefined ? {} : { dshHome: request.dshHome }),
    ...(request.dshExecutable === undefined ? {} : { dshExecutable: request.dshExecutable }),
    profile: request.profile,
    packageSource: request.packageSource,
    adminBootstrap: request.adminBootstrap,
    ...(request.adminUsername === undefined ? {} : { adminUsername: request.adminUsername }),
    loginTokenEnabled: request.loginTokenEnabled,
    ...(request.loginTokenErrorMessageZh === undefined ? {} : { loginTokenErrorMessageZh: request.loginTokenErrorMessageZh }),
    ...(request.loginTokenErrorMessageEn === undefined ? {} : { loginTokenErrorMessageEn: request.loginTokenErrorMessageEn }),
    upstream: request.upstream,
    listenAddress: request.listenAddress,
    httpPort: request.httpPort,
    httpsPort: request.httpsPort,
    ...(request.serverName === undefined ? {} : { serverName: request.serverName }),
    ...(request.tls === undefined ? {} : { tls: request.tls }),
    ...(request.certificate === undefined ? {} : { certificate: request.certificate }),
    ...(request.certificateKey === undefined ? {} : { certificateKey: request.certificateKey }),
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonical(entry)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Fingerprint non-secret desired state for idempotency and conflict detection. */
export function requestFingerprint(request: SetupRequest): string {
  return createHash('sha256').update(canonical(persistentRequest(request))).digest('hex')
}

/** Serialize a state record with a trailing newline. */
export function serializeInstallState(state: InstallState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}
