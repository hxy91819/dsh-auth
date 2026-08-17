#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { StringDecoder } from 'node:string_decoder'
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from 'node:process'
import { hashPassword } from './password.js'
import { discoverHost, discoverPackageManager } from './installer/discovery.js'
import { buildDoctorPlan, doctorExitCode } from './installer/doctor.js'
import { InstallerError } from './installer/errors.js'
import { executeSetup, type SetupSecrets } from './installer/executor.js'
import { NodeInstallerHost } from './installer/host.js'
import { discoverNginx } from './installer/nginx.js'
import { prepareSetup } from './installer/plan.js'
import { executeUninstall, prepareUninstall } from './installer/uninstall.js'
import { ExitCode, type InstallationPlan, type InstallerHost, type PasswordSource, type SetupRequest } from './installer/types.js'
import { validateSetupRequest } from './installer/validation.js'

const HELP = `Usage:
  dsh-auth setup [options]
  dsh-auth plan [options]
  dsh-auth doctor [--json]
  dsh-auth uninstall [--dry-run] [--authorize-uninstall] [--json]
  dsh-auth hash [--stdin]
  dsh-auth secret

Setup options:
  --non-interactive                 require flags instead of prompts
  --json                            emit one machine-readable JSON document
  --dry-run                         alias for the plan command
  --nginx require|install|skip      explicit Nginx policy
  --authorize-nginx-install         authorize supported OS package commands
  --dsh-service NAME.service        exact existing DSH Web systemd unit
  --dsh-home /absolute/path         Harness home when service discovery cannot infer it
  --dsh-bin /absolute/path          DSH executable when service discovery cannot infer it
  --profile NAME                    DSH profile (default: web)
  --package dsh-auth@VERSION|/x.tgz pinned registry or offline source
  --user-id ID --username NAME      configured account identity
  --roles ID[,ID...]                roles (default: admin)
  --password-stdin                  read the password from stdin
  --password-file /absolute/path    read a 0600 plaintext secret file
  --mode https|http                 public edge mode
  --upstream 127.0.0.1:PORT         loopback DSH listener (default: 127.0.0.1:3080)
  --listen-address IP               edge bind address
  --http-port PORT                  HTTP/redirect port
  --https-port PORT                 HTTPS port
  --server-name HOST                required HTTPS hostname
  --certificate /absolute/path      required HTTPS certificate
  --certificate-key /absolute/path  required HTTPS private key
  --output-dir /absolute/path       render offline/container files; requires --nginx skip

Plain HTTP is accepted only on loopback or RFC1918/ULA addresses. Nginx package
installation and uninstall each require their exact authorization flag in
non-interactive mode; --yes and inline password options do not exist.
`

interface CliIo {
  readonly interactive: boolean
  writeOut(value: string): void
  writeError(value: string): void
  readLine(prompt: string): Promise<string>
  readHidden(prompt: string): Promise<string>
  readStdin(): Promise<string>
}

class ProcessCliIo implements CliIo {
  readonly interactive = processStdin.isTTY && processStdout.isTTY

  writeOut(value: string): void {
    processStdout.write(value)
  }

  writeError(value: string): void {
    processStderr.write(value)
  }

  async readLine(prompt: string): Promise<string> {
    const line = createInterface({ input: processStdin, output: processStdout })
    try {
      return await line.question(prompt)
    } finally {
      line.close()
    }
  }

  readHidden(prompt: string): Promise<string> {
    if (!this.interactive) return Promise.reject(new InstallerError('interactive password input requires a TTY', ExitCode.usage))
    return new Promise((resolve, reject) => {
      let value = ''
      const decoder = new StringDecoder('utf8')
      const cleanup = (): void => {
        processStdin.setRawMode(false)
        processStdin.pause()
        processStdin.off('data', onData)
      }
      const onData = (chunk: Buffer): void => {
        for (const character of decoder.write(chunk)) {
          const code = character.codePointAt(0)
          if (code === 3) {
            cleanup()
            processStdout.write('\n')
            reject(new InstallerError('cancelled', ExitCode.cancelled))
            return
          }
          if (code === 13 || code === 10) {
            cleanup()
            processStdout.write('\n')
            resolve(value)
            return
          }
          if (code === 127 || code === 8) {
            value = Array.from(value).slice(0, -1).join('')
            continue
          }
          if (code !== undefined && code >= 32) value += character
        }
      }
      processStdout.write(prompt)
      processStdin.setRawMode(true)
      processStdin.resume()
      processStdin.on('data', onData)
    })
  }

