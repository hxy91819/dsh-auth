/**
 * Validate the leftover Nginx template syntax with disposable files.
 *
 * Usage: node scripts/check-nginx.mjs [--help]
 * Options: --help, -h prints this contract without running checks.
 * Output: one success line and exit 0, or a diagnostic error and non-zero exit.
 * Examples: node scripts/check-nginx.mjs; corepack pnpm run check:nginx
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const HELP = `Usage: node scripts/check-nginx.mjs [options]

Description:
  Validate the leftover Nginx template still used by isolated compatibility
  tests. v2 setup does not install or render Nginx.

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

const root = mkdtempSync(join(tmpdir(), 'dsh-auth-nginx-'))

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout}${result.stderr}`)
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
  const config = join(root, 'legacy.conf')
  writeFileSync(config, [
    `pid ${join(root, 'legacy.pid')};`,
    'error_log stderr notice;',
    'events {}',
    'http {',
    '  access_log off;',
    legacy,
    '}',
    '',
  ].join('\n'))
  run('nginx', ['-t', '-p', root, '-c', config])
  process.stdout.write('Leftover Nginx template syntax is valid.\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
