/**
 * Validate the fixed Caddy release, generated configs, and observable auth edge protocol.
 */
import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import http, { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { once } from 'node:events'
import { renderCaddyfile } from './caddy-config.mjs'
import { caddyReleaseManifest, currentCaddyPlatform, prepareCaddyRelease } from './caddy-release.mjs'
import { renderCaddyfile as renderInstallerCaddyfile } from '../lib/installer/caddy.js'

const HELP = `Usage:
  node scripts/check-caddy.mjs [--caddy ABSOLUTE_PATH]

Description:
  Verify the pinned Caddy manifest and current-platform binary, validate manual,
  internal, and automatic TLS configs, then exercise the forward-auth boundary
  against a disposable upstream. Without --caddy, the official pinned archive
  is downloaded into an isolated directory and verified before use.

Options:
  --caddy PATH  Use an already available absolute Caddy executable.
  -h, --help    Show this help.

Outputs:
  Prints one JSON result to stdout. Exit 0 means integrity, config, cleanup,
  redirects, API denial, renewal Cookie, and forged-header replacement passed.
  Invalid arguments exit 2; runtime or validation failures exit nonzero.

Examples:
  node scripts/check-caddy.mjs
  node scripts/check-caddy.mjs --caddy /opt/dsh-auth/caddy
`

function parseArguments() {
  const args = process.argv.slice(2).filter(argument => argument !== '--')
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (args.length === 0) return {}
  if (args.length !== 2 || args[0] !== '--caddy' || args[1]?.startsWith('-') === true) {
    process.stderr.write(HELP)
    process.exit(2)
  }
  if (!isAbsolute(args[1])) throw new Error('--caddy must be an absolute path')
  accessSync(args[1], constants.X_OK)
  return { caddy: args[1] }
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout}${result.stderr}`)
  return result.stdout
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function availablePort() {
  const server = createTcpServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to allocate a port')
  server.close()
  await once(server, 'close')
  return address.port
}

function request(port, path, options = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = https.request({
      hostname: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: { host: `localhost:${String(port)}`, ...options.headers },
      rejectUnauthorized: false,
      servername: 'localhost',
    }, response => {
      const chunks = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.on('end', () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', rejectRequest)
    request.end()
  })
}

function requestHttp(port, path, headers = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, path, headers }, response => {
      const chunks = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.on('end', () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    outgoing.once('error', rejectRequest)
    outgoing.end()
  })
}

async function waitForEdge(port, process) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Caddy exited early with ${String(process.exitCode)}`)
    try {
      if ((await request(port, '/auth/login')).status === 200) return
    } catch {
      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
    }
  }
  throw new Error('Caddy did not become ready')
}

async function terminate(process) {
  if (process === undefined || process.exitCode !== null) return
  process.kill('SIGTERM')
  await Promise.race([once(process, 'exit'), new Promise(resolveTimeout => setTimeout(resolveTimeout, 3_000))])
  if (process.exitCode === null) {
    process.kill('SIGKILL')
    await once(process, 'exit')
  }
}

function validateManifest(manifest) {
  if (manifest.caddyVersion !== '2.11.4') throw new Error('Caddy version pin drifted')
  if (!/^https:\/\/github\.com\/caddyserver\/caddy\/releases\/download\/v2\.11\.4$/u.test(manifest.releaseBaseUrl)) {
    throw new Error('Caddy release source drifted')
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.licenseSha256)) throw new Error('Caddy license checksum is invalid')
  for (const platform of ['linux-x64', 'linux-arm64']) {
    const entry = manifest.platforms?.[platform]
    if (entry === undefined || !/^[a-f0-9]{128}$/u.test(entry.archiveSha512)
      || !/^[a-f0-9]{64}$/u.test(entry.binarySha256)) {
      throw new Error(`Caddy manifest is incomplete for ${platform}`)
    }
  }
}