  async readStdin(): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of processStdin as AsyncIterable<Buffer | string>) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '')
  }
}

interface ParsedArguments {
  readonly command?: string
  readonly values: ReadonlyMap<string, string>
  readonly flags: ReadonlySet<string>
}

const VALUE_OPTIONS = new Set([
  '--nginx', '--dsh-service', '--dsh-home', '--dsh-bin', '--profile', '--package', '--user-id', '--username', '--roles',
  '--password-file', '--mode', '--upstream', '--listen-address', '--http-port', '--https-port', '--server-name', '--certificate',
  '--certificate-key', '--output-dir',
])
const BOOLEAN_OPTIONS = new Set(['--non-interactive', '--json', '--dry-run', '--authorize-nginx-install', '--authorize-uninstall', '--password-stdin', '--help'])

function parseArguments(argv: readonly string[]): ParsedArguments {
  const [command, ...tokens] = argv
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (VALUE_OPTIONS.has(token)) {
      if (values.has(token)) throw new InstallerError(`duplicate option ${token}`, ExitCode.usage)
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('--')) throw new InstallerError(`${token} requires a value`, ExitCode.usage)
      values.set(token, value)
      index += 1
      continue
    }
    if (BOOLEAN_OPTIONS.has(token)) {
      if (flags.has(token)) throw new InstallerError(`duplicate option ${token}`, ExitCode.usage)
      flags.add(token)
      continue
    }
    throw new InstallerError(`unknown option ${token}`, ExitCode.usage)
  }
  return { ...(command === undefined ? {} : { command }), values, flags }
}

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { readonly version?: unknown }
  if (typeof manifest.version !== 'string') throw new InstallerError('package version is unavailable', ExitCode.execution)
  return manifest.version
}

function numberOption(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new InstallerError(`${label} must be an integer`, ExitCode.usage)
  return parsed
}

function enumOption<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined
  if (!allowed.includes(value as T)) throw new InstallerError(`${label} must be one of ${allowed.join(', ')}`, ExitCode.usage)
  return value as T
}

async function requiredInteractive(io: CliIo, current: string | undefined, prompt: string): Promise<string> {
  if (current !== undefined && current.length > 0) return current
  const value = (await io.readLine(prompt)).trim()
  if (value.length === 0) throw new InstallerError('a required interactive value was empty', ExitCode.usage)
  return value
}

async function setupRequest(parsed: ParsedArguments, io: CliIo, host: InstallerHost, interactive: boolean): Promise<SetupRequest> {
  const values = parsed.values
  const outputDirectory = values.get('--output-dir')
  let dshService = values.get('--dsh-service')
  let mode = enumOption(values.get('--mode'), ['https', 'http'] as const, 'mode')
  let nginxPolicy = enumOption(values.get('--nginx'), ['require', 'install', 'skip'] as const, 'nginx policy')
  let userId = values.get('--user-id')
  let username = values.get('--username')
  let listenAddress = values.get('--listen-address')
  let serverName = values.get('--server-name')
  let certificate = values.get('--certificate')
  let certificateKey = values.get('--certificate-key')

  if (interactive) {
    if (outputDirectory === undefined) dshService = await requiredInteractive(io, dshService, 'Existing DSH Web systemd unit: ')
    userId ??= (await io.readLine('Stable user id [admin]: ')).trim() || 'admin'
    username ??= (await io.readLine('Login username [admin]: ')).trim() || 'admin'
    mode ??= enumOption((await io.readLine('Edge mode (https/http) [https]: ')).trim() || 'https', ['https', 'http'] as const, 'mode')
    if (nginxPolicy === undefined) {
      if (outputDirectory !== undefined) nginxPolicy = 'skip'
      else nginxPolicy = discoverNginx(host).installed ? 'require' : 'install'
    }
    if (mode === 'https') {
      listenAddress = listenAddress ?? ((await io.readLine('HTTPS listen address [0.0.0.0]: ')).trim() || '0.0.0.0')
      serverName = await requiredInteractive(io, serverName, 'Public HTTPS hostname: ')
      certificate = await requiredInteractive(io, certificate, 'TLS certificate absolute path: ')
      certificateKey = await requiredInteractive(io, certificateKey, 'TLS certificate key absolute path: ')
    } else {
      listenAddress = await requiredInteractive(io, listenAddress, 'Trusted-network HTTP listen address: ')
    }
  }

  if (mode === undefined || nginxPolicy === undefined || userId === undefined || username === undefined || listenAddress === undefined) {
    throw new InstallerError('non-interactive setup requires --mode, --nginx, --user-id, --username, and --listen-address', ExitCode.usage)
  }
  if (outputDirectory === undefined && dshService === undefined) throw new InstallerError('non-interactive system setup requires --dsh-service', ExitCode.usage)
  const passwordFile = values.get('--password-file')
  const passwordStdin = parsed.flags.has('--password-stdin')
  if (passwordFile !== undefined && passwordStdin) throw new InstallerError('choose exactly one password input source', ExitCode.usage)
  const passwordSource: PasswordSource | undefined = passwordFile !== undefined
    ? { kind: 'file', path: passwordFile }
    : passwordStdin ? { kind: 'stdin' } : interactive ? { kind: 'interactive' } : undefined
  const dshHome = values.get('--dsh-home')
  const dshExecutable = values.get('--dsh-bin')
  return validateSetupRequest({
    mode,
    nginxPolicy,
    authorizeNginxInstall: parsed.flags.has('--authorize-nginx-install'),
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(dshService === undefined ? {} : { dshService }),
    ...(dshHome === undefined ? {} : { dshHome }),
    ...(dshExecutable === undefined ? {} : { dshExecutable }),
    profile: values.get('--profile') ?? 'web',
    packageSource: values.get('--package') ?? `dsh-auth@${packageVersion()}`,
    userId,
    username,
    roles: (values.get('--roles') ?? 'admin').split(',').map(value => value.trim()).filter(Boolean),
    upstream: values.get('--upstream') ?? '127.0.0.1:3080',
    listenAddress,
    httpPort: numberOption(values.get('--http-port'), mode === 'http' ? 8080 : 80, 'HTTP port'),
    httpsPort: numberOption(values.get('--https-port'), 443, 'HTTPS port'),
    ...(serverName === undefined ? {} : { serverName }),
    ...(certificate === undefined ? {} : { certificate }),
    ...(certificateKey === undefined ? {} : { certificateKey }),
    ...(passwordSource === undefined ? {} : { passwordSource }),
  })
}

