import { InstallerError } from './errors.js'
import { ExitCode } from './types.js'

/** One public CLI flag declared once for parsing and help text. */
interface FlagDeclaration {
  readonly name: string
  readonly kind: 'boolean' | 'value'
  readonly global?: boolean
  readonly valueHint?: string
  readonly help: string
}

const FLAG_DECLARATIONS: readonly FlagDeclaration[] = [
  { name: '--help', kind: 'boolean', global: true, help: 'print this help and exit' },
  { name: '-h', kind: 'boolean', global: true, help: 'alias for --help' },
  { name: '--version', kind: 'boolean', global: true, help: 'print the CLI version and exit' },
  { name: '--json', kind: 'boolean', global: true, help: 'emit one JSON document' },
  { name: '--non-interactive', kind: 'boolean', global: true, help: 'disable prompts on a TTY' },
  { name: '--dry-run', kind: 'boolean', help: 'alias for the plan command' },
  { name: '--dsh-service', kind: 'value', valueHint: 'NAME.service', help: 'required for system setup; omit only with --output-dir' },
  { name: '--dsh-home', kind: 'value', valueHint: '/absolute/path', help: 'optional; Harness home when discovery cannot infer it' },
  { name: '--dsh-executable', kind: 'value', valueHint: '/absolute/path', help: 'optional; DSH executable when discovery cannot infer it' },
  { name: '--profile', kind: 'value', valueHint: 'NAME', help: 'optional DSH profile (default: web)' },
  { name: '--package', kind: 'value', valueHint: 'dsh-auth@VERSION|/x.tgz', help: 'optional pinned registry or offline source' },
  { name: '--admin-bootstrap', kind: 'value', valueHint: 'password|login-token', help: 'explicit administrator initialization' },
  { name: '--admin-username', kind: 'value', valueHint: 'NAME', help: 'required with --admin-bootstrap password' },
  { name: '--login-token', kind: 'value', valueHint: 'enabled|disabled', help: 'whether token issue and redeem stay available' },
  { name: '--login-token-error-message-zh', kind: 'value', valueHint: 'TEXT', help: 'optional 1-500 character Chinese token failure text' },
  { name: '--login-token-error-message-en', kind: 'value', valueHint: 'TEXT', help: 'optional 1-500 character English token failure text' },
  { name: '--password-stdin', kind: 'boolean', help: 'password from stdin; required for a ready password setup' },
  { name: '--password-file', kind: 'value', valueHint: '/absolute/path', help: 'password from a 0600 secret file; choose one source' },
  { name: '--mode', kind: 'value', valueHint: 'https|http', help: 'public edge mode (default: https)' },
  { name: '--behind-tls-proxy', kind: 'boolean', help: 'loopback HTTP behind a trusted TLS reverse proxy' },
  { name: '--authorize-insecure-address', kind: 'boolean', help: 'plain HTTP on an intranet address outside RFC1918/ULA' },
  { name: '--upstream', kind: 'value', valueHint: '127.0.0.1:PORT', help: 'optional loopback DSH listener (default: 127.0.0.1:3080)' },
  { name: '--listen-address', kind: 'value', valueHint: 'IP', help: 'Caddy bind address (default: 0.0.0.0 for HTTPS)' },
  { name: '--http-port', kind: 'value', valueHint: 'PORT', help: 'optional HTTP/redirect port (default: 80, or 8080 for HTTP)' },
  { name: '--https-port', kind: 'value', valueHint: 'PORT', help: 'optional HTTPS port (default: 443)' },
  { name: '--server-name', kind: 'value', valueHint: 'HOST', help: 'required with --mode https' },
  { name: '--tls', kind: 'value', valueHint: 'automatic|manual', help: 'HTTPS certificate source (default: automatic)' },
  { name: '--certificate', kind: 'value', valueHint: '/absolute/path', help: 'required with --tls manual' },
  { name: '--certificate-key', kind: 'value', valueHint: '/absolute/path', help: 'required with --tls manual' },
  { name: '--output-dir', kind: 'value', valueHint: '/absolute/path', help: 'optional offline/container files; skips systemd' },
  { name: '--ttl-seconds', kind: 'value', valueHint: '60..300', help: 'login token lifetime for issue-login-token (default: 300)' },
  { name: '--auth-state-file', kind: 'value', valueHint: '/absolute/path', help: 'explicit 0600 state file for container token issue' },
  { name: '--public-origin', kind: 'value', valueHint: 'ORIGIN', help: 'public origin for container or proxied system token issue' },
  { name: '--authorize-password-reset', kind: 'boolean', help: 'required for non-interactive password reset' },
  { name: '--authorize-uninstall', kind: 'boolean', help: 'required for non-interactive uninstall' },
  { name: '--authorize-upgrade', kind: 'boolean', help: 'required for non-interactive upgrade' },
  { name: '--authorize-login-token-issue', kind: 'boolean', help: 'required for non-interactive token issue' },
]

const VALUE_OPTIONS = new Set(FLAG_DECLARATIONS.filter(flag => flag.kind === 'value').map(flag => flag.name))
const BOOLEAN_OPTIONS = new Set(FLAG_DECLARATIONS.filter(flag => flag.kind === 'boolean').map(flag => flag.name))

