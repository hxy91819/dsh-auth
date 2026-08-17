import { createHash } from 'node:crypto'
import type { InstallState, ManagedPaths, SetupRequest } from './types.js'

function quoteEnvironment(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** Render the DSH service environment without embedding secret values. */
export function renderEnvironmentFile(request: SetupRequest, paths: ManagedPaths): string {
  return [
    '# Managed by dsh-auth. Secret values live in separate permission-restricted files.',
    `DSH_AUTH_USER_ID=${quoteEnvironment(request.userId)}`,
    `DSH_AUTH_USERNAME=${quoteEnvironment(request.username)}`,
    `DSH_AUTH_ROLES=${quoteEnvironment(request.roles.join(','))}`,
    'DSH_AUTH_TRUSTED_PROXY_ADDRESSES="127.0.0.1,::1"',
    `DSH_AUTH_PASSWORD_HASH_FILE=${quoteEnvironment(paths.passwordHashFile)}`,
    `DSH_AUTH_SESSION_SECRET_FILE=${quoteEnvironment(paths.sessionSecretFile)}`,
    `DSH_AUTH_SESSION_STORE_FILE=${quoteEnvironment(paths.sessionStoreFile)}`,
    `DSH_AUTH_SECURE_COOKIES=${request.mode === 'https' ? 'true' : 'false'}`,
    '',
  ].join('\n')
}

/** Render the only systemd file owned by setup. */
export function renderSystemdDropIn(paths: ManagedPaths): string {
  return `[Service]\nEnvironmentFile=${paths.environmentFile}\n`
}

/** Return the persistent, secret-free subset of a request. */
export function persistentRequest(request: SetupRequest): InstallState['request'] {
  return {
    mode: request.mode,
    nginxPolicy: request.nginxPolicy,
    ...(request.outputDirectory === undefined ? {} : { outputDirectory: request.outputDirectory }),
    ...(request.dshService === undefined ? {} : { dshService: request.dshService }),
    ...(request.dshHome === undefined ? {} : { dshHome: request.dshHome }),
    ...(request.dshExecutable === undefined ? {} : { dshExecutable: request.dshExecutable }),
    profile: request.profile,
    packageSource: request.packageSource,
    userId: request.userId,
    username: request.username,
    roles: request.roles,
    upstream: request.upstream,
    listenAddress: request.listenAddress,
    httpPort: request.httpPort,
    httpsPort: request.httpsPort,
    ...(request.serverName === undefined ? {} : { serverName: request.serverName }),
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
