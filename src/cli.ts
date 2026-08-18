#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { StringDecoder } from 'node:string_decoder'
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from 'node:process'
import { assertAdministratorPassword, hashPassword } from './password.js'
import { parseArguments, renderHelp, type ParsedArguments } from './installer/cli-parser.js'
import { discoverHost } from './installer/discovery.js'
import { buildDoctorPlan, doctorExitCode } from './installer/doctor.js'
import { InstallerError } from './installer/errors.js'
import { executeSetup, type SetupSecrets } from './installer/executor.js'
import { NodeInstallerHost } from './installer/host.js'
import { prepareSetup } from './installer/plan.js'
import { resetManagedPassword } from './installer/reset-password.js'
import { executeUninstall, prepareUninstall } from './installer/uninstall.js'
import { ExitCode, type InstallationPlan, type InstallerHost, type PasswordSource, type SetupRequest } from './installer/types.js'
import { parseAdminBootstrap, parseLoginTokenPolicy, parseTlsMode, validateAbsolutePath, validateSetupRequest } from './installer/validation.js'

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
  readonly adminBootstrap: 'password' | 'login-token' | undefined
  readonly adminUsername: string | undefined
  readonly loginTokenEnabled: boolean | undefined
  readonly listenAddress: string | undefined
  readonly serverName: string | undefined
  readonly tls: 'automatic' | 'manual' | undefined
  readonly certificate: string | undefined
  readonly certificateKey: string | undefined
}

function parsedSetupInputs(parsed: ParsedArguments): SetupInputs {
  const values = parsed.values
  return {
    dshService: values.get('--dsh-service'),
    mode: enumOption(values.get('--mode'), ['https', 'http'] as const, 'mode'),
    adminBootstrap: parseAdminBootstrap(values.get('--admin-bootstrap')),
    adminUsername: values.get('--admin-username'),
    loginTokenEnabled: parseLoginTokenPolicy(values.get('--login-token')),
    listenAddress: values.get('--listen-address'),
    serverName: values.get('--server-name'),
    tls: parseTlsMode(values.get('--tls')),
    certificate: values.get('--certificate'),
    certificateKey: values.get('--certificate-key'),
  }
}

async function interactiveTlsInputs(io: CliIo, inputs: SetupInputs): Promise<SetupInputs> {
  if (inputs.mode !== 'https') {
    return { ...inputs, listenAddress: await requiredInteractive(io, inputs.listenAddress, 'Trusted-network HTTP listen address: ') }
  }
  const tls = inputs.tls ?? enumOption((await io.readLine('TLS mode (automatic/manual) [automatic]: ')).trim() || 'automatic', ['automatic', 'manual'] as const, 'tls')
  const withTls: SetupInputs = {
    ...inputs,
    tls,
    listenAddress: inputs.listenAddress ?? ((await io.readLine('HTTPS listen address [0.0.0.0]: ')).trim() || '0.0.0.0'),
    serverName: await requiredInteractive(io, inputs.serverName, 'Public HTTPS hostname: '),
  }
  if (tls !== 'manual') return withTls
  return {
    ...withTls,
    certificate: await requiredInteractive(io, inputs.certificate, 'TLS certificate absolute path: '),
    certificateKey: await requiredInteractive(io, inputs.certificateKey, 'TLS certificate key absolute path: '),
  }
}

async function collectInteractiveSetupInputs(io: CliIo, inputs: SetupInputs, output: boolean): Promise<SetupInputs> {
  const dshService = output ? inputs.dshService : await requiredInteractive(io, inputs.dshService, 'Existing DSH Web systemd unit: ')
  const adminBootstrap = inputs.adminBootstrap ?? parseAdminBootstrap(await requiredInteractive(io, undefined, 'Administrator bootstrap (password/login-token): '))
  const loginTokenEnabled = adminBootstrap === 'login-token'
    ? true
    : (inputs.loginTokenEnabled ?? parseLoginTokenPolicy((await io.readLine('Login tokens (enabled/disabled) [disabled]: ')).trim() || 'disabled'))
  const adminUsername = adminBootstrap === 'password'
    ? await requiredInteractive(io, inputs.adminUsername, 'Administrator username: ')
    : inputs.adminUsername
  const mode = inputs.mode ?? enumOption((await io.readLine('Edge mode (https/http) [https]: ')).trim() || 'https', ['https', 'http'] as const, 'mode')
  return await interactiveTlsInputs(io, {
    ...inputs,
    dshService,
    adminBootstrap,
    adminUsername,
    loginTokenEnabled,
    mode,
  })
}

function withSetupDefaults(inputs: SetupInputs): SetupInputs {
  const mode = inputs.mode ?? 'https'
  return {
    ...inputs,
    mode,
    listenAddress: inputs.listenAddress ?? (mode === 'https' ? '0.0.0.0' : undefined),
    tls: mode === 'https' ? (inputs.tls ?? 'automatic') : undefined,
    loginTokenEnabled: inputs.adminBootstrap === 'login-token' ? true : inputs.loginTokenEnabled,
  }
}

function assertRequiredSetupInputs(inputs: SetupInputs, output: boolean): asserts inputs is SetupInputs & {
  readonly mode: 'https' | 'http'
  readonly adminBootstrap: 'password' | 'login-token'
  readonly loginTokenEnabled: boolean
  readonly listenAddress: string
} {
  if (inputs.adminBootstrap === undefined || inputs.loginTokenEnabled === undefined) {
    throw new InstallerError('non-interactive setup requires --admin-bootstrap and --login-token', ExitCode.usage)
  }
  if (inputs.adminBootstrap === 'password' && inputs.adminUsername === undefined) {
    throw new InstallerError('non-interactive password setup requires --admin-username', ExitCode.usage)
  }
  if (inputs.listenAddress === undefined) throw new InstallerError('non-interactive HTTP setup requires --listen-address', ExitCode.usage)
  if (inputs.mode === undefined) throw new InstallerError('setup defaults could not be resolved', ExitCode.execution)
  if (!output && inputs.dshService === undefined) throw new InstallerError('non-interactive system setup requires --dsh-service', ExitCode.usage)
}