function renderPlan(plan: InstallationPlan): string {
  const lines = [`${plan.operation}: ${plan.status}`]
  for (const diagnostic of plan.diagnostics) {
    lines.push(`[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`)
    if (diagnostic.remediation !== undefined) lines.push(`  Remediation: ${diagnostic.remediation}`)
  }
  for (const [index, action] of plan.actions.entries()) {
    const target = action.target === undefined ? '' : ` (${action.target})`
    const command = action.command === undefined ? '' : `: ${[action.command.executable, ...action.command.args].join(' ')}`
    lines.push(`${String(index + 1)}. ${action.description}${target}${command}`)
  }
  return `${lines.join('\n')}\n`
}

function jsonOutput(command: string, status: string, exitCode: number, plan?: InstallationPlan): string {
  return `${JSON.stringify({ schemaVersion: 1, command, status, exitCode, ...(plan === undefined ? {} : { plan }) })}\n`
}

function setupSecrets(io: CliIo, host: InstallerHost, source: PasswordSource | undefined): SetupSecrets {
  return {
    async readPassword(): Promise<string> {
      if (source === undefined) throw new InstallerError('setup requires --password-stdin or --password-file', ExitCode.usage)
      if (source.kind === 'stdin') return await io.readStdin()
      if (source.kind === 'interactive') {
        const first = await io.readHidden('Password: ')
        const second = await io.readHidden('Confirm password: ')
        if (first !== second) throw new InstallerError('passwords do not match', ExitCode.usage)
        return first
      }
      if (!host.regularFile(source.path)) throw new InstallerError('password file is not a readable regular file', ExitCode.usage)
      const mode = host.stat(source.path).mode & 0o777
      if ((mode & 0o077) !== 0) throw new InstallerError('password file must not be accessible by group or others', ExitCode.permission)
      const bytes = host.readFileBytes(source.path)
      if (bytes.length > 16 * 1024) throw new InstallerError('password input is too large', ExitCode.usage)
      return bytes.toString('utf8').replace(/\r?\n$/u, '')
    },
  }
}

function validatePasswordSource(host: InstallerHost, source: PasswordSource | undefined): void {
  if (source === undefined) throw new InstallerError('setup requires --password-stdin or --password-file', ExitCode.usage)
  if (source.kind !== 'file') return
  if (!host.regularFile(source.path)) throw new InstallerError('password file is not a readable regular file', ExitCode.usage)
  const stat = host.stat(source.path)
  if ((stat.mode & 0o077) !== 0) throw new InstallerError('password file must not be accessible by group or others', ExitCode.permission)
  if (stat.size === 0 || stat.size > 16 * 1024 + 1) throw new InstallerError('password file must contain 1-16385 bytes', ExitCode.usage)
}