function validateConfigs(caddy, root, ports, certificate, key) {
  const environment = { ...process.env, XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config') }
  for (const tls of [{ mode: 'manual', certificate, key }, { mode: 'internal' }, { mode: 'automatic' }]) {
    const rendered = renderCaddyfile({
      publicHost: 'localhost', listenAddress: '127.0.0.1', upstream: `127.0.0.1:${String(ports.upstream)}`,
      httpPort: ports.http, httpsPort: ports.https, tls, accessLogFile: join(root, `access-${tls.mode}.log`),
    })
    const formatted = checked(caddy, ['fmt', '-'], { input: rendered })
    if (formatted !== rendered) throw new Error(`rendered ${tls.mode} Caddy config is not formatted`)
    const path = join(root, `Caddyfile.${tls.mode}`)
    writeFileSync(path, rendered)
    checked(caddy, ['validate', '--config', path, '--adapter', 'caddyfile'], { env: environment })
    const adapted = JSON.parse(checked(caddy, ['adapt', '--config', path, '--adapter', 'caddyfile']))
    if (adapted.admin?.disabled !== true) throw new Error('Caddy Admin API is not disabled')
  }
  const proxied = renderInstallerCaddyfile({
    mode: 'http', behindTlsProxy: true, profile: 'web', packageSource: 'dsh-auth@0.2.0',
    adminBootstrap: 'login-token', loginTokenEnabled: true,
    upstream: `127.0.0.1:${String(ports.upstream)}`, listenAddress: '127.0.0.1',
    httpPort: ports.behind, httpsPort: 443,
  }, true)
  const formatted = checked(caddy, ['fmt', '-'], { input: proxied })
  if (formatted !== proxied) throw new Error('rendered behind-TLS-proxy Caddy config is not formatted')
  const path = join(root, 'Caddyfile.behind-tls-proxy')
  writeFileSync(path, proxied)
  checked(caddy, ['validate', '--config', path, '--adapter', 'caddyfile'], { env: environment })
}

function mockUpstream() {
  return createHttpServer((request, response) => {
    if (request.url === '/auth/verify') {
      if (request.headers.cookie !== 'session=valid') {
        response.writeHead(401, { 'x-dsh-auth-login': `/auth/login?returnTo=${encodeURIComponent(request.headers['x-original-uri'] ?? '/')}` })
        response.end()
        return
      }
      response.writeHead(204, {
        'x-dsh-auth-user-id': 'verified-admin',
        'x-dsh-auth-username': 'verified-name',
        'x-dsh-auth-roles': 'admin',
        'set-cookie': 'renewed=yes; Secure; HttpOnly; Path=/',
      })
      response.end()
      return
    }
    if (request.url?.startsWith('/auth/login') === true) {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('login')
      return
    }
    if (request.url?.startsWith('/auth/admin/setup') === true) {
      if (request.method === 'POST') {
        response.writeHead(303, { location: '/' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('setup')
      return
    }
    if (request.url?.startsWith('/auth/admin/password') === true) {
      if (request.method === 'POST') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('password updated')
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('password')
      return
    }
    if (request.url?.startsWith('/auth/token-bootstrap.js') === true) {
      response.writeHead(200, { 'content-type': 'text/javascript' })
      response.end('bridge')
      return
    }
    if (request.url?.startsWith('/auth/token') === true) {
      if (request.method === 'POST') {
        response.writeHead(303, { location: '/' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html', 'referrer-policy': 'same-origin' })
      response.end('bridge page')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.headers))
  })
}

async function verifyProtocol(caddy, root, ports, certificate, key) {
  const upstream = mockUpstream()
  upstream.listen(ports.upstream, '127.0.0.1')
  await once(upstream, 'listening')
  const config = join(root, 'Caddyfile.protocol')
  const accessLogFile = join(root, 'access-protocol.log')
  writeFileSync(config, renderCaddyfile({
    publicHost: 'localhost', listenAddress: '127.0.0.1', upstream: `127.0.0.1:${String(ports.upstream)}`,
    httpPort: ports.http, httpsPort: ports.https, tls: { mode: 'manual', certificate, key }, accessLogFile,
  }))
  const edge = spawn(caddy, ['run', '--config', config, '--adapter', 'caddyfile'], {
    stdio: 'ignore',
    env: { ...process.env, XDG_DATA_HOME: join(root, 'protocol-data'), XDG_CONFIG_HOME: join(root, 'protocol-config') },
  })
  try {
    await waitForEdge(ports.https, edge)
    const page = await request(ports.https, '/')
    if (page.status !== 303 || page.headers.location !== '/auth/login?returnTo=%2F') {
      throw new Error('Caddy did not map an interactive denial to the canonical 303')
    }
    if ((await request(ports.https, '/api/example')).status !== 401) throw new Error('Caddy did not preserve API 401')
    if ((await request(ports.https, '/auth/verify')).status !== 404) throw new Error('public verify was exposed')
    const bridge = await request(ports.https, '/auth/token')
    if (bridge.status !== 200 || bridge.headers['referrer-policy'] !== 'same-origin') throw new Error('token bridge page was not proxied untouched')
    const bridgeScript = await request(ports.https, '/auth/token-bootstrap.js')
    if (bridgeScript.status !== 200 || bridgeScript.body !== 'bridge') throw new Error('token bridge script was not proxied untouched')
    const redemption = await request(ports.https, '/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `https://localhost:${String(ports.https)}` },
    })
    if (redemption.status !== 303 || redemption.headers.location !== '/') throw new Error('token redemption POST was not proxied untouched')
    const setup = await request(ports.https, '/auth/admin/setup')
    if (setup.status !== 200 || setup.body !== 'setup') throw new Error('admin setup page was not proxied untouched')
    const setupPost = await request(ports.https, '/auth/admin/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `https://localhost:${String(ports.https)}` },
    })
    if (setupPost.status !== 303 || setupPost.headers.location !== '/') throw new Error('admin setup POST was not proxied untouched')
    const password = await request(ports.https, '/auth/admin/password')
    if (password.status !== 200 || password.body !== 'password') throw new Error('admin password page was not proxied untouched')
    const passwordPost = await request(ports.https, '/auth/admin/password', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `https://localhost:${String(ports.https)}` },
    })
    if (passwordPost.status !== 200 || passwordPost.body !== 'password updated') throw new Error('admin password POST was not proxied untouched')
    const accepted = await request(ports.https, '/echo', {
      headers: {
        cookie: 'session=valid',
        'x-dsh-auth-user-id': 'forged',
        'x-dsh-auth-username': 'forged',
        'x-dsh-auth-roles': 'owner',
        'x-forwarded-host': 'attacker.invalid',
        'x-forwarded-proto': 'http',
        'x-real-ip': '203.0.113.9',
      },
    })
    const seen = JSON.parse(accepted.body)
    if (seen['x-dsh-auth-user-id'] !== 'verified-admin' || seen['x-dsh-auth-username'] !== 'verified-name'
      || seen['x-dsh-auth-roles'] !== 'admin') throw new Error('verified identity did not replace forged headers')
    if (seen['x-forwarded-host'] === 'attacker.invalid' || seen['x-forwarded-proto'] === 'http'
      || seen['x-real-ip'] === '203.0.113.9') throw new Error('forged forwarding headers reached the upstream')
    const cookies = Array.isArray(accepted.headers['set-cookie']) ? accepted.headers['set-cookie'] : [accepted.headers['set-cookie']]
    if (!cookies.some(value => value?.startsWith('renewed=yes;'))) throw new Error('renewal Cookie was not forwarded')
    if ((await request(ports.https, '/api/access-log-check')).status !== 401) {
      throw new Error('routine access-log probe did not reach the protected edge')
    }
    const accessLogSecret = `must-not-appear-${randomBytes(12).toString('hex')}`
    if ((await request(ports.https, '/auth/login', {
      headers: { cookie: accessLogSecret, authorization: `Bearer ${accessLogSecret}` },
    })).status !== 200) throw new Error('access-log redaction probe did not reach the auth edge')
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 100))
    const accessLogs = readFileSync(accessLogFile, 'utf8')
    if (!accessLogs.includes('/auth/login')) throw new Error('Caddy auth access log was not emitted to its bounded file')
    if (accessLogs.includes('/api/access-log-check')) throw new Error('Caddy logged routine protected traffic')
    if (accessLogs.includes(accessLogSecret)) throw new Error('Caddy access log exposed a credential header')
  } finally {
    await terminate(edge)
    upstream.close()
    await once(upstream, 'close')
  }
}

