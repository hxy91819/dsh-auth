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
import { resetManagedPassword } from './installer/reset-password.js'
import { executeUninstall, prepareUninstall } from './installer/uninstall.js'
import { ExitCode, type InstallationPlan, type InstallerHost, type PasswordSource, type SetupRequest } from './installer/types.js'
import { validateAbsolutePath, validateSetupRequest } from './installer/validation.js'

const HELP = `Usage:
  dsh-auth --help
  dsh-auth --version
  dsh-auth setup [options]
  dsh-auth plan [options]
  dsh-auth doctor [--json]
  dsh-auth reset-password [--non-interactive] [--json]
                          [--password-stdin|--password-file PATH]
                          [--authorize-password-reset]
  dsh-auth uninstall [--non-interactive] [--json] [--dry-run]
                     [--authorize-uninstall]
  dsh-auth hash [--password-stdin]
  dsh-auth secret

Global options:
  --help, -h                        print this help and exit
  --version                         print the CLI version and exit
  --json                            emit one JSON document
  --non-interactive                 disable prompts on a TTY

Setup options:
  --dry-run                         alias for the plan command
  --nginx require|install|skip      Nginx policy (default: require; skip with --output-dir)
  --authorize-nginx-install         required when setup would install Nginx
  --dsh-service NAME.service        required for system setup; omit only with --output-dir
  --dsh-home /absolute/path         optional; Harness home when discovery cannot infer it
  --dsh-executable /absolute/path   optional; DSH executable when discovery cannot infer it
  --profile NAME                    optional DSH profile (default: web)
  --package dsh-auth@VERSION|/x.tgz optional pinned registry or offline source
  --user-id ID --username NAME      required account identity when not prompting
  --roles ID[,ID...]                optional comma-separated roles (default: admin)
  --password-stdin                  password from stdin; required for a ready setup
  --password-file /absolute/path    password from a 0600 secret file; choose one source
  --mode https|http                 public edge mode (default: https)
  --upstream 127.0.0.1:PORT         optional loopback DSH listener (default: 127.0.0.1:3080)
  --listen-address IP               edge bind address (default: 0.0.0.0 for HTTPS)
  --http-port PORT                  optional HTTP/redirect port (default: 80, or 8080 for HTTP)
  --https-port PORT                 optional HTTPS port (default: 443)
  --server-name HOST                required with --mode https
  --certificate /absolute/path      required with --mode https
  --certificate-key /absolute/path  required with --mode https
  --output-dir /absolute/path       optional offline/container files; implies --nginx skip

When stdin and stdout are TTYs and --non-interactive is not set, setup prompts
for missing values. Otherwise it requires --user-id and --username. System
setup also requires --dsh-service. HTTPS also requires --server-name,
--certificate, and --certificate-key. HTTP requires --listen-address. A ready
setup also requires exactly one of --password-stdin or --password-file; plan
and unchanged reruns do not.

Flags accept a space-separated --name value form or --name=value. Duplicate
flags and unknown flags fail with exit code 2. Global flags may precede the
command. --json does not disable prompts; automation must pass
--non-interactive.

Plain HTTP is accepted only on loopback or RFC1918/ULA addresses. Nginx package
installation and uninstall each require their exact authorization flag when
prompts are disabled. Password reset requires --authorize-password-reset when
prompts are disabled; --yes and inline password options do not exist.
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
  '--nginx', '--dsh-service', '--dsh-home', '--dsh-executable', '--profile', '--package', '--user-id', '--username', '--roles',
  '--password-file', '--mode', '--upstream', '--listen-address', '--http-port', '--https-port', '--server-name', '--certificate',
  '--certificate-key', '--output-dir',
])
const BOOLEAN_OPTIONS = new Set(['--non-interactive', '--json', '--dry-run', '--authorize-nginx-install', '--authorize-uninstall', '--authorize-password-reset', '--password-stdin', '--help', '-h', '--version'])

interface OptionToken {
  readonly name: string
  readonly inlineValue?: string
}

function optionToken(token: string): OptionToken {
  const separator = token.startsWith('--') ? token.indexOf('=') : -1
  return separator === -1
    ? { name: token }
    : { name: token.slice(0, separator), inlineValue: token.slice(separator + 1) }
}

function addValueOption(argv: readonly string[], index: number, option: OptionToken, values: Map<string, string>): number {
  if (values.has(option.name)) throw new InstallerError(`duplicate option ${option.name}`, ExitCode.usage)
  if (option.inlineValue !== undefined) {
    if (option.inlineValue.length === 0) throw new InstallerError(`${option.name} requires a value`, ExitCode.usage)
    values.set(option.name, option.inlineValue)
    return index
  }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('-')) throw new InstallerError(`${option.name} requires a value`, ExitCode.usage)
  values.set(option.name, value)
  return index + 1
}

function addBooleanOption(option: OptionToken, flags: Set<string>): void {
  if (option.inlineValue !== undefined) throw new InstallerError(`${option.name} does not take a value`, ExitCode.usage)
  if (flags.has(option.name)) throw new InstallerError(`duplicate option ${option.name}`, ExitCode.usage)
  flags.add(option.name)
}

function unknownOption(name: string): InstallerError {
  if (name === '--dsh-bin') return new InstallerError('unknown option --dsh-bin; use --dsh-executable', ExitCode.usage)
  if (name === '--stdin') return new InstallerError('unknown option --stdin; use --password-stdin', ExitCode.usage)
  return new InstallerError(`unknown option ${name}`, ExitCode.usage)
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  let command: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ''
    if (!token.startsWith('-')) {
      if (command !== undefined) throw new InstallerError(`unexpected argument ${token}`, ExitCode.usage)
      command = token
      continue
    }
    const option = optionToken(token)
    if (VALUE_OPTIONS.has(option.name)) {
      index = addValueOption(argv, index, option, values)
      continue
    }
    if (BOOLEAN_OPTIONS.has(option.name)) {
      addBooleanOption(option, flags)
      continue
    }
    throw unknownOption(option.name)
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

interface SetupInputs {
  readonly dshService: string | undefined
  readonly mode: 'https' | 'http' | undefined
  readonly nginxPolicy: 'require' | 'install' | 'skip' | undefined
  readonly userId: string | undefined
  readonly username: string | undefined
  readonly listenAddress: string | undefined
  readonly serverName: string | undefined
  readonly certificate: string | undefined
  readonly certificateKey: string | undefined
}

function parsedSetupInputs(parsed: ParsedArguments): SetupInputs {
  const values = parsed.values
  return {
    dshService: values.get('--dsh-service'),
    mode: enumOption(values.get('--mode'), ['https', 'http'] as const, 'mode'),
    nginxPolicy: enumOption(values.get('--nginx'), ['require', 'install', 'skip'] as const, 'nginx policy'),
    userId: values.get('--user-id'),
    username: values.get('--username'),
    listenAddress: values.get('--listen-address'),
    serverName: values.get('--server-name'),
    certificate: values.get('--certificate'),
    certificateKey: values.get('--certificate-key'),
  }
}

async function interactiveTlsInputs(io: CliIo, inputs: SetupInputs): Promise<SetupInputs> {
  if (inputs.mode !== 'https') {
    return { ...inputs, listenAddress: await requiredInteractive(io, inputs.listenAddress, 'Trusted-network HTTP listen address: ') }
  }
  return {
    ...inputs,
    listenAddress: inputs.listenAddress ?? ((await io.readLine('HTTPS listen address [0.0.0.0]: ')).trim() || '0.0.0.0'),
    serverName: await requiredInteractive(io, inputs.serverName, 'Public HTTPS hostname: '),
    certificate: await requiredInteractive(io, inputs.certificate, 'TLS certificate absolute path: '),
    certificateKey: await requiredInteractive(io, inputs.certificateKey, 'TLS certificate key absolute path: '),
  }
}

async function collectInteractiveSetupInputs(io: CliIo, host: InstallerHost, inputs: SetupInputs, output: boolean): Promise<SetupInputs> {
  const dshService = output ? inputs.dshService : await requiredInteractive(io, inputs.dshService, 'Existing DSH Web systemd unit: ')
  const userId = inputs.userId ?? ((await io.readLine('Stable user id [admin]: ')).trim() || 'admin')
  const username = inputs.username ?? ((await io.readLine('Login username [admin]: ')).trim() || 'admin')
  const mode = inputs.mode ?? enumOption((await io.readLine('Edge mode (https/http) [https]: ')).trim() || 'https', ['https', 'http'] as const, 'mode')
  const collected: SetupInputs = {
    ...inputs,
    dshService,
    userId,
    username,
    mode,
    nginxPolicy: inputs.nginxPolicy ?? (output ? 'skip' : discoverNginx(host).installed ? 'require' : 'install'),
  }
  return await interactiveTlsInputs(io, collected)
}

function assertRequiredSetupInputs(inputs: SetupInputs, output: boolean): asserts inputs is SetupInputs & {
  readonly mode: 'https' | 'http'
  readonly nginxPolicy: 'require' | 'install' | 'skip'
  readonly userId: string
  readonly username: string
  readonly listenAddress: string
} {
  if (inputs.userId === undefined || inputs.username === undefined) throw new InstallerError('non-interactive setup requires --user-id and --username', ExitCode.usage)
  if (inputs.listenAddress === undefined) throw new InstallerError('non-interactive HTTP setup requires --listen-address', ExitCode.usage)
  if (inputs.mode === undefined || inputs.nginxPolicy === undefined) throw new InstallerError('setup defaults could not be resolved', ExitCode.execution)
  if (!output && inputs.dshService === undefined) throw new InstallerError('non-interactive system setup requires --dsh-service', ExitCode.usage)
}

function withSetupDefaults(inputs: SetupInputs, output: boolean): SetupInputs {
  const mode = inputs.mode ?? 'https'
  return {
    ...inputs,
    mode,
    nginxPolicy: inputs.nginxPolicy ?? (output ? 'skip' : 'require'),
    listenAddress: inputs.listenAddress ?? (mode === 'https' ? '0.0.0.0' : undefined),
  }
}

async function setupRequest(parsed: ParsedArguments, io: CliIo, host: InstallerHost, interactive: boolean): Promise<SetupRequest> {
  const values = parsed.values
  const outputDirectory = values.get('--output-dir')
  const collected = interactive
    ? await collectInteractiveSetupInputs(io, host, parsedSetupInputs(parsed), outputDirectory !== undefined)
    : parsedSetupInputs(parsed)
  const inputs = withSetupDefaults(collected, outputDirectory !== undefined)
  assertRequiredSetupInputs(inputs, outputDirectory !== undefined)
  const passwordFile = values.get('--password-file')
  const passwordStdin = parsed.flags.has('--password-stdin')
  if (passwordFile !== undefined && passwordStdin) throw new InstallerError('choose exactly one password input source', ExitCode.usage)
  const passwordSource: PasswordSource | undefined = passwordFile !== undefined
    ? { kind: 'file', path: passwordFile }
    : passwordStdin ? { kind: 'stdin' } : interactive ? { kind: 'interactive' } : undefined
  const dshHome = values.get('--dsh-home')
  const dshExecutable = values.get('--dsh-executable')
  return validateSetupRequest({
    mode: inputs.mode,
    nginxPolicy: inputs.nginxPolicy,
    authorizeNginxInstall: parsed.flags.has('--authorize-nginx-install'),
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(inputs.dshService === undefined ? {} : { dshService: inputs.dshService }),
    ...(dshHome === undefined ? {} : { dshHome }),
    ...(dshExecutable === undefined ? {} : { dshExecutable }),
    profile: values.get('--profile') ?? 'web',
    packageSource: values.get('--package') ?? `dsh-auth@${packageVersion()}`,
    userId: inputs.userId,
    username: inputs.username,
    roles: (values.get('--roles') ?? 'admin').split(',').map(value => value.trim()).filter(Boolean),
    upstream: values.get('--upstream') ?? '127.0.0.1:3080',
    listenAddress: inputs.listenAddress,
    httpPort: numberOption(values.get('--http-port'), inputs.mode === 'http' ? 8080 : 80, 'HTTP port'),
    httpsPort: numberOption(values.get('--https-port'), 443, 'HTTPS port'),
    ...(inputs.serverName === undefined ? {} : { serverName: inputs.serverName }),
    ...(inputs.certificate === undefined ? {} : { certificate: inputs.certificate }),
    ...(inputs.certificateKey === undefined ? {} : { certificateKey: inputs.certificateKey }),
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

function setupSecrets(io: CliIo, host: InstallerHost, source: PasswordSource | undefined, operation = 'setup'): SetupSecrets {
  return {
    async readPassword(): Promise<string> {
      if (source === undefined) throw new InstallerError(`${operation} requires --password-stdin or --password-file`, ExitCode.usage)
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

function validatePasswordSource(host: InstallerHost, source: PasswordSource | undefined, operation = 'setup'): void {
  if (source === undefined) throw new InstallerError(`${operation} requires --password-stdin or --password-file`, ExitCode.usage)
  if (source.kind !== 'file') return
  validateAbsolutePath(source.path, 'password file')
  if (!host.regularFile(source.path)) throw new InstallerError('password file is not a readable regular file', ExitCode.usage)
  const stat = host.stat(source.path)
  if ((stat.mode & 0o077) !== 0) throw new InstallerError('password file must not be accessible by group or others', ExitCode.permission)
  if (stat.size === 0 || stat.size > 16 * 1024 + 1) throw new InstallerError('password file must contain 1-16385 bytes', ExitCode.usage)
}

function passwordSource(parsed: ParsedArguments, interactive: boolean): PasswordSource | undefined {
  const file = parsed.values.get('--password-file')
  const stdin = parsed.flags.has('--password-stdin')
  if (file !== undefined && stdin) throw new InstallerError('choose exactly one password input source', ExitCode.usage)
  if (file !== undefined) return { kind: 'file', path: file }
  if (stdin) return { kind: 'stdin' }
  return interactive ? { kind: 'interactive' } : undefined
}

async function runResetPassword(parsed: ParsedArguments, io: CliIo, host: InstallerHost): Promise<number> {
  const allowed = new Set(['--password-file', '--password-stdin', '--authorize-password-reset', '--non-interactive', '--json'])
  const unknown = [...parsed.values.keys(), ...parsed.flags].filter(option => !allowed.has(option))
  if (unknown.length > 0) throw new InstallerError(`reset-password does not accept ${unknown.join(', ')}`, ExitCode.usage)
  const json = parsed.flags.has('--json')
  const interactive = io.interactive && !parsed.flags.has('--non-interactive')
  const source = passwordSource(parsed, interactive)
  validatePasswordSource(host, source, 'reset-password')
  if (interactive) {
    io.writeOut('This replaces the managed password hash, rotates the session secret, revokes all current sessions, and restarts the DSH service when it is active.\n')
    if ((await io.readLine('Type reset-password to continue: ')).trim() !== 'reset-password') return ExitCode.cancelled
  } else if (!parsed.flags.has('--authorize-password-reset')) {
    throw new InstallerError('non-interactive password reset requires --authorize-password-reset', ExitCode.usage)
  }
  const reader = setupSecrets(io, host, source, 'reset-password')
  await resetManagedPassword(host, async () => await reader.readPassword())
  if (json) io.writeOut(`${JSON.stringify({ schemaVersion: 1, command: 'reset-password', status: 'success', exitCode: ExitCode.success, sessionsRevoked: true })}\n`)
  else io.writeOut('dsh-auth password reset completed; all existing sessions were revoked.\n')
  return ExitCode.success
}

function discoverSetupHost(host: InstallerHost, request: SetupRequest) {
  return discoverHost(host, {
    ...(request.dshService === undefined ? {} : { dshService: request.dshService }),
    ...(request.dshHome === undefined ? {} : { dshHome: request.dshHome }),
    ...(request.dshExecutable === undefined ? {} : { dshExecutable: request.dshExecutable }),
    output: request.outputDirectory !== undefined,
  })
}

async function authorizeInteractiveNginxInstall(
  io: CliIo,
  host: InstallerHost,
  request: SetupRequest,
): Promise<SetupRequest | undefined> {
  const packageManager = discoverPackageManager(host)
  if (packageManager === undefined) return request
  io.writeOut(`Nginx is missing. dsh-auth will use ${packageManager.source} with these fixed commands:\n`)
  for (const item of packageManager.commands) io.writeOut(`  ${item.executable} ${item.args.join(' ')}\n`)
  io.writeOut('This changes system packages and requires root. No curl|sh or third-party repository is used.\n')
  const confirmation = (await io.readLine('Type install-nginx to authorize these commands: ')).trim()
  if (confirmation === 'install-nginx') return { ...request, authorizeNginxInstall: true }
  io.writeOut('Cancelled before any write. Later command: sudo dsh-auth setup --nginx install --authorize-nginx-install\n')
  return undefined
}

function writePlanResult(io: CliIo, plan: InstallationPlan, json: boolean): number {
  const exitCode = plan.status === 'blocked' ? ExitCode.prerequisite : ExitCode.success
  io.writeOut(json ? jsonOutput('plan', plan.status, exitCode, plan) : renderPlan(plan))
  return exitCode
}

async function confirmInteractiveSetup(io: CliIo, plan: InstallationPlan): Promise<boolean> {
  io.writeOut(renderPlan(plan))
  const confirmation = (await io.readLine('Type install to apply this exact plan: ')).trim()
  if (confirmation === 'install') return true
  io.writeOut('Cancelled before any write. Run dsh-auth plan with the same values to review again.\n')
  return false
}

async function runSetupOrPlan(parsed: ParsedArguments, io: CliIo, host: InstallerHost, command: 'setup' | 'plan'): Promise<number> {
  const invalid = [...parsed.flags].filter(option => option === '--authorize-uninstall' || option === '--authorize-password-reset')
  if (invalid.length > 0) throw new InstallerError(`${command} does not accept ${invalid.join(', ')}`, ExitCode.usage)
  const json = parsed.flags.has('--json')
  const interactive = io.interactive && !parsed.flags.has('--non-interactive')
  let request = await setupRequest(parsed, io, host, interactive)
  let discovery = discoverSetupHost(host, request)

  if (interactive && command === 'setup' && request.nginxPolicy === 'install' && !discovery.nginx.installed) {
    const authorized = await authorizeInteractiveNginxInstall(io, host, request)
    if (authorized === undefined) return ExitCode.cancelled
    request = authorized
    discovery = discoverSetupHost(host, request)
  }

  const execute = command === 'setup'
  const prepared = prepareSetup(host, request, discovery, { execute })
  if (command === 'plan') return writePlanResult(io, prepared.plan, json)
  if (prepared.plan.status === 'blocked') throw new InstallerError('setup prerequisites are not satisfied', ExitCode.prerequisite, prepared.plan.diagnostics)
  if (prepared.plan.status === 'ready') validatePasswordSource(host, request.passwordSource)
  if (interactive && prepared.plan.status === 'ready' && !await confirmInteractiveSetup(io, prepared.plan)) return ExitCode.cancelled
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
    if (unexpected.length > 0) throw new InstallerError('hash accepts only --password-stdin', ExitCode.usage)
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

function assertAcceptedOptions(parsed: ParsedArguments, accepted: readonly string[], message: string): void {
  const unknown = [...parsed.values.keys(), ...parsed.flags].filter(option => !accepted.includes(option))
  if (unknown.length > 0) throw new InstallerError(message, ExitCode.usage)
}

function runDoctor(parsed: ParsedArguments, io: CliIo, host: InstallerHost): number {
  assertAcceptedOptions(parsed, ['--json'], 'doctor accepts only --json')
  const { plan } = buildDoctorPlan(host)
  const exitCode = doctorExitCode(plan)
  io.writeOut(parsed.flags.has('--json') ? jsonOutput('doctor', plan.status === 'ready' ? 'healthy' : 'unhealthy', exitCode, plan) : renderPlan(plan))
  return exitCode
}

async function authorizeUninstall(parsed: ParsedArguments, io: CliIo, plan: InstallationPlan): Promise<boolean> {
  if (io.interactive && !parsed.flags.has('--non-interactive')) {
    io.writeOut(renderPlan(plan))
    return (await io.readLine('Type uninstall to remove only the recorded files: ')).trim() === 'uninstall'
  }
  if (!parsed.flags.has('--authorize-uninstall')) {
    throw new InstallerError('non-interactive uninstall requires --authorize-uninstall', ExitCode.usage)
  }
  return true
}

async function runUninstall(parsed: ParsedArguments, io: CliIo, host: InstallerHost): Promise<number> {
  assertAcceptedOptions(parsed, ['--json', '--dry-run', '--authorize-uninstall', '--non-interactive'], 'uninstall accepts only --dry-run, --authorize-uninstall, --non-interactive, and --json')
  const result = prepareUninstall(host)
  const json = parsed.flags.has('--json')
  if (parsed.flags.has('--dry-run') || result.plan.status === 'unchanged') {
    io.writeOut(json ? jsonOutput('uninstall', result.plan.status, ExitCode.success, result.plan) : renderPlan(result.plan))
    return ExitCode.success
  }
  if (result.state === undefined) return ExitCode.success
  if (!await authorizeUninstall(parsed, io, result.plan)) return ExitCode.cancelled
  executeUninstall(host, result.state)
  io.writeOut(json ? jsonOutput('uninstall', 'success', ExitCode.success, result.plan) : 'dsh-auth uninstall completed; shared Nginx packages were retained.\n')
  return ExitCode.success
}

async function dispatchCommand(parsed: ParsedArguments, io: CliIo, host: InstallerHost): Promise<number> {
  if (parsed.flags.has('--help') || parsed.flags.has('-h') || parsed.command === 'help') {
    io.writeOut(HELP)
    return ExitCode.success
  }
  if (parsed.flags.has('--version')) {
    io.writeOut(`${packageVersion()}\n`)
    return ExitCode.success
  }
  if (parsed.command === undefined) {
    io.writeOut(HELP)
    return ExitCode.success
  }
  if (parsed.command === 'setup' || parsed.command === 'plan') {
    const command = parsed.command === 'setup' && parsed.flags.has('--dry-run') ? 'plan' : parsed.command
    return await runSetupOrPlan(parsed, io, host, command)
  }
  if (parsed.command === 'doctor') return runDoctor(parsed, io, host)
  if (parsed.command === 'reset-password') return await runResetPassword(parsed, io, host)
  if (parsed.command === 'uninstall') return await runUninstall(parsed, io, host)
  return await runLegacy(parsed, io)
}

function writeCliFailure(argv: readonly string[], io: CliIo, error: unknown): number {
  const failure = error instanceof InstallerError ? error : new InstallerError(error instanceof Error ? error.message : String(error), ExitCode.execution)
  if (argv.includes('--json')) {
    io.writeOut(`${JSON.stringify({ schemaVersion: 1, command: argv[0] ?? 'help', status: 'error', exitCode: failure.exitCode, message: failure.message, diagnostics: failure.diagnostics })}\n`)
    return failure.exitCode
  }
  io.writeError(`dsh-auth: ${failure.message}\n`)
  for (const diagnostic of failure.diagnostics) {
    io.writeError(`  ${diagnostic.code}: ${diagnostic.message}\n`)
    if (diagnostic.remediation !== undefined) io.writeError(`  Remediation: ${diagnostic.remediation}\n`)
  }
  return failure.exitCode
}

/** Execute the public CLI against injectable I/O and host operations. */
export async function runCli(argv: readonly string[], io: CliIo = new ProcessCliIo(), host: InstallerHost = new NodeInstallerHost()): Promise<number> {
  try {
    return await dispatchCommand(parseArguments(argv), io, host)
  } catch (error) {
    return writeCliFailure(argv, io, error)
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