async function runSetupOrPlan(parsed: ParsedArguments, io: CliIo, host: InstallerHost, command: 'setup' | 'plan'): Promise<number> {
  const invalid = [...parsed.flags].filter(option => option === '--authorize-uninstall')
  if (invalid.length > 0) throw new InstallerError(`${command} does not accept ${invalid.join(', ')}`, ExitCode.usage)
  const json = parsed.flags.has('--json')
  const interactive = io.interactive && !parsed.flags.has('--non-interactive') && !json
  let request = await setupRequest(parsed, io, host, interactive)
  let discovery = discoverHost(host, {
    ...(request.dshService === undefined ? {} : { dshService: request.dshService }),
    ...(request.dshHome === undefined ? {} : { dshHome: request.dshHome }),
    ...(request.dshExecutable === undefined ? {} : { dshExecutable: request.dshExecutable }),
    output: request.outputDirectory !== undefined,
  })

  if (interactive && command === 'setup' && request.nginxPolicy === 'install' && !discovery.nginx.installed) {
    const packageManager = discoverPackageManager(host)
    if (packageManager !== undefined) {
      io.writeOut(`Nginx is missing. dsh-auth will use ${packageManager.source} with these fixed commands:\n`)
      for (const item of packageManager.commands) io.writeOut(`  ${item.executable} ${item.args.join(' ')}\n`)
      io.writeOut('This changes system packages and requires root. No curl|sh or third-party repository is used.\n')
      const confirmation = (await io.readLine('Type install-nginx to authorize these commands: ')).trim()
      if (confirmation !== 'install-nginx') {
        io.writeOut('Cancelled before any write. Later command: sudo dsh-auth setup --nginx install --authorize-nginx-install\n')
        return ExitCode.cancelled
      }
      request = { ...request, authorizeNginxInstall: true }
      discovery = discoverHost(host, {
        ...(request.dshService === undefined ? {} : { dshService: request.dshService }),
        ...(request.dshHome === undefined ? {} : { dshHome: request.dshHome }),
        ...(request.dshExecutable === undefined ? {} : { dshExecutable: request.dshExecutable }),
        output: request.outputDirectory !== undefined,
      })
    }
  }

  const execute = command === 'setup'
  const prepared = prepareSetup(host, request, discovery, { execute })
  if (command === 'plan') {
    const exitCode = prepared.plan.status === 'blocked' ? ExitCode.prerequisite : ExitCode.success
    io.writeOut(json ? jsonOutput('plan', prepared.plan.status, exitCode, prepared.plan) : renderPlan(prepared.plan))
    return exitCode
  }
  if (prepared.plan.status === 'blocked') throw new InstallerError('setup prerequisites are not satisfied', ExitCode.prerequisite, prepared.plan.diagnostics)
  if (prepared.plan.status === 'ready') validatePasswordSource(host, request.passwordSource)
  if (interactive && prepared.plan.status === 'ready') {
    io.writeOut(renderPlan(prepared.plan))
    const confirmation = (await io.readLine('Type install to apply this exact plan: ')).trim()
    if (confirmation !== 'install') {
      io.writeOut('Cancelled before any write. Run dsh-auth plan with the same values to review again.\n')
      return ExitCode.cancelled
    }
  }
  await executeSetup(host, prepared, setupSecrets(io, host, request.passwordSource))
  io.writeOut(json ? jsonOutput('setup', prepared.plan.status === 'unchanged' ? 'unchanged' : 'success', ExitCode.success, prepared.plan) : `dsh-auth setup ${prepared.plan.status === 'unchanged' ? 'is unchanged' : 'completed'} successfully.\n`)
  return ExitCode.success
}

async function runLegacy(parsed: ParsedArguments, io: CliIo): Promise<number> {
  const command = parsed.command
  if (command === 'secret' && parsed.values.size === 0 && parsed.flags.size === 0) {
    io.writeOut(`${randomBytes(32).toString('base64url')}\n`)
    return ExitCode.success
  }
  if (command === 'hash') {
    const unexpected = [...parsed.values.keys(), ...parsed.flags].filter(option => option !== '--password-stdin')
    if (unexpected.length > 0) throw new InstallerError('hash accepts only --stdin', ExitCode.usage)
    const stdin = parsed.flags.has('--password-stdin')
    const first = stdin ? await io.readStdin() : await io.readHidden('Password: ')
    if (first.length === 0) throw new InstallerError('password must not be empty', ExitCode.usage)
    if (Buffer.byteLength(first, 'utf8') > 16 * 1024) throw new InstallerError('password input is too large', ExitCode.usage)
    if (!stdin) {
      const second = await io.readHidden('Confirm password: ')
      if (first !== second) throw new InstallerError('passwords do not match', ExitCode.usage)
    }
    io.writeOut(`${await hashPassword(first)}\n`)
    return ExitCode.success
  }
  throw new InstallerError('unknown command', ExitCode.usage)
}

