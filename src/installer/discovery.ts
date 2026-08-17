import { basename, dirname, join } from 'node:path'
import { InstallerError } from './errors.js'
import { discoverNginx } from './nginx.js'
import { ExitCode, type CommandSpec, type DshServiceDiscovery, type HostDiscovery, type InstallerHost, type PackageManagerDiscovery } from './types.js'
import { validateAbsolutePath, validateServiceName } from './validation.js'

function successful(host: InstallerHost, command: CommandSpec): string | undefined {
  const result = host.run(command)
  if (result.error !== undefined || result.status !== 0) return undefined
  return result.stdout.trim()
}

function parseOsRelease(contents: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>()
  for (const line of contents.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line)
    if (match === null) continue
    let value = match[2] ?? ''
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values.set(match[1] ?? '', value)
  }
  return values
}

/** Detect only package-manager combinations covered by the install contract. */
export function discoverPackageManager(host: InstallerHost): PackageManagerDiscovery | undefined {
  if (!host.regularFile('/etc/os-release')) return undefined
  const release = parseOsRelease(host.readFile('/etc/os-release'))
  const id = release.get('ID') ?? ''
  const version = release.get('VERSION_ID') ?? ''
  const aptSupported = id === 'ubuntu' && version === '24.04'
  if (aptSupported && host.regularFile('/usr/bin/apt-get')) {
    return {
      kind: 'apt-get',
      executable: '/usr/bin/apt-get',
      source: `${id} system repositories`,
      commands: [
        { executable: '/usr/bin/apt-get', args: ['update'] },
        { executable: '/usr/bin/apt-get', args: ['install', '--yes', 'nginx'] },
      ],
    }
  }
  return undefined
}

function systemctlPath(host: InstallerHost): string | undefined {
  return ['/usr/bin/systemctl', '/bin/systemctl'].find(candidate => host.regularFile(candidate))
}

function serviceProperty(host: InstallerHost, systemctl: string, service: string, property: string): string {
  return successful(host, { executable: systemctl, args: ['show', service, `--property=${property}`, '--value'] }) ?? ''
}

function numericIdentity(host: InstallerHost, flag: '-u' | '-g', user: string): number {
  const executable = ['/usr/bin/id', '/bin/id'].find(candidate => host.regularFile(candidate))
  if (executable === undefined) throw new InstallerError('id command is required', ExitCode.prerequisite)
  const output = successful(host, { executable, args: [flag, user] })
  const value = Number(output)
  if (output === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new InstallerError(`cannot resolve service identity ${user}`, ExitCode.prerequisite)
  }
  return value
}

function numericGroup(host: InstallerHost, group: string): number {
  const executable = ['/usr/bin/getent', '/bin/getent'].find(candidate => host.regularFile(candidate))
  if (executable === undefined) throw new InstallerError('getent is required to resolve the service group', ExitCode.prerequisite)
  const entry = successful(host, { executable, args: ['group', group] })
  const value = Number(entry?.split(':')[2])
  if (entry === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new InstallerError(`cannot resolve service group ${group}`, ExitCode.prerequisite)
  }
  return value
}

function serviceHome(host: InstallerHost, user: string): string | undefined {
  if (user === 'root') return '/root'
  const getent = ['/usr/bin/getent', '/bin/getent'].find(candidate => host.regularFile(candidate))
  if (getent === undefined) return undefined
  const entry = successful(host, { executable: getent, args: ['passwd', user] })
  const home = entry?.split(':')[5]
  return home?.startsWith('/') === true ? home : undefined
}

function dshPathFromExecStart(value: string): string | undefined {
  const candidates = value.match(/\/[A-Za-z0-9_./+-]+/gu) ?? []
  return candidates.find(candidate => basename(candidate) === 'dsh')
}