async function verifyBehindTlsProxy(caddy, root, ports) {
  const upstream = mockUpstream()
  upstream.listen(ports.upstream, '127.0.0.1')
  await once(upstream, 'listening')
  const config = join(root, 'Caddyfile.behind-tls-proxy')
  const edge = spawn(caddy, ['run', '--config', config, '--adapter', 'caddyfile'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XDG_DATA_HOME: join(root, 'behind-data'), XDG_CONFIG_HOME: join(root, 'behind-config') },
  })
  const forwarded = {
    host: '203.0.113.10:49152',
    'x-forwarded-host': '203.0.113.10:49152',
    'x-forwarded-proto': 'https',
    'x-real-ip': '198.51.100.20',
  }
  try {
    const deadline = Date.now() + 10_000
    let ready = false
    while (Date.now() < deadline) {
      if (edge.exitCode !== null) throw new Error(`behind-TLS-proxy Caddy exited early with ${String(edge.exitCode)}`)
      try {
        if ((await requestHttp(ports.behind, '/auth/login', forwarded)).status === 200) {
          ready = true
          break
        }
      } catch {
        await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
      }
    }
    if (!ready) throw new Error('behind-TLS-proxy Caddy did not become ready')
    if ((await requestHttp(ports.behind, '/')).status !== 421) throw new Error('proxy mode accepted a request without trusted forwarding metadata')
    const denied = await requestHttp(ports.behind, '/', forwarded)
    if (denied.status !== 303 || denied.headers.location !== '/auth/login?returnTo=%2F') {
      throw new Error('proxy mode did not use a relative interactive redirect')
    }
    const echoed = JSON.parse((await requestHttp(ports.behind, '/auth/echo', forwarded)).body)
    const protectedEcho = JSON.parse((await requestHttp(ports.behind, '/echo', { ...forwarded, cookie: 'session=valid' })).body)
    for (const seen of [echoed, protectedEcho]) {
      if (seen['x-forwarded-host'] !== forwarded['x-forwarded-host']
        || seen['x-forwarded-proto'] !== forwarded['x-forwarded-proto']
        || seen['x-real-ip'] !== forwarded['x-real-ip']) {
        throw new Error('proxy mode did not preserve the trusted public origin and client address')
      }
    }
  } finally {
    await terminate(edge)
    upstream.close()
    await once(upstream, 'close')
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-auth-check-caddy-'))
let caddy
try {
  const options = parseArguments()
  const manifest = caddyReleaseManifest()
  validateManifest(manifest)
  caddy = options.caddy
  if (caddy === undefined) caddy = (await prepareCaddyRelease(join(root, 'runtime'))).binary
  const platform = currentCaddyPlatform()
  if (sha256(caddy) !== manifest.platforms[platform].binarySha256) throw new Error('Caddy binary SHA-256 mismatch')
  const version = checked(caddy, ['version']).trim().split(/\s+/u)[0]
  if (version !== `v${manifest.caddyVersion}`) throw new Error(`unexpected Caddy version: ${version}`)

  const certificate = join(root, 'certificate.pem')
  const key = join(root, 'key.pem')
  checked('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=localhost-${randomBytes(4).toString('hex')}`, '-keyout', key, '-out', certificate,
  ])
  const ports = { upstream: await availablePort(), http: await availablePort(), https: await availablePort(), behind: await availablePort() }
  validateConfigs(caddy, root, ports, certificate, key)
  await verifyProtocol(caddy, root, ports, certificate, key)
  await verifyBehindTlsProxy(caddy, root, ports)
  process.stdout.write(`${JSON.stringify({
    version, platform, binarySha256: manifest.platforms[platform].binarySha256,
    manifestPlatforms: Object.keys(manifest.platforms).sort(), tlsModes: ['automatic', 'internal', 'manual'],
    adminApi: 'disabled', publicVerify: 404, interactive: 303, api: 401, tokenRoutes: 'public proxied', setupRoute: 'public proxied', passwordRoute: 'public proxied',
    identityHeaders: 'verified values replaced forgeries', renewalCookie: true,
    accessLogs: 'auth routes only, headers omitted',
    behindTlsProxy: 'loopback guards, relative redirect, forwarded origin preserved', cleanup: true,
  }, undefined, 2)}\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
