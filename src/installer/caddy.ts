import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InstallerError } from './errors.js'
import { ExitCode, type InstallerHost, type ManagedPaths, type SetupRequest } from './types.js'

export const CADDY_VERSION = '2.11.4'
export const CADDY_PACKAGE_VERSION = '2.11.4-dsh.1'
export const CADDY_SERVICE_NAME = 'dsh-auth-caddy.service'
export const SYSTEM_CADDY_BINARY = '/usr/lib/dsh-auth/caddy'
export const SYSTEM_CADDY_UNIT = `/etc/systemd/system/${CADDY_SERVICE_NAME}`
export const SYSTEM_CADDY_STATE = '/var/lib/dsh-auth-caddy'
const CREDENTIAL_CERT = 'dsh-auth-cert'
const CREDENTIAL_KEY = 'dsh-auth-key'

export interface CaddyPackage {
  readonly name: string
  readonly directory: string
  readonly executable: string
  readonly binarySha256: string
}

function prerequisite(message: string, code: string, remediation: string): never {
  throw new InstallerError(message, ExitCode.prerequisite, [{ code, severity: 'error', message, remediation }])
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value)
}

function caddyPath(value: string, label: string): string {
  if (!isAbsolute(value) || /[\r\n]/u.test(value)) throw new InstallerError(`${label} must be an absolute path without line breaks`, ExitCode.usage)
  return JSON.stringify(value)
}

function hostname(value: string): string {
  if (!/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(value)) {
    throw new InstallerError('publicHost must be a DNS hostname', ExitCode.usage)
  }
  return value.toLowerCase()
}

function tlsDirective(request: SetupRequest, system: boolean): string {
  if (request.tls === 'manual' && request.certificate !== undefined && request.certificateKey !== undefined) {
    if (system) {
      return `tls ${caddyPath(`/run/credentials/${CADDY_SERVICE_NAME}/${CREDENTIAL_CERT}`, 'certificate')} ${caddyPath(`/run/credentials/${CADDY_SERVICE_NAME}/${CREDENTIAL_KEY}`, 'key')}`
    }
    return `tls ${caddyPath(request.certificate, 'certificate')} ${caddyPath(request.certificateKey, 'key')}`
  }
  return ''
}

function fillTemplate(template: string, values: ReadonlyMap<string, string>): string {
  let rendered = template
  for (const [placeholder, value] of values) rendered = rendered.replaceAll(placeholder, value)
  rendered = rendered.replace(/^[\t ]+$/gmu, '')
  rendered = rendered.replace(/\n{3,}/gu, '\n\n')
  if (/\{\{[A-Z_]+\}\}/u.test(rendered)) throw new InstallerError('Caddyfile template contains an unresolved placeholder', ExitCode.execution)
  return rendered
}

function templateFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../deploy/caddy/${name}`, import.meta.url)), 'utf8')
}

/** Render the managed Caddyfile for HTTPS or trusted-network HTTP. */
export function renderCaddyfile(request: SetupRequest, system: boolean): string {
  if (request.mode === 'http') {
    const authority = `${request.listenAddress}:${String(request.httpPort)}`
    return fillTemplate(templateFile('dsh-auth.http.Caddyfile.template'), new Map([
      ['{{PUBLIC_HOST}}', request.listenAddress],
      ['{{HTTP_PORT}}', String(request.httpPort)],
      ['{{LISTEN_ADDRESS}}', request.listenAddress],
      ['{{PUBLIC_AUTHORITY}}', authority],
      ['{{UPSTREAM}}', request.upstream],
    ]))
  }
  const publicHost = hostname(request.serverName ?? '')
  const authority = `${publicHost}:${String(request.httpsPort)}`
  return fillTemplate(templateFile('dsh-auth.Caddyfile.template'), new Map([
    ['{{PUBLIC_HOST}}', publicHost],
    ['{{HTTP_PORT}}', String(request.httpPort)],
    ['{{HTTPS_PORT}}', String(request.httpsPort)],
    ['{{LISTEN_ADDRESS}}', request.listenAddress],
    ['{{PUBLIC_AUTHORITY}}', authority],
    ['{{UPSTREAM}}', request.upstream],
    ['{{TLS_DIRECTIVE}}', tlsDirective(request, system)],
  ]))
}

/** Independent DynamicUser unit that never reuses a user Caddy or Nginx service. */
export function renderCaddyUnit(request: SetupRequest, paths: ManagedPaths): string {
  const credentials = request.tls === 'manual' && request.certificate !== undefined && request.certificateKey !== undefined
    ? `LoadCredential=${CREDENTIAL_CERT}:${request.certificate}\nLoadCredential=${CREDENTIAL_KEY}:${request.certificateKey}\n`
    : ''
  return `[Unit]
Description=dsh-auth Caddy public edge
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
StateDirectory=dsh-auth-caddy
ReadWritePaths=${paths.caddyStateDirectory}
${credentials}ExecStartPre=${paths.caddyBinary} validate --config ${paths.caddyfile}
ExecStart=${paths.caddyBinary} run --config ${paths.caddyfile} --adapter caddyfile
ExecReload=${paths.caddyBinary} reload --config ${paths.caddyfile} --adapter caddyfile
Restart=on-failure

