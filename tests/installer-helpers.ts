import { dirname } from 'node:path'
import type { CommandResult, CommandSpec, InstallerHost } from '../src/installer/types.js'

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
  readonly effectiveUid = 0
  readonly entries = new Map<string, FakeEntry>()
  readonly commands: CommandSpec[] = []
  commandHandler: (command: CommandSpec) => CommandResult = () => ({ status: 0, stdout: '', stderr: '' })

  constructor() {
    for (const path of ['/', '/etc', '/etc/nginx', '/etc/nginx/conf.d', '/etc/systemd', '/etc/systemd/system', '/usr', '/usr/bin', '/usr/sbin', '/opt', '/opt/dsh', '/opt/dsh/bin', '/root', '/root/.dsh']) {
      this.addDirectory(path, 0o755)
    }
    for (const path of ['/usr/bin/systemctl', '/usr/bin/id', '/usr/bin/getent', '/opt/dsh/bin/dsh']) this.addFile(path, '', 0o755)
    this.addFile('/etc/os-release', 'ID="tencentos"\nVERSION_ID="4.4"\n', 0o644)
    this.addFile('/usr/bin/dnf', '', 0o755)
  }

  addDirectory(path: string, mode = 0o755, uid = 0, gid = 0): void {
    this.entries.set(path, { content: Buffer.alloc(0), mode, uid, gid, directory: true })
  }

  addFile(path: string, content: string | Buffer, mode = 0o644, uid = 0, gid = 0): void {
    if (!this.entries.has(dirname(path))) this.addDirectory(dirname(path))
    this.entries.set(path, { content: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content), mode, uid, gid, directory: false })
  }

  installNginx(version = '1.26.3', authRequest = true): void {
    this.addFile('/usr/sbin/nginx', '', 0o755)
    this.addFile('/etc/nginx/nginx.conf', 'events {}\nhttp { include /etc/nginx/conf.d/*.conf; }\n', 0o644)
    const prior = this.commandHandler
    this.commandHandler = (command) => {
      if (command.executable === '/usr/sbin/nginx' && command.args[0] === '-V') {
        return { status: 0, stdout: '', stderr: `nginx version: nginx/${version}\nconfigure arguments: --conf-path=/etc/nginx/nginx.conf${authRequest ? ' --with-http_auth_request_module' : ''}` }
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
      if (command.executable === '/usr/bin/systemctl' && command.args[0] === 'show' && command.args[1] === 'nginx.service') {
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

  stat(path: string): ReturnType<InstallerHost['stat']> {
    const entry = this.entries.get(path)
    if (entry === undefined) throw new Error(`ENOENT: ${path}`)
    return { uid: entry.uid, gid: entry.gid, mode: entry.mode, size: entry.content.length, isDirectory: entry.directory }
  }

  mkdir(path: string, mode: number): void {
    if (this.entries.has(path)) throw new Error(`EEXIST: ${path}`)
    this.addDirectory(path, mode)
  }

  writeNewFile(path: string, content: string | Buffer, mode: number): void {
    if (this.entries.has(path)) throw new Error(`EEXIST: ${path}`)
    if (!this.entries.get(dirname(path))?.directory) throw new Error(`ENOENT: ${dirname(path)}`)
    this.addFile(path, content, mode)
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
    return Buffer.alloc(size, 0xa5)
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
