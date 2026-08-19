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
  // DynamicUser cannot search 0750 /etc/dsh-auth, so bind the 0644 Caddyfile into RuntimeDirectory.
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
RuntimeDirectory=dsh-auth-caddy
BindReadOnlyPaths=${paths.caddyfile}:/run/dsh-auth-caddy/Caddyfile
${credentials}ExecStartPre=${paths.caddyBinary} validate --config /run/dsh-auth-caddy/Caddyfile
ExecStart=${paths.caddyBinary} run --config /run/dsh-auth-caddy/Caddyfile --adapter caddyfile
ExecReload=${paths.caddyBinary} reload --config /run/dsh-auth-caddy/Caddyfile --adapter caddyfile
Restart=on-failure

[Install]
WantedBy=multi-user.target
`
}

function caddyPlatform(platform: NodeJS.Platform, arch: string): 'linux-x64' | 'linux-arm64' {
  if (platform !== 'linux') prerequisite('Bundled Caddy is published for Linux only.', 'CADDY_UNSUPPORTED_PLATFORM', 'Use a Linux x64 or ARM64 host, or --output-dir on a matching image.')
  if (arch === 'x64') return 'linux-x64'
  if (arch === 'arm64') return 'linux-arm64'
  prerequisite(`Unsupported architecture ${arch}.`, 'CADDY_UNSUPPORTED_ARCH', 'Install dsh-auth on linux-x64 or linux-arm64.')
}

function readManifest(host: InstallerHost, directory: string): Record<string, unknown> {
  const path = join(directory, 'manifest.json')
  if (!host.regularFile(path)) prerequisite('Bundled Caddy is missing manifest.json.', 'CADDY_PACKAGE_INVALID', 'Reinstall dsh-auth. Setup never downloads Caddy.')
  const checksumFile = join(directory, 'manifest.sha256')
  const bytes = host.readFileBytes(path)
  if (!host.regularFile(checksumFile) || host.readFile(checksumFile).trim() !== digest(bytes)) {
    prerequisite('Bundled Caddy manifest checksum does not match.', 'CADDY_MANIFEST_CHECKSUM', 'Reinstall dsh-auth. Setup never downloads Caddy.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    prerequisite('Bundled Caddy manifest is not JSON.', 'CADDY_PACKAGE_INVALID', 'Reinstall dsh-auth.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    prerequisite('Bundled Caddy manifest is invalid.', 'CADDY_PACKAGE_INVALID', 'Reinstall dsh-auth.')
  }
  return parsed as Record<string, unknown>
}

/** Resolve and verify a bundled Caddy tree. Defaults to this CLI's own vendor root. Never downloads. */
export function resolveCaddyPackage(host: InstallerHost, root: string = host.resolveBundledCaddyRoot()): CaddyPackage {
  const directory = root
  const selected = caddyPlatform(host.platform, host.arch)
  if (!host.regularFile(join(directory, 'manifest.json'))) {
    prerequisite(
      'Bundled Caddy is missing from this dsh-auth install.',
      'CADDY_PACKAGE_MISSING',
      'Reinstall dsh-auth from the official tarball. Setup never downloads Caddy from the network.',
    )
  }
  const manifest = readManifest(host, directory)
  if (manifest.caddyVersion !== CADDY_VERSION || manifest.packageRevision !== 'dsh.1') {
    prerequisite('Bundled Caddy revision does not match the frozen edge runtime.', 'CADDY_PACKAGE_VERSION', `Use dsh-auth with Caddy ${CADDY_VERSION} (dsh.1).`)
  }
  if (!host.regularFile(join(directory, 'LICENSE')) || !host.regularFile(join(directory, 'THIRD_PARTY.md'))) {
    prerequisite('Bundled Caddy is missing LICENSE or third-party notices.', 'CADDY_LICENSE_MISSING', 'Reinstall dsh-auth.')
  }
  if (typeof manifest.licenseSha256 !== 'string' || !sha256Hex(manifest.licenseSha256) || digest(host.readFileBytes(join(directory, 'LICENSE'))) !== manifest.licenseSha256) {
    prerequisite('Bundled Caddy LICENSE does not match the manifest checksum.', 'CADDY_LICENSE_MISSING', 'Reinstall dsh-auth.')
  }
  const platforms = manifest.platforms
  if (platforms === null || typeof platforms !== 'object' || Array.isArray(platforms)) {
    prerequisite('Bundled Caddy manifest platforms are invalid.', 'CADDY_PACKAGE_INVALID', 'Reinstall dsh-auth.')
  }
  const entry = (platforms as Record<string, unknown>)[selected]
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    prerequisite('Bundled Caddy is missing the current architecture.', 'CADDY_PACKAGE_INVALID', 'Reinstall the complete dsh-auth tarball that includes linux-x64 and linux-arm64 binaries.')
  }
  const platformEntry = entry as Record<string, unknown>
  if (platformEntry.executable !== `${selected}/caddy` || typeof platformEntry.binarySha256 !== 'string' || !sha256Hex(platformEntry.binarySha256)) {
    prerequisite('Bundled Caddy manifest fields are invalid.', 'CADDY_PACKAGE_INVALID', 'Reinstall dsh-auth.')
  }
  const executable = join(directory, selected, 'caddy')
  if (!host.regularFile(executable) || digest(host.readFileBytes(executable)) !== platformEntry.binarySha256) {
    prerequisite('Bundled Caddy binary is missing or does not match the checksum.', 'CADDY_BINARY_CHECKSUM', 'Reinstall dsh-auth. Setup never downloads Caddy.')
  }
  return { name: selected, directory, executable, binarySha256: platformEntry.binarySha256 }
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