[Install]
WantedBy=multi-user.target
`
}

function caddyPackageName(platform: NodeJS.Platform, arch: string): string {
  if (platform !== 'linux') prerequisite('Caddy platform packages are published for Linux only.', 'CADDY_UNSUPPORTED_PLATFORM', 'Use a Linux x64 or ARM64 host, or --output-dir on a matching image.')
  if (arch === 'x64') return 'dsh-auth-caddy-linux-x64'
  if (arch === 'arm64') return 'dsh-auth-caddy-linux-arm64'
  prerequisite(`Unsupported architecture ${arch}.`, 'CADDY_UNSUPPORTED_ARCH', 'Install on linux-x64 or linux-arm64.')
}

function readManifest(host: InstallerHost, directory: string): Record<string, unknown> {
  const path = join(directory, 'manifest.json')
  if (!host.regularFile(path)) prerequisite('Caddy platform package is missing manifest.json.', 'CADDY_PACKAGE_INVALID', 'Reinstall the matching dsh-auth-caddy platform package.')
  const checksumFile = join(directory, 'manifest.sha256')
  const bytes = host.readFileBytes(path)
  if (!host.regularFile(checksumFile) || host.readFile(checksumFile).trim() !== digest(bytes)) {
    prerequisite('Caddy platform package manifest checksum does not match.', 'CADDY_MANIFEST_CHECKSUM', 'Reinstall the matching dsh-auth-caddy platform package; setup never downloads Caddy.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    prerequisite('Caddy platform package manifest is not JSON.', 'CADDY_PACKAGE_INVALID', 'Reinstall the matching dsh-auth-caddy platform package.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    prerequisite('Caddy platform package manifest is invalid.', 'CADDY_PACKAGE_INVALID', 'Reinstall the matching dsh-auth-caddy platform package.')
  }
  return parsed as Record<string, unknown>
}

/** Resolve and verify the exact local platform package. Never downloads a binary. */
export function resolveCaddyPackage(host: InstallerHost): CaddyPackage {
  const name = caddyPackageName(host.platform, host.arch)
  let directory: string
  try {
    directory = host.resolveModulePackage(name)
  } catch {
    prerequisite(
      `Caddy platform package ${name}@${CADDY_PACKAGE_VERSION} is not installed.`,
      'CADDY_PACKAGE_MISSING',
      `Install optional dependency ${name}@${CADDY_PACKAGE_VERSION}. Setup never downloads Caddy from the network.`,
    )
  }
  const packageJsonPath = join(directory, 'package.json')
  if (!host.regularFile(packageJsonPath)) {
    prerequisite('Caddy platform package is incomplete.', 'CADDY_PACKAGE_INVALID', 'Reinstall the matching dsh-auth-caddy platform package.')
  }
  let pkg: { readonly name?: unknown; readonly version?: unknown }
  try {
    pkg = JSON.parse(host.readFile(packageJsonPath)) as { readonly name?: unknown; readonly version?: unknown }
  } catch {
    prerequisite('Caddy platform package.json is invalid.', 'CADDY_PACKAGE_INVALID', 'Reinstall the matching dsh-auth-caddy platform package.')
  }
  if (pkg.name !== name || pkg.version !== CADDY_PACKAGE_VERSION) {
    prerequisite('Caddy platform package version does not match the frozen edge runtime.', 'CADDY_PACKAGE_VERSION', `Use ${name}@${CADDY_PACKAGE_VERSION}.`)
  }
  const manifest = readManifest(host, directory)
  if (manifest.caddyVersion !== CADDY_VERSION || manifest.executable !== 'caddy' || typeof manifest.binarySha256 !== 'string' || !sha256Hex(manifest.binarySha256)) {
    prerequisite('Caddy platform package manifest fields are invalid.', 'CADDY_PACKAGE_INVALID', 'Reinstall the matching dsh-auth-caddy platform package.')
  }
  if (!host.regularFile(join(directory, 'LICENSE')) || !host.regularFile(join(directory, 'THIRD_PARTY.md'))) {
    prerequisite('Caddy platform package is missing LICENSE or third-party notices.', 'CADDY_LICENSE_MISSING', 'Reinstall the complete platform package.')
  }
  const executable = join(directory, 'caddy')
  if (!host.regularFile(executable) || digest(host.readFileBytes(executable)) !== manifest.binarySha256) {
    prerequisite('Caddy binary is missing or does not match the platform package checksum.', 'CADDY_BINARY_CHECKSUM', 'Reinstall the matching dsh-auth-caddy platform package; setup never downloads Caddy.')
  }
  return { name, directory, executable, binarySha256: manifest.binarySha256 }
}

function publicPorts(request: SetupRequest): readonly { readonly address: string; readonly port: number }[] {
  if (request.mode === 'http') return [{ address: request.listenAddress, port: request.httpPort }]
  return [
    { address: request.listenAddress, port: request.httpPort },
    { address: request.listenAddress, port: request.httpsPort },
  ]
}

export function assertPublicPortsFree(host: InstallerHost, request: SetupRequest): void {
  for (const endpoint of publicPorts(request)) {
    if (!host.portBusy(endpoint.address, endpoint.port)) continue
    throw new InstallerError('a required public port is already in use', ExitCode.conflict, [{
      code: 'PUBLIC_PORT_IN_USE',
      severity: 'error',
      message: `Address ${endpoint.address} port ${String(endpoint.port)} is already in use.`,
      remediation: 'Free the port or choose a different listen address/port. dsh-auth does not stop or take over another service.',
    }])
  }
}