const REMOVED_OPTIONS: Readonly<Record<string, string>> = {
  '--nginx': 'unknown option --nginx; v2 uses the bundled Caddy edge',
  '--authorize-nginx-install': 'unknown option --authorize-nginx-install; v2 does not install or reuse Nginx',
  '--user-id': 'unknown option --user-id; administrator id is fixed to admin',
  '--username': 'unknown option --username; use --admin-username',
  '--roles': 'unknown option --roles; administrator role is fixed to admin',
  '--dsh-bin': 'unknown option --dsh-bin; use --dsh-executable',
  '--stdin': 'unknown option --stdin; use --password-stdin',
}

export interface ParsedArguments {
  readonly command?: string
  readonly values: ReadonlyMap<string, string>
  readonly flags: ReadonlySet<string>
}

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
  return new InstallerError(REMOVED_OPTIONS[name] ?? `unknown option ${name}`, ExitCode.usage)
}

/** Parse argv using the frozen flag table. Global flags may precede the command. */
export function parseArguments(argv: readonly string[]): ParsedArguments {
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

const ISSUE_TOKEN_FLAGS = new Set(['--ttl-seconds', '--auth-state-file', '--public-origin', '--authorize-login-token-issue'])
const UPGRADE_FLAGS = new Set(['--authorize-upgrade'])

function flagLine(flag: FlagDeclaration): string {
  const name = flag.valueHint === undefined ? flag.name : `${flag.name} ${flag.valueHint}`
  return `  ${name.padEnd(35)} ${flag.help}`
}

/** Frozen usage text generated from the same flag declarations used by the parser. */
export function renderHelp(): string {
  const global = FLAG_DECLARATIONS.filter(flag => flag.global === true)
  const authorize = FLAG_DECLARATIONS.filter(flag => flag.name === '--authorize-password-reset' || flag.name === '--authorize-uninstall' || flag.name === '--authorize-upgrade' || flag.name === '--authorize-login-token-issue')
  const setup = FLAG_DECLARATIONS.filter(flag => flag.global !== true && !authorize.includes(flag) && !ISSUE_TOKEN_FLAGS.has(flag.name) && !UPGRADE_FLAGS.has(flag.name))
  const issueToken = FLAG_DECLARATIONS.filter(flag => ISSUE_TOKEN_FLAGS.has(flag.name))
  const upgrade = FLAG_DECLARATIONS.filter(flag => UPGRADE_FLAGS.has(flag.name))
  return `Usage:
  dsh-auth --help
  dsh-auth --version
  dsh-auth setup [options]
  dsh-auth plan [options]
  dsh-auth doctor [--json]
  dsh-auth upgrade [--package dsh-auth@VERSION|/x.tgz]
                  [--non-interactive] [--authorize-upgrade] [--json]
  dsh-auth reset-password [--non-interactive] [--json]
                          [--password-stdin|--password-file PATH]
                          [--authorize-password-reset]
  dsh-auth uninstall [--non-interactive] [--json] [--dry-run]
                     [--authorize-uninstall]
  dsh-auth issue-login-token [--ttl-seconds 60..300]
                             [--public-origin ORIGIN]
                             [--auth-state-file PATH]
                             [--non-interactive]
                             [--authorize-login-token-issue] [--json]
  dsh-auth hash [--password-stdin]
  dsh-auth secret

Global options:
${global.map(flagLine).join('\n')}

Setup options:
${setup.map(flagLine).join('\n')}

Upgrade options:
${upgrade.map(flagLine).join('\n')}

Issue login token options:
${issueToken.map(flagLine).join('\n')}

When stdin and stdout are TTYs and --non-interactive is not set, setup prompts
for missing values. Otherwise it requires --admin-bootstrap and --login-token.
Password initialization also requires --admin-username. System setup also
requires --dsh-service. HTTPS also requires --server-name. HTTP requires
--listen-address. A ready password setup also requires exactly one of
--password-stdin or --password-file; plan, login-token initialization, and
unchanged reruns do not.

upgrade moves a healthy v2 system installation to the build of this CLI: the
profile bundle, bundled Caddy, environment marker, ownership record, and
services move together or roll back together. The target version must be
higher than the installed one, downgrades are refused, and drift must be
repaired with dsh plugin --profile NAME add SPEC plus a healthy doctor before
upgrading. Interactive use asks for the exact word upgrade; non-interactive
use requires --non-interactive together with --authorize-upgrade.

issue-login-token prints a bearer login URL to stdout and nothing else. Without
--auth-state-file it derives paths from the recorded system installation and
requires root; a system installation behind a TLS proxy also requires the
current HTTPS --public-origin. With --auth-state-file it requires
--public-origin and accepts root or the state file owner. Interactive use asks for the exact word
issue-login-token; non-interactive use requires --non-interactive together with
--authorize-login-token-issue. The TTL defaults to 300 seconds and accepts
60-300.

Flags accept a space-separated --name value form or --name=value. Duplicate
flags and unknown flags fail with exit code 2. Global flags may precede the
command. --json does not disable prompts; automation must pass
--non-interactive.

Plain HTTP binds freely only on loopback or RFC1918/ULA addresses; another
intranet literal IP additionally requires --authorize-insecure-address. The
--behind-tls-proxy mode additionally requires loopback. Automatic
TLS rejects certificate parameters; manual TLS requires both. Uninstall
requires --authorize-uninstall when prompts are disabled. Password reset
requires --authorize-password-reset when prompts are disabled. Upgrade
requires --authorize-upgrade when prompts are disabled; --yes and
inline password options do not exist.
`
}

/** Public flag names used to freeze help coverage. */
export function declaredFlagNames(): readonly string[] {
  return FLAG_DECLARATIONS.map(flag => flag.name)
}