function environmentValue(environment: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}=([^\\s]+)`, 'u').exec(environment)
  return match?.[1]?.replace(/^"|"$/gu, '')
}

/** Inspect one explicit DSH service without modifying it. */
export function discoverDshService(
  host: InstallerHost,
  name: string,
  overrides: { readonly dshHome?: string; readonly dshExecutable?: string },
): DshServiceDiscovery {
  validateServiceName(name)
  const systemctl = systemctlPath(host)
  if (systemctl === undefined) throw new InstallerError('systemd is required for system setup', ExitCode.prerequisite)
  const loadState = serviceProperty(host, systemctl, name, 'LoadState')
  if (loadState !== 'loaded') {
    throw new InstallerError(`DSH service ${name} is not loaded`, ExitCode.prerequisite, [{
      code: 'DSH_SERVICE_NOT_FOUND',
      severity: 'error',
      message: `systemd unit ${name} is not loaded`,
      remediation: 'Create and verify the DSH Web systemd service, then pass its exact unit name with --dsh-service.',
    }])
  }
  const activeState = serviceProperty(host, systemctl, name, 'ActiveState')
  const user = serviceProperty(host, systemctl, name, 'User') || 'root'
  const group = serviceProperty(host, systemctl, name, 'Group') || user
  const environment = serviceProperty(host, systemctl, name, 'Environment')
  const execStart = serviceProperty(host, systemctl, name, 'ExecStart')
  const inferredExecutable = dshPathFromExecStart(execStart)
  const dshExecutable = validateAbsolutePath(overrides.dshExecutable ?? inferredExecutable ?? '', 'DSH executable')
  const home = serviceHome(host, user)
  const dshHome = validateAbsolutePath(overrides.dshHome ?? environmentValue(environment, 'DSH_HOME') ?? join(home ?? '', '.dsh'), 'DSH home')
  if (!host.regularFile(dshExecutable)) {
    throw new InstallerError('DSH executable is not a regular file', ExitCode.prerequisite)
  }
  const resolvedExecutable = host.realpath(dshExecutable)
  if (user === 'root') {
    assertRootOwnedExecutable(host, resolvedExecutable)
    assertRootOwnedDirectory(host, dshHome)
  }
  return {
    name,
    loadState,
    activeState,
    user,
    group,
    uid: numericIdentity(host, '-u', user),
    gid: numericGroup(host, group),
    dshExecutable: resolvedExecutable,
    dshHome,
  }
}

/** Reject a root service executable reachable through writable path components. */
export function assertRootOwnedExecutable(host: InstallerHost, executable: string): void {
  assertRootOwnedPath(host, executable, false)
}

/** Reject a root service data directory reachable through writable path components. */
export function assertRootOwnedDirectory(host: InstallerHost, path: string): void {
  assertRootOwnedPath(host, path, true)
}

function assertRootOwnedPath(host: InstallerHost, path: string, directory: boolean): void {
  let current = path
  for (;;) {
    const stat = host.stat(current)
    if ((current === path && stat.isDirectory !== directory) || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new InstallerError('root DSH service path must be root-owned and not group/world-writable', ExitCode.permission, [{
        code: 'UNSAFE_ROOT_SERVICE_PATH',
        severity: 'error',
        message: `unsafe root service path component: ${current}`,
        remediation: 'Keep the DSH executable, DSH_HOME, and profile tree under root-owned paths; do not load a user-writable checkout or plugin tree from a root service.',
      }])
    }
    if (current === '/') break
    current = dirname(current)
  }
}

/** Read all host facts needed by setup. */
export function discoverHost(host: InstallerHost, input: { readonly dshService?: string; readonly dshHome?: string; readonly dshExecutable?: string; readonly output: boolean }): HostDiscovery {
  const dshService = input.output || input.dshService === undefined
    ? undefined
    : discoverDshService(host, input.dshService, { ...(input.dshHome === undefined ? {} : { dshHome: input.dshHome }), ...(input.dshExecutable === undefined ? {} : { dshExecutable: input.dshExecutable }) })
  const packageManager = discoverPackageManager(host)
  return {
    platform: host.platform,
    effectiveUid: host.effectiveUid,
    nginx: discoverNginx(host),
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(dshService === undefined ? {} : { dshService }),
  }
}
