/** Stable installer exit codes for automation. */
export const ExitCode = {
  success: 0,
  usage: 2,
  prerequisite: 3,
  conflict: 4,
  permission: 5,
  execution: 6,
  cancelled: 7,
  unhealthy: 8,
} as const

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]

/** Public edge mode. */
export type EdgeMode = 'https' | 'http'

/** Explicit administrator bootstrap selected at setup. */
export type AdminBootstrap = 'password' | 'login-token'

/** HTTPS certificate source. */
export type TlsMode = 'automatic' | 'manual'

/** DSH systemd service facts required by the installer. */
export interface DshServiceDiscovery {
  readonly name: string
  readonly loadState: string
  readonly activeState: string
  readonly user: string
  readonly group: string
  readonly uid: number
  readonly gid: number
  readonly dshExecutable: string
  readonly dshHome: string
}

/** Read-only host facts used to build an installation plan. */
export interface HostDiscovery {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly effectiveUid: number | undefined
  readonly dshService?: DshServiceDiscovery
}

/** Validated setup input shared by interactive and non-interactive callers. */
export interface SetupRequest {
  readonly mode: EdgeMode
  readonly behindTlsProxy?: boolean
  readonly outputDirectory?: string
  readonly dshService?: string
  readonly dshHome?: string
  readonly dshExecutable?: string
  readonly profile: string
  readonly packageSource: string
  readonly adminBootstrap: AdminBootstrap
  readonly adminUsername?: string
  readonly loginTokenEnabled: boolean
  readonly loginTokenErrorMessageZh?: string
  readonly loginTokenErrorMessageEn?: string
  readonly upstream: string
  readonly listenAddress: string
  readonly httpPort: number
  readonly httpsPort: number
  readonly serverName?: string
  readonly tls?: TlsMode
  readonly certificate?: string
  readonly certificateKey?: string
  readonly passwordSource?: PasswordSource
}

/** Password input descriptor. The password itself never enters a plan. */
export type PasswordSource =
  | { readonly kind: 'stdin' }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'interactive' }

/** Recorded facts describing the externally pre-installed profile package a setup adopts. */
export interface ProfilePackageFacts {
  readonly origin: 'external'
  readonly spec: string
  readonly version: string
  readonly buildIdentity: string
  readonly resolvedPath: string
}

/** Paths owned by one completed system or output installation. */
export interface ManagedPaths {
  readonly configDirectory: string
  readonly stateFile: string
  readonly environmentFile: string
  readonly sessionSecretFile: string
  readonly caddyfile: string
  readonly caddyBinary: string
  readonly caddyBinaryDirectory: string
  readonly caddyUnitFile: string
  readonly caddyStateDirectory: string
  readonly authStateDirectory: string
  readonly authStateFile: string
  readonly loginTokenDirectory: string
  readonly systemdDropInDirectory: string
  readonly systemdDropInFile: string
}

/** Persisted ownership and recovery record. It never contains secret material. */
export interface InstallState {
  readonly schemaVersion: 2
  readonly status: 'installing' | 'installed'
  readonly fingerprint: string
  readonly request: Omit<SetupRequest, 'passwordSource'>
  readonly paths: ManagedPaths
  readonly dshService: string
  readonly dshUser: string
  readonly dshUid: number
  readonly dshGid: number
  readonly dshHome: string
  readonly dshExecutable: string
  readonly publicOrigin: string
  readonly authStateFile: string
  readonly loginTokenEnabled: boolean
  readonly caddyVersion: string
  readonly caddyBinarySha256: string
  readonly profilePackageInstalledByDshAuth: boolean
  /** Facts about the profile package this installation relies on; all fields or none. */
  readonly profilePackageOrigin?: 'dsh-auth' | 'external'
  readonly profilePackageSpec?: string
  readonly profilePackageVersion?: string
  readonly profilePackageBuildIdentity?: string
  readonly profilePackagePath?: string
  readonly createdPaths: readonly string[]
  readonly activation?: {
    readonly dshWasActive: boolean
    readonly caddyWasActive: boolean
    readonly caddyWasEnabled: boolean
    readonly daemonReloadAttempted: boolean
    readonly dshRestartAttempted: boolean
    readonly caddyActivationAttempted: boolean
  }
}

/** Redacted action exposed in human and JSON plans. */
export interface PlanAction {
  readonly id: string
  readonly kind: 'check' | 'install-package' | 'create-directory' | 'write-file' | 'run-command' | 'remove-file'
  readonly description: string
  readonly target?: string
  readonly command?: CommandSpec
  readonly sensitive?: boolean
}

/** Stable, secret-free installation plan. */
export interface InstallationPlan {
  readonly schemaVersion: 2
  readonly operation: 'setup' | 'uninstall' | 'doctor' | 'upgrade'
  readonly mode: 'system' | 'output'
  readonly status: 'ready' | 'unchanged' | 'blocked'
  readonly actions: readonly PlanAction[]
  readonly diagnostics: readonly Diagnostic[]
  readonly fingerprint?: string
}

/** Structured operator diagnostic and remediation. */
export interface Diagnostic {
  readonly code: string
  readonly severity: 'info' | 'warning' | 'error'
  readonly message: string
  readonly remediation?: string
}

/** Internal setup artifact: public plan plus validated execution inputs. */
export interface PreparedSetup {
  readonly plan: InstallationPlan
  readonly request: SetupRequest
  readonly discovery: HostDiscovery
  readonly state?: InstallState
  readonly paths?: ManagedPaths
  readonly fingerprint?: string
  /** Present when the plan adopts an externally pre-installed same-build bundle. */
  readonly profilePackage?: ProfilePackageFacts
}

/** One argv-only subprocess invocation. */
export interface CommandSpec {
  readonly executable: string
  readonly args: readonly string[]
}

/** Captured subprocess result. */
export interface CommandResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: Error
}

/** Injectable host operations used by discovery and execution. */
export interface InstallerHost {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly effectiveUid: number | undefined
  run(command: CommandSpec, options?: { readonly env?: NodeJS.ProcessEnv }): CommandResult
  readFile(path: string): string
  readFileBytes(path: string): Buffer
  fileExists(path: string): boolean
  regularFile(path: string): boolean
  realpath(path: string): string
  listDirectory(path: string): readonly string[]
  fsyncFile?(path: string): void
  fsyncDirectory?(path: string): void
  stat(path: string): { readonly uid: number; readonly gid: number; readonly mode: number; readonly size: number; readonly isDirectory: boolean }
  inspectDirectory(path: string): { readonly uid: number; readonly gid: number; readonly mode: number }
  readOpenFile(path: string, maxBytes: number): { readonly content: string; readonly uid: number; readonly gid: number; readonly mode: number; readonly size: number }
  mkdir(path: string, mode: number): void
  writeNewFile(path: string, content: string | Buffer, mode: number): void
  replaceFile(path: string, content: string, mode: number): void
  renameFile(from: string, to: string): void
  chmod(path: string, mode: number): void
  chown(path: string, uid: number, gid: number): void
  removeFile(path: string): void
  removeDirectory(path: string): void
  randomBytes(size: number): Buffer
  resolveBundledCaddyRoot(): string
  portBusy(address: string, port: number): boolean
}
