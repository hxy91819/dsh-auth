import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { CommandResult, CommandSpec, InstallerHost } from '../src/installer/types.js'
import { CADDY_VERSION } from '../src/installer/caddy.js'

interface FakeEntry {
  content: Buffer
  mode: number
  uid: number
  gid: number
  directory: boolean
}

/** In-memory root host for installer behavior tests. */
export class FakeInstallerHost implements InstallerHost {
  readonly platform = 'linux' as const
  arch = 'x64' as string
  uid = 0

  get effectiveUid(): number | undefined {
    return this.uid
  }

  readonly entries = new Map<string, FakeEntry>()
  readonly commands: CommandSpec[] = []
  readonly busyPorts = new Set<string>()
  commandHandler: (command: CommandSpec) => CommandResult = () => ({ status: 0, stdout: '', stderr: '' })
  private randomCounter = 0

  constructor() {
    for (const path of ['/', '/etc', '/etc/systemd', '/etc/systemd/system', '/usr', '/usr/bin', '/usr/sbin', '/usr/lib', '/opt', '/opt/dsh', '/opt/dsh/bin', '/root', '/root/.dsh', '/var', '/var/lib', '/usr/lib/node_modules', '/usr/lib/node_modules/dsh-auth']) {
      this.addDirectory(path, 0o755)
    }
    for (const path of ['/usr/bin/systemctl', '/usr/bin/id', '/usr/bin/getent', '/opt/dsh/bin/dsh']) this.addFile(path, '', 0o755)
    this.addFile('/etc/os-release', 'ID="ubuntu"\nVERSION_ID="24.04"\n', 0o644)
    this.addFile('/usr/bin/apt-get', '', 0o755)
  }

  addDirectory(path: string, mode = 0o755, uid = 0, gid = 0): void {
    this.entries.set(path, { content: Buffer.alloc(0), mode, uid, gid, directory: true })
  }

