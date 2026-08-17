/** Validate the legacy template and both installer-rendered edge modes with disposable files. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { renderNginxConfig } from '../lib/installer/nginx.js'

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
  process.stdout.write('Legacy and installer HTTPS/HTTP Nginx configurations are valid.\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
