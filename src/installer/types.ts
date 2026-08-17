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

/** Nginx handling selected by an operator. */
export type NginxPolicy = 'require' | 'install' | 'skip'

/** Public edge mode. */
export type EdgeMode = 'https' | 'http'

/** Fixed operating-system package installation recipe. */
export interface PackageManagerDiscovery {
  readonly kind: 'apt-get' | 'dnf'
  readonly executable: string
  readonly source: string
  readonly commands: readonly CommandSpec[]
}

/** One argv-only subprocess invocation. */
export interface CommandSpec {
  readonly executable: string
  readonly args: readonly string[]
}

/** Nginx facts discovered from the installed executable and main config. */
export interface NginxDiscovery {
  readonly installed: boolean
  readonly executable?: string
  readonly version?: string
  readonly versionSupported: boolean
  readonly authRequestModule: boolean
  readonly configPath?: string
  readonly includePath?: string
  readonly serviceManager: 'systemd' | 'none'
  readonly serviceName?: 'nginx.service'
  readonly serviceLoadState?: string
}

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
  readonly effectiveUid: number | undefined
  readonly nginx: NginxDiscovery
  readonly packageManager?: PackageManagerDiscovery
  readonly dshService?: DshServiceDiscovery
}

/** Validated setup input shared by interactive and non-interactive callers. */
export interface SetupRequest {
  readonly mode: EdgeMode
  readonly nginxPolicy: NginxPolicy
  readonly authorizeNginxInstall: boolean
  readonly outputDirectory?: string
  readonly dshService?: string
  readonly dshHome?: string
  readonly dshExecutable?: string
  readonly profile: string
  readonly packageSource: string
  readonly userId: string
  readonly username: string
  readonly roles: readonly string[]
  readonly upstream: string
  readonly listenAddress: string
  readonly httpPort: number
  readonly httpsPort: number
  readonly serverName?: string
  readonly certificate?: string
  readonly certificateKey?: string
  readonly passwordSource?: PasswordSource
}

/** Password input descriptor. The password itself never enters a plan. */
export type PasswordSource =
  | { readonly kind: 'stdin' }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'interactive' }

/** Paths owned by one completed system installation. */
export interface ManagedPaths {
  readonly configDirectory: string
  readonly stateFile: string
  readonly environmentFile: string
  readonly passwordHashFile: string
  readonly sessionSecretFile: string
  readonly sessionDirectory: string
  readonly sessionStoreFile: string
  readonly systemdDropInDirectory: string
  readonly systemdDropInFile: string
  readonly nginxConfigFile: string
}

/** Persisted ownership and recovery record. It never contains secret material. */
export interface InstallState {
  readonly schemaVersion: 1
  readonly status: 'installing' | 'installed'
  readonly fingerprint: string
  readonly request: Omit<SetupRequest, 'passwordSource' | 'authorizeNginxInstall'>
  readonly paths: ManagedPaths
  readonly dshService: string
  readonly dshUser: string
  readonly dshHome: string
  readonly dshExecutable: string
  readonly nginxExecutable: string
  readonly nginxService: 'nginx.service'
  readonly nginxInstalledByDshAuth: boolean
  readonly profilePackageInstalledByDshAuth: boolean
  readonly createdPaths: readonly string[]
  readonly activation?: {
    readonly dshWasActive: boolean
    readonly nginxWasActive: boolean
    readonly nginxWasEnabled: boolean
    readonly daemonReloadAttempted: boolean
    readonly dshRestartAttempted: boolean
    readonly nginxActivationAttempted: boolean
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
  readonly schemaVersion: 1
  readonly operation: 'setup' | 'uninstall' | 'doctor'
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
  readonly effectiveUid: number | undefined
  run(command: CommandSpec, options?: { readonly env?: NodeJS.ProcessEnv }): CommandResult
  readFile(path: string): string
  readFileBytes(path: string): Buffer
  fileExists(path: string): boolean
  regularFile(path: string): boolean
  realpath(path: string): string
  stat(path: string): { readonly uid: number; readonly gid: number; readonly mode: number; readonly size: number; readonly isDirectory: boolean }
  mkdir(path: string, mode: number): void
  writeNewFile(path: string, content: string | Buffer, mode: number): void
  replaceFile(path: string, content: string, mode: number): void
  renameFile(from: string, to: string): void
  chmod(path: string, mode: number): void
  chown(path: string, uid: number, gid: number): void
  removeFile(path: string): void
  removeDirectory(path: string): void
  randomBytes(size: number): Buffer
}