  addFile(path: string, content: string | Buffer, mode = 0o644, uid = 0, gid = 0): void {
    if (!this.entries.has(dirname(path))) this.addDirectory(dirname(path))
    this.entries.set(path, { content: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content), mode, uid, gid, directory: false })
  }

  installBundledCaddy(): void {
    const directory = '/usr/lib/node_modules/dsh-auth/vendor/caddy'
    const license = 'Caddy license placeholder\n'
    const platforms: Record<string, { executable: string; binarySha256: string; upstreamArchive: string }> = {}
    for (const platform of ['linux-x64', 'linux-arm64'] as const) {
      const binary = Buffer.from(`fake-caddy-${platform}`)
      const binarySha256 = createHash('sha256').update(binary).digest('hex')
      this.addDirectory(join(directory, platform))
      this.addFile(join(directory, platform, 'caddy'), binary, 0o755)
      platforms[platform] = {
        executable: `${platform}/caddy`,
        binarySha256,
        upstreamArchive: `caddy_${CADDY_VERSION}_${platform.replace('linux-', 'linux_')}.tar.gz`,
      }
    }
    const manifest = `${JSON.stringify({
      schemaVersion: 1,
      caddyVersion: CADDY_VERSION,
      packageRevision: 'dsh.1',
      licenseSha256: createHash('sha256').update(license).digest('hex'),
      platforms,
    })}\n`
    this.addDirectory(join('/usr/lib/node_modules/dsh-auth', 'vendor'))
    this.addDirectory(directory)
    this.addFile(join(directory, 'LICENSE'), license, 0o644)
    this.addFile(join(directory, 'THIRD_PARTY.md'), 'Third-party notices\n', 0o644)
    this.addFile(join(directory, 'manifest.json'), manifest, 0o644)
    this.addFile(join(directory, 'manifest.sha256'), `${createHash('sha256').update(manifest).digest('hex')}\n`, 0o644)
    const prior = this.commandHandler
    this.commandHandler = (command) => {
      if (command.args[0] === 'version' && command.executable.endsWith('/caddy')) {
        return { status: 0, stdout: `v${CADDY_VERSION} h1:test\n`, stderr: '' }
      }
      if (command.args[0] === 'validate' && command.executable.endsWith('/caddy')) {
        const config = command.args[command.args.indexOf('--config') + 1]
        if (config !== undefined && this.regularFile(config)) {
          const rendered = this.readFile(config)
          for (const match of rendered.matchAll(/tls "(\/[^"]+)" "(\/[^"]+)"/gu)) {
            if (!this.regularFile(match[1] ?? '') || !this.regularFile(match[2] ?? '')) {
              return { status: 1, stdout: '', stderr: 'tls files missing' }
            }
          }
        }
        return { status: 0, stdout: 'Valid configuration\n', stderr: '' }
      }
      return prior(command)
    }
  }

  withSystemdService(name = 'dsh-web.service'): void {
    const prior = this.commandHandler
    this.commandHandler = (command) => {
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'show' && command.args[1] === name) {
        const property = command.args.find(value => value.startsWith('--property='))?.slice('--property='.length)
        const values: Record<string, string> = {
          LoadState: 'loaded',
          ActiveState: 'active',
          User: 'root',
          Group: 'root',
          Environment: 'DSH_HOME=/root/.dsh',
          ExecStart: '{ path=/opt/dsh/bin/dsh ; argv[]=/opt/dsh/bin/dsh web --port 3080 ; }',
        }
        return { status: 0, stdout: `${values[property ?? ''] ?? ''}\n`, stderr: '' }
      }
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'show' && command.args[1] === 'dsh-auth-caddy.service') {
        return { status: 0, stdout: 'loaded\n', stderr: '' }
      }
      if (command.executable === '/usr/bin/id') return { status: 0, stdout: '0\n', stderr: '' }
      if (command.executable === '/usr/bin/getent' && command.args[0] === 'group') {
        const gid = command.args[1] === 'dsh-auth' ? 2000 : 0
        return { status: 0, stdout: `${command.args[1] ?? 'root'}:x:${String(gid)}:\n`, stderr: '' }
      }
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'is-active') return { status: 0, stdout: 'active\n', stderr: '' }
      return prior(command)
    }
  }

  run(command: CommandSpec): CommandResult {
    this.commands.push({ executable: command.executable, args: [...command.args] })
    if (command.executable === '/opt/dsh/bin/dsh' && command.args[0] === 'plugin') {
      const profile = command.args[2] ?? 'web'
      const verb = command.args[3]
      const profileRoot = `/root/.dsh/profiles/${profile}`
      if (!this.fileExists('/root/.dsh')) this.addDirectory('/root/.dsh')
      if (!this.fileExists('/root/.dsh/profiles')) this.addDirectory('/root/.dsh/profiles')
      if (!this.fileExists(profileRoot)) this.addDirectory(profileRoot)
      const manifestPath = `${profileRoot}/package.json`
      if (verb === 'add') {
        const source = command.args.at(-1) ?? 'dsh-auth@0.1.11'
        const version = source.startsWith('dsh-auth@') ? source.slice('dsh-auth@'.length) : `file:${source}`
        this.addFile(manifestPath, `${JSON.stringify({ dependencies: { 'dsh-auth': version }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-auth'] } } }, null, 2)}\n`)
      } else if (verb === 'remove') {
        this.addFile(manifestPath, `${JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2)}\n`)
      }
    }
    return this.commandHandler(command)
  }

  readFile(path: string): string {
    const entry = this.entries.get(path)
    if (entry === undefined || entry.directory) throw new Error(`ENOENT: ${path}`)
    return entry.content.toString('utf8')
  }

  readFileBytes(path: string): Buffer {
    const entry = this.entries.get(path)
    if (entry === undefined || entry.directory) throw new Error(`ENOENT: ${path}`)
    return Buffer.from(entry.content)
  }

  fileExists(path: string): boolean {
    return this.entries.has(path)
  }

  regularFile(path: string): boolean {
    return this.entries.get(path)?.directory === false
  }

  realpath(path: string): string {
    if (!this.entries.has(path)) throw new Error(`ENOENT: ${path}`)
    return path
  }

  listDirectory(path: string): readonly string[] {
    if (this.entries.get(path)?.directory !== true) throw new Error(`ENOTDIR: ${path}`)
    return [...this.entries.keys()].filter(candidate => candidate !== path && dirname(candidate) === path).map(candidate => candidate.slice(path.length + 1))
  }

  stat(path: string): ReturnType<InstallerHost['stat']> {
    const entry = this.entries.get(path)
    if (entry === undefined) throw new Error(`ENOENT: ${path}`)
    return { uid: entry.uid, gid: entry.gid, mode: entry.mode, size: entry.content.length, isDirectory: entry.directory }
  }

  inspectDirectory(path: string): ReturnType<InstallerHost['inspectDirectory']> {
    const stat = this.stat(path)
    if (!stat.isDirectory) throw new Error('not a real directory')
    return { uid: stat.uid, gid: stat.gid, mode: stat.mode }
  }

  readOpenFile(path: string, maxBytes: number): ReturnType<InstallerHost['readOpenFile']> {
    const entry = this.entries.get(path)
    if (entry === undefined || entry.directory) throw new Error('not a regular file')
    const content = entry.content.toString('utf8')
    return {
      content: content.length > maxBytes ? content.slice(0, maxBytes + 1) : content,
      uid: entry.uid,
      gid: entry.gid,
      mode: entry.mode,
      size: entry.content.length,
    }
  }

  mkdir(path: string, mode: number): void {
    if (this.entries.has(path)) throw new Error(`EEXIST: ${path}`)
    this.addDirectory(path, mode)
  }

  writeNewFile(path: string, content: string | Buffer, mode: number): void {
    if (this.entries.has(path)) throw new Error(`EEXIST: ${path}`)
    if (!this.entries.get(dirname(path))?.directory) throw new Error(`ENOENT: ${dirname(path)}`)
    this.addFile(path, content, mode, this.uid, this.uid)
  }

  replaceFile(path: string, content: string, mode: number): void {
    if (!this.entries.get(dirname(path))?.directory) throw new Error(`ENOENT: ${dirname(path)}`)
    const previous = this.entries.get(path)
    this.addFile(path, content, mode, previous?.uid ?? 0, previous?.gid ?? 0)
  }

  renameFile(from: string, to: string): void {
    const entry = this.entries.get(from)
    if (entry === undefined) throw new Error(`ENOENT: ${from}`)
    if (this.entries.has(to)) throw new Error(`EEXIST: ${to}`)
    this.entries.set(to, entry)
    this.entries.delete(from)
  }

  chmod(path: string, mode: number): void {
    const entry = this.entries.get(path)
    if (entry === undefined) throw new Error(`ENOENT: ${path}`)
    entry.mode = mode
  }

  chown(path: string, uid: number, gid: number): void {
    const entry = this.entries.get(path)
    if (entry === undefined) throw new Error(`ENOENT: ${path}`)
    entry.uid = uid
    entry.gid = gid
  }

  removeFile(path: string): void {
    const entry = this.entries.get(path)
    if (entry?.directory === true) throw new Error(`EISDIR: ${path}`)
    this.entries.delete(path)
  }

  removeDirectory(path: string): void {
    if ([...this.entries.keys()].some(candidate => candidate !== path && dirname(candidate) === path)) return
    this.entries.delete(path)
  }

  randomBytes(size: number): Buffer {
    const value = 0xa5 + this.randomCounter
    this.randomCounter = (this.randomCounter + 1) % 32
    return Buffer.alloc(size, value)
  }

  resolveBundledCaddyRoot(): string {
    return '/usr/lib/node_modules/dsh-auth/vendor/caddy'
  }

  portBusy(address: string, port: number): boolean {
    return this.busyPorts.has(`${address}:${String(port)}`)
  }
}

/** Scripted CLI I/O with observable prompts and writes. */
export class FakeCliIo {
  readonly outputs: string[] = []
  readonly errors: string[] = []
  readonly prompts: string[] = []
  stdinReads = 0
  hiddenReads = 0

  constructor(
    readonly interactive: boolean,
    private readonly lines: string[] = [],
    private readonly hidden: string[] = [],
    private readonly stdin = '',
  ) {}

  writeOut(value: string): void {
    this.outputs.push(value)
  }

  writeError(value: string): void {
    this.errors.push(value)
  }

  readLine(prompt: string): Promise<string> {
    this.prompts.push(prompt)
    return Promise.resolve(this.lines.shift() ?? '')
  }

  readHidden(prompt: string): Promise<string> {
    this.prompts.push(prompt)
    this.hiddenReads += 1
    return Promise.resolve(this.hidden.shift() ?? '')
  }

  readStdin(): Promise<string> {
    this.stdinReads += 1
    return Promise.resolve(this.stdin)
  }
}
