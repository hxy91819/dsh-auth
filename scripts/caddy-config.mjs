import { isIP } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const checkout = resolve(import.meta.dirname, '..')
const template = readFileSync(join(checkout, 'deploy/caddy/dsh-auth.Caddyfile.template'), 'utf8')

function port(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`${label} must be a valid port`)
  return String(value)
}

function hostname(value) {
  if (typeof value !== 'string' || !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(value)) {
    throw new Error('publicHost must be a DNS hostname')
  }
  return value.toLowerCase()
}

function address(value, label) {
  if (typeof value !== 'string' || isIP(value) === 0) throw new Error(`${label} must be a literal IP address`)
  return value
}

function upstream(value) {
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(value)
  if (match === null) throw new Error('upstream must use 127.0.0.1 and a valid port')
  port(Number(match[1]), 'upstream port')
  return value
}

function caddyPath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n]/u.test(value)) {
    throw new Error(`${label} must be an absolute path without line breaks`)
  }
  return JSON.stringify(value)
}

function tlsDirective(tls) {
  if (tls.mode === 'automatic') return ''
  if (tls.mode === 'internal') return 'tls internal'
  if (tls.mode !== 'manual') throw new Error('tls mode must be automatic, internal, or manual')
  return `tls ${caddyPath(tls.certificate, 'certificate')} ${caddyPath(tls.key, 'key')}`
}

export function renderCaddyfile(options) {
  const publicHost = hostname(options.publicHost)
  const values = new Map([
    ['{{PUBLIC_HOST}}', publicHost],
    ['{{HTTP_PORT}}', port(options.httpPort, 'httpPort')],
    ['{{HTTPS_PORT}}', port(options.httpsPort, 'httpsPort')],
    ['{{LISTEN_ADDRESS}}', address(options.listenAddress, 'listenAddress')],
    ['{{PUBLIC_AUTHORITY}}', `${publicHost}:${port(options.httpsPort, 'httpsPort')}`],
    ['{{UPSTREAM}}', upstream(options.upstream)],
    ['{{TLS_DIRECTIVE}}', tlsDirective(options.tls)],
  ])
  let rendered = template
  for (const [placeholder, value] of values) rendered = rendered.replaceAll(placeholder, value)
  rendered = rendered.replace(/^[\t ]+$/gmu, '')
  rendered = rendered.replace(/\n{3,}/gu, '\n\n')
  if (/\{\{[A-Z_]+\}\}/u.test(rendered)) throw new Error('Caddyfile template contains an unresolved placeholder')
  return rendered
}
