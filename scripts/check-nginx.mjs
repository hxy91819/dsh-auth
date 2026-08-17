/**
 * Validate generated Nginx syntax and the plain-HTTP Host fence with disposable files.
 *
 * Usage: node scripts/check-nginx.mjs [--help]
 * Options: --help, -h prints this contract without running checks.
 * Output: one success line and exit 0, or a diagnostic error and non-zero exit.
 * Examples: node scripts/check-nginx.mjs; corepack pnpm run check:nginx
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const HELP = `Usage: node scripts/check-nginx.mjs [options]

Description:
  Validate the legacy template and installer-rendered HTTPS/HTTP Nginx configs,
  then start a disposable HTTP edge and verify that an unconfigured Host is rejected.

Options:
  -h, --help  Show this help text.

Outputs:
  Prints a success summary to stdout. Validation failures go to stderr via the
  uncaught error and return a non-zero exit code. All temporary files are removed.

Examples:
  node scripts/check-nginx.mjs
  corepack pnpm run check:nginx
`

if (process.argv.length > 2) {
  if (process.argv.length === 3 && (process.argv[2] === '--help' || process.argv[2] === '-h')) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  throw new Error(`unsupported arguments: ${process.argv.slice(2).join(' ')}`)
}

const { renderNginxConfig } = await import('../lib/installer/nginx.js')

const root = mkdtempSync(join(tmpdir(), 'dsh-auth-nginx-'))

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout}${result.stderr}`)
}

function validate(name, include) {
  const config = join(root, `${name}.conf`)
  writeFileSync(config, [
    `pid ${join(root, `${name}.pid`)};`,
    'error_log stderr notice;',
    'events {}',
    'http {',
    '  access_log off;',
    include,
    '}',
    '',
  ].join('\n'))
  run('nginx', ['-t', '-p', root, '-c', config])
  return config
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to reserve a disposable TCP port')
  await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  return address.port
}

async function verifyHttpHostFence(common) {
  const port = await availablePort()
  const include = renderNginxConfig({
    ...common,
    mode: 'http',
    listenAddress: '127.0.0.1',
    httpPort: port,
  })
  const config = validate('installer-http-host-fence', include)
  const child = spawn('nginx', ['-p', root, '-c', config, '-g', 'daemon off;'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  try {
    let response
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`disposable nginx exited early\n${stderr}`)
      try {
        response = await new Promise((resolve, reject) => {
          const request = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { host: 'attacker.invalid' } }, resolve)
          request.once('error', reject)
          request.end()
        })
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    response?.resume()
    if (response?.statusCode !== 421) {
      throw new Error(`plain HTTP Host fence returned ${String(response?.statusCode ?? 'no response')}, expected 421`)
    }
  } finally {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        child.once('exit', resolve)
        child.kill('SIGTERM')
      })
    }
  }
}

try {
  const certificate = join(root, 'certificate.pem')
  const key = join(root, 'key.pem')
  run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', key, '-out', certificate,
  ])
  const replacements = new Map([
    ['${DSH_UPSTREAM}', '127.0.0.1:3080'],
    ['${DSH_HTTP_LISTEN}', '127.0.0.1:18080'],
    ['${DSH_HTTPS_LISTEN}', '127.0.0.1:18443'],
    ['${DSH_PUBLIC_SERVER_NAME}', 'localhost'],
    ['${DSH_PUBLIC_HTTPS_AUTHORITY}', 'localhost:18443'],
    ['${DSH_TLS_CERTIFICATE}', certificate],
    ['${DSH_TLS_CERTIFICATE_KEY}', key],
    ['${DSH_LOGIN_RATE}', '5r/m'],
    ['${DSH_LOGIN_BURST}', '4'],
  ])
  let legacy = readFileSync('deploy/nginx/dsh-auth.conf.template', 'utf8')
  for (const [placeholder, value] of replacements) legacy = legacy.replaceAll(placeholder, value)
  if (/\$\{DSH_[A-Z_]+\}/u.test(legacy)) throw new Error('unresolved Nginx template placeholder')
  validate('legacy-template', legacy)

  const common = {
    nginxPolicy: 'skip',
    authorizeNginxInstall: false,
    outputDirectory: '/render-only',
    profile: 'web',
    packageSource: 'dsh-auth@0.1.11',
    userId: 'admin',
    username: 'admin',
    roles: ['admin'],
    upstream: '127.0.0.1:3080',
    httpPort: 18081,
    httpsPort: 18444,
  }
  validate('installer-https', renderNginxConfig({
    ...common,
    mode: 'https',
    listenAddress: '127.0.0.1',
    serverName: 'localhost',
    certificate,
    certificateKey: key,
  }))
  validate('installer-http', renderNginxConfig({
    ...common,
    mode: 'http',
    listenAddress: '127.0.0.1',
  }))
  await verifyHttpHostFence(common)
  process.stdout.write('Legacy and installer HTTPS/HTTP Nginx configurations and the HTTP Host fence are valid.\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