/** Execute the public CLI against injectable I/O and host operations. */
export async function runCli(argv: readonly string[], io: CliIo = new ProcessCliIo(), host: InstallerHost = new NodeInstallerHost()): Promise<number> {
  let parsed: ParsedArguments
  try {
    const normalized = argv[0] === '--help'
      ? ['help']
      : argv[0] === 'hash' && argv[1] === '--stdin' ? ['hash', '--password-stdin', ...argv.slice(2)] : argv
    parsed = parseArguments(normalized)
    if (parsed.flags.has('--help') || parsed.command === undefined || parsed.command === 'help') {
      io.writeOut(HELP)
      return ExitCode.success
    }
    if (parsed.command === 'setup' || parsed.command === 'plan') {
      const command = parsed.command === 'setup' && parsed.flags.has('--dry-run') ? 'plan' : parsed.command
      return await runSetupOrPlan(parsed, io, host, command)
    }
    if (parsed.command === 'doctor') {
      const unknown = [...parsed.values.keys(), ...parsed.flags].filter(option => option !== '--json')
      if (unknown.length > 0) throw new InstallerError('doctor accepts only --json', ExitCode.usage)
      const { plan } = buildDoctorPlan(host)
      const exitCode = doctorExitCode(plan)
      io.writeOut(parsed.flags.has('--json') ? jsonOutput('doctor', plan.status === 'ready' ? 'healthy' : 'unhealthy', exitCode, plan) : renderPlan(plan))
      return exitCode
    }
    if (parsed.command === 'uninstall') {
      const unknown = [...parsed.values.keys(), ...parsed.flags].filter(option => !['--json', '--dry-run', '--authorize-uninstall', '--non-interactive'].includes(option))
      if (unknown.length > 0) throw new InstallerError('uninstall accepts only --dry-run, --authorize-uninstall, and --json', ExitCode.usage)
      const result = prepareUninstall(host)
      const json = parsed.flags.has('--json')
      if (parsed.flags.has('--dry-run') || result.plan.status === 'unchanged') {
        io.writeOut(json ? jsonOutput('uninstall', result.plan.status, ExitCode.success, result.plan) : renderPlan(result.plan))
        return ExitCode.success
      }
      if (result.state === undefined) return ExitCode.success
      if (io.interactive && !parsed.flags.has('--non-interactive') && !json) {
        io.writeOut(renderPlan(result.plan))
        if ((await io.readLine('Type uninstall to remove only the recorded files: ')).trim() !== 'uninstall') return ExitCode.cancelled
      } else if (!parsed.flags.has('--authorize-uninstall')) {
        throw new InstallerError('non-interactive uninstall requires --authorize-uninstall', ExitCode.usage)
      }
      executeUninstall(host, result.state)
      io.writeOut(json ? jsonOutput('uninstall', 'success', ExitCode.success, result.plan) : 'dsh-auth uninstall completed; shared Nginx packages were retained.\n')
      return ExitCode.success
    }
    return await runLegacy(parsed, io)
  } catch (error) {
    const json = argv.includes('--json')
    const failure = error instanceof InstallerError ? error : new InstallerError(error instanceof Error ? error.message : String(error), ExitCode.execution)
    if (json) io.writeOut(`${JSON.stringify({ schemaVersion: 1, command: argv[0] ?? 'help', status: 'error', exitCode: failure.exitCode, message: failure.message, diagnostics: failure.diagnostics })}\n`)
    else {
      io.writeError(`dsh-auth: ${failure.message}\n`)
      for (const diagnostic of failure.diagnostics) {
        io.writeError(`  ${diagnostic.code}: ${diagnostic.message}\n`)
        if (diagnostic.remediation !== undefined) io.writeError(`  Remediation: ${diagnostic.remediation}\n`)
      }
    }
    return failure.exitCode
  }
}

if (process.argv[1] !== undefined) {
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
      process.exitCode = await runCli(process.argv.slice(2))
    }
  } catch {
    // Importers and broken launch paths leave execution to their caller.
  }
}