function passwordSourceFrom(parsed: ParsedArguments, interactive: boolean, bootstrap: 'password' | 'login-token'): PasswordSource | undefined {
  const passwordFile = parsed.values.get('--password-file')
  const passwordStdin = parsed.flags.has('--password-stdin')
  if (passwordFile !== undefined && passwordStdin) throw new InstallerError('choose exactly one password input source', ExitCode.usage)
  if (bootstrap === 'login-token' && (passwordFile !== undefined || passwordStdin)) {
    throw new InstallerError('--admin-bootstrap login-token does not accept a password source', ExitCode.usage)
  }
  if (passwordFile !== undefined) return { kind: 'file', path: passwordFile }
  if (passwordStdin) return { kind: 'stdin' }
  return bootstrap === 'password' && interactive ? { kind: 'interactive' } : undefined
}

async function setupRequest(parsed: ParsedArguments, io: CliIo, interactive: boolean): Promise<SetupRequest> {
  const values = parsed.values
  const outputDirectory = values.get('--output-dir')
  const collected = interactive
    ? await collectInteractiveSetupInputs(io, parsedSetupInputs(parsed), outputDirectory !== undefined)
    : parsedSetupInputs(parsed)
  const inputs = withSetupDefaults(collected)
  assertRequiredSetupInputs(inputs, outputDirectory !== undefined)
  const passwordSource = passwordSourceFrom(parsed, interactive, inputs.adminBootstrap)
  const dshHome = values.get('--dsh-home')
  const dshExecutable = values.get('--dsh-executable')
  const failureZh = values.get('--login-token-error-message-zh')
  const failureEn = values.get('--login-token-error-message-en')
  return validateSetupRequest({
    mode: inputs.mode,
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(inputs.dshService === undefined ? {} : { dshService: inputs.dshService }),
    ...(dshHome === undefined ? {} : { dshHome }),
    ...(dshExecutable === undefined ? {} : { dshExecutable }),
    profile: values.get('--profile') ?? 'web',
    packageSource: values.get('--package') ?? `dsh-auth@${packageVersion()}`,
    adminBootstrap: inputs.adminBootstrap,
    ...(inputs.adminUsername === undefined ? {} : { adminUsername: inputs.adminUsername }),
    loginTokenEnabled: inputs.loginTokenEnabled,
    ...(failureZh === undefined ? {} : { loginTokenErrorMessageZh: failureZh }),
    ...(failureEn === undefined ? {} : { loginTokenErrorMessageEn: failureEn }),
    upstream: values.get('--upstream') ?? '127.0.0.1:3080',
    listenAddress: inputs.listenAddress,
    httpPort: numberOption(values.get('--http-port'), inputs.mode === 'http' ? 8080 : 80, 'HTTP port'),
    httpsPort: numberOption(values.get('--https-port'), 443, 'HTTPS port'),
    ...(inputs.serverName === undefined ? {} : { serverName: inputs.serverName }),
    ...(inputs.tls === undefined ? {} : { tls: inputs.tls }),
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
  return `${JSON.stringify({ schemaVersion: 2, command, status, exitCode, ...(plan === undefined ? {} : { plan }) })}\n`
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
  if (json) io.writeOut(`${JSON.stringify({ schemaVersion: 2, command: 'reset-password', status: 'success', exitCode: ExitCode.success, sessionsRevoked: true })}\n`)
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
  const request = await setupRequest(parsed, io, interactive)
  const discovery = discoverSetupHost(host, request)
  const execute = command === 'setup'
  const prepared = prepareSetup(host, request, discovery, { execute })
  if (command === 'plan') return writePlanResult(io, prepared.plan, json)
  if (prepared.plan.status === 'blocked') throw new InstallerError('setup prerequisites are not satisfied', ExitCode.prerequisite, prepared.plan.diagnostics)
  if (prepared.plan.status === 'ready' && request.adminBootstrap === 'password') validatePasswordSource(host, request.passwordSource)
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
    if (!stdin) {
      const second = await io.readHidden('Confirm password: ')
      if (first !== second) throw new InstallerError('passwords do not match', ExitCode.usage)
    }
    try {
      assertAdministratorPassword(first)
    } catch (error) {
      throw new InstallerError(error instanceof Error ? error.message : 'password is invalid', ExitCode.usage)
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
  io.writeOut(json ? jsonOutput('uninstall', 'success', ExitCode.success, result.plan) : 'dsh-auth uninstall completed; the owned Caddy edge was removed.\n')
  return ExitCode.success
}

async function dispatchCommand(parsed: ParsedArguments, io: CliIo, host: InstallerHost): Promise<number> {
  if (parsed.flags.has('--help') || parsed.flags.has('-h') || parsed.command === 'help') {
    io.writeOut(renderHelp())
    return ExitCode.success
  }
  if (parsed.flags.has('--version')) {
    io.writeOut(`${packageVersion()}\n`)
    return ExitCode.success
  }
  if (parsed.command === undefined) {
    io.writeOut(renderHelp())
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
    io.writeOut(`${JSON.stringify({ schemaVersion: 2, command: argv[0] ?? 'help', status: 'error', exitCode: failure.exitCode, message: failure.message, diagnostics: failure.diagnostics })}\n`)
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
