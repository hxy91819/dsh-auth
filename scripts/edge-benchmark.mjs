/**
 * Compare the repository Nginx and Caddy edges on one host and one mock auth/upstream.
 */
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import https from 'node:https'
import { createServer as createTcpServer } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import WebSocket from 'ws'
import { renderCaddyfile } from './caddy-config.mjs'
import { caddyReleaseManifest, currentCaddyPlatform, prepareCaddyRelease } from './caddy-release.mjs'

const HELP = `Usage:
  node scripts/edge-benchmark.mjs [--caddy ABSOLUTE_PATH] [--output-dir ABSOLUTE_DIRECTORY]

Description:
  Start the repository Nginx and Caddy templates together against one fixed
  authentication/upstream process. After warmup, alternate three request-load
  samples per edge and verify SSE plus WebSocket continuity. This is a project
  edge-selection check, not a general-purpose web-server benchmark.

Options:
  --caddy PATH       Existing pinned Caddy executable; otherwise prepare it.
  --output-dir PATH  Artifact directory (default: repository .tmp/edge-benchmark).
  -h, --help         Show this help.

Outputs:
  Writes a timestamped JSON artifact containing every sample and prints its
  absolute path, SHA-256, throughput ratio, p95 ratio, and pass/fail result.
  Exit 0 requires Caddy throughput >=80% of Nginx, p95 <=125%, zero 5xx, and
  uninterrupted SSE/WebSocket checks. Invalid arguments exit 2.

Examples:
  node scripts/edge-benchmark.mjs
  node scripts/edge-benchmark.mjs --caddy /opt/dsh-auth/caddy --output-dir /tmp/dsh-auth-benchmark
`

const checkout = resolve(import.meta.dirname, '..')

function parseArguments() {
  const args = process.argv.slice(2).filter(argument => argument !== '--')
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument !== '--caddy' && argument !== '--output-dir') {
      process.stderr.write(HELP)
      process.exit(2)
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('-') || options[argument] !== undefined) {
      process.stderr.write(HELP)
      process.exit(2)
    }
    if (!isAbsolute(value)) throw new Error(`${argument} must be an absolute path`)
    options[argument] = value
    index += 1
  }
  return {
    caddy: options['--caddy'],
    outputDirectory: options['--output-dir'] ?? join(checkout, '.tmp', 'edge-benchmark'),
  }
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout}${result.stderr}`)
  return result.stdout
}

function toolVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} version check failed`)
  return `${result.stdout}${result.stderr}`.trim()
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

function fixedUpstream() {
  const body = JSON.stringify({ edge: 'dsh-auth', payload: 'x'.repeat(1000) })
  const server = createHttpServer((request, response) => {
    if (request.url === '/auth/verify') {
      if (request.headers.cookie !== 'session=benchmark') {
        response.writeHead(401, { 'x-dsh-auth-login': '/auth/login?returnTo=%2F' })
        response.end()
        return
      }
      response.writeHead(204, {
        'x-dsh-auth-user-id': 'admin', 'x-dsh-auth-username': 'admin', 'x-dsh-auth-roles': 'admin',
      })
      response.end()
      return
    }
    if (request.url?.startsWith('/auth/login') === true) {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('login')
      return
    }
    if (request.url === '/plugins/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      let frame = 0
      const timer = setInterval(() => {
        response.write(`data: ${String(frame)}\n\n`)
        frame += 1
      }, 25)
      response.on('close', () => { clearInterval(timer) })
      return
    }
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
    response.end(body)
  })
  server.on('upgrade', (request, socket) => {
    if (request.url !== '/api/events.mux') {
      socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    const accept = createHash('sha1').update(`${String(key)}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  })
  return server
}

function httpsRequest(port, path, agent) {
  const started = process.hrtime.bigint()
  return new Promise((resolveRequest, rejectRequest) => {
    const request = https.request({
      hostname: '127.0.0.1', port, path,
      headers: { host: `localhost:${String(port)}`, cookie: 'session=benchmark' },
      agent, rejectUnauthorized: false, servername: 'localhost',
    }, response => {
      response.resume()
      response.once('end', () => resolveRequest({
        status: response.statusCode,
        milliseconds: Number(process.hrtime.bigint() - started) / 1_000_000,
      }))
    })
    request.once('error', rejectRequest)
    request.end()
  })
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

async function loadSample(port, requests = 1_200, concurrency = 20) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: concurrency, rejectUnauthorized: false })
  const latencies = []
  let next = 0
  let serverErrors = 0
  const started = process.hrtime.bigint()
  const worker = async () => {
    while (next < requests) {
      next += 1
      const result = await httpsRequest(port, '/benchmark', agent)
      latencies.push(result.milliseconds)
      if (result.status >= 500) serverErrors += 1
      else if (result.status !== 200) throw new Error(`benchmark request returned ${String(result.status)}`)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  const seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000
  agent.destroy()
  return {
    requests, concurrency, requestsPerSecond: requests / seconds,
    p50Milliseconds: percentile(latencies, 0.5), p95Milliseconds: percentile(latencies, 0.95), serverErrors,
  }
}

async function waitForEdge(port, process, name) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`${name} exited early with ${String(process.exitCode)}`)
    const agent = new https.Agent({ keepAlive: false, rejectUnauthorized: false })
    try {
      const result = await httpsRequest(port, '/auth/login', agent)
      agent.destroy()
      if (result.status === 200) return
    } catch {
      agent.destroy()
      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 50))
    }
  }
  throw new Error(`${name} did not become ready`)
}

async function sseContinuity(port) {
  return await new Promise((resolveStream, rejectStream) => {
    const request = https.request({
      hostname: '127.0.0.1', port, path: '/plugins/events',
      headers: { host: `localhost:${String(port)}`, cookie: 'session=benchmark' },
      rejectUnauthorized: false, servername: 'localhost',
    })
    const timer = setTimeout(() => rejectStream(new Error('SSE continuity timeout')), 3_000)
    request.once('response', response => {
      let frames = 0
      response.on('data', chunk => {
        frames += chunk.toString().split('\n\n').length - 1
        if (frames < 3) return
        clearTimeout(timer)
        response.destroy()
        resolveStream(true)
      })
    })
    request.once('error', rejectStream)
    request.end()
  })
}

async function websocketContinuity(port) {
  return await new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(`wss://127.0.0.1:${String(port)}/api/events.mux`, {
      headers: { host: `localhost:${String(port)}`, cookie: 'session=benchmark' },
      origin: `https://localhost:${String(port)}`, rejectUnauthorized: false, servername: 'localhost',
    })
    const timer = setTimeout(() => rejectSocket(new Error('WebSocket continuity timeout')), 3_000)
    socket.once('open', () => {
      setTimeout(() => {
        clearTimeout(timer)
        socket.terminate()
        resolveSocket(true)
      }, 200)
    })
    socket.once('error', rejectSocket)
  })
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

function median(values) {
  return percentile(values, 0.5)
}

function nginxConfig(root, upstream, httpPort, httpsPort, certificate, key) {
  const replacements = new Map([
    ['${DSH_UPSTREAM}', `127.0.0.1:${String(upstream)}`], ['${DSH_HTTP_LISTEN}', `127.0.0.1:${String(httpPort)}`],
    ['${DSH_HTTPS_LISTEN}', `127.0.0.1:${String(httpsPort)}`], ['${DSH_PUBLIC_SERVER_NAME}', 'localhost'],
    ['${DSH_PUBLIC_HTTPS_AUTHORITY}', `localhost:${String(httpsPort)}`], ['${DSH_TLS_CERTIFICATE}', certificate],
    ['${DSH_TLS_CERTIFICATE_KEY}', key], ['${DSH_LOGIN_RATE}', '1000r/s'], ['${DSH_LOGIN_BURST}', '1000'],
  ])
  let include = readFileSync(join(checkout, 'deploy/nginx/dsh-auth.conf.template'), 'utf8')
  for (const [placeholder, value] of replacements) include = include.replaceAll(placeholder, value)
  const config = join(root, 'nginx.conf')
  writeFileSync(config, [
    `pid ${join(root, 'nginx.pid')};`, `error_log ${join(root, 'nginx-error.log')} notice;`,
    'events { worker_connections 2048; }', 'http {', '  access_log off;', include, '}', '',
  ].join('\n'))
  checked('nginx', ['-t', '-p', root, '-c', config])
  return config
}

function artifactName() {
  return `edge-benchmark-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}.json`
}

const options = parseArguments()
const root = mkdtempSync(join(tmpdir(), 'dsh-auth-edge-benchmark-'))
let nginxProcess
let caddyProcess
const upstream = fixedUpstream()
try {
  const runtime = options.caddy === undefined ? await prepareCaddyRelease(join(root, 'caddy-runtime')) : { binary: options.caddy }
  const caddy = runtime.binary
  const manifest = caddyReleaseManifest()
  if (createHash('sha256').update(readFileSync(caddy)).digest('hex') !== manifest.platforms[currentCaddyPlatform()].binarySha256) {
    throw new Error('Caddy binary SHA-256 mismatch')
  }
  const ports = {
    upstream: await availablePort(), nginxHttp: await availablePort(), nginxHttps: await availablePort(),
    caddyHttp: await availablePort(), caddyHttps: await availablePort(),
  }
  upstream.listen(ports.upstream, '127.0.0.1')
  await once(upstream, 'listening')
  const certificate = join(root, 'certificate.pem')
  const key = join(root, 'key.pem')
  checked('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', certificate])

  const nginxRoot = join(root, 'nginx')
  mkdirSync(nginxRoot)
  const nginx = nginxConfig(nginxRoot, ports.upstream, ports.nginxHttp, ports.nginxHttps, certificate, key)
  nginxProcess = spawn('nginx', ['-p', nginxRoot, '-c', nginx, '-g', 'daemon off;'], { stdio: 'ignore' })
  const caddyConfig = join(root, 'Caddyfile')
  writeFileSync(caddyConfig, renderCaddyfile({
    publicHost: 'localhost', listenAddress: '127.0.0.1', upstream: `127.0.0.1:${String(ports.upstream)}`,
    httpPort: ports.caddyHttp, httpsPort: ports.caddyHttps, tls: { mode: 'manual', certificate, key },
    accessLogFile: join(root, 'caddy-access.log'),
  }))
  caddyProcess = spawn(caddy, ['run', '--config', caddyConfig, '--adapter', 'caddyfile'], {
    stdio: 'ignore', env: { ...process.env, XDG_DATA_HOME: join(root, 'caddy-data'), XDG_CONFIG_HOME: join(root, 'caddy-config') },
  })
  await Promise.all([
    waitForEdge(ports.nginxHttps, nginxProcess, 'Nginx'), waitForEdge(ports.caddyHttps, caddyProcess, 'Caddy'),
  ])
  await loadSample(ports.nginxHttps, 200, 10)
  await loadSample(ports.caddyHttps, 200, 10)

  const samples = { nginx: [], caddy: [] }
  for (let round = 0; round < 3; round += 1) {
    const order = round % 2 === 0 ? ['nginx', 'caddy'] : ['caddy', 'nginx']
    for (const edge of order) {
      samples[edge].push(await loadSample(edge === 'nginx' ? ports.nginxHttps : ports.caddyHttps))
    }
  }
  const realtime = {
    nginx: { sse: await sseContinuity(ports.nginxHttps), websocket: await websocketContinuity(ports.nginxHttps) },
    caddy: { sse: await sseContinuity(ports.caddyHttps), websocket: await websocketContinuity(ports.caddyHttps) },
  }
  const nginxThroughput = median(samples.nginx.map(sample => sample.requestsPerSecond))
  const caddyThroughput = median(samples.caddy.map(sample => sample.requestsPerSecond))
  const nginxP95 = median(samples.nginx.map(sample => sample.p95Milliseconds))
  const caddyP95 = median(samples.caddy.map(sample => sample.p95Milliseconds))
  const throughputRatio = caddyThroughput / nginxThroughput
  const p95Ratio = caddyP95 / nginxP95
  const serverErrors = [...samples.nginx, ...samples.caddy].reduce((total, sample) => total + sample.serverErrors, 0)
  const passed = throughputRatio >= 0.8 && p95Ratio <= 1.25 && serverErrors === 0
    && Object.values(realtime).every(result => result.sse && result.websocket)
  const artifact = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), purpose: 'dsh-auth edge selection only',
    tools: { node: process.version, nginx: toolVersion('nginx', ['-v']), caddy: toolVersion(caddy, ['version']) },
    requestSet: { path: '/benchmark', bodyBytes: 1032, warmupRequests: 200, sampleRequests: 1200, concurrency: 20, rounds: 3 },
    samples, realtime, summary: { nginxThroughput, caddyThroughput, throughputRatio, nginxP95, caddyP95, p95Ratio, serverErrors, passed },
  }
  mkdirSync(options.outputDirectory, { recursive: true, mode: 0o700 })
  const artifactPath = join(options.outputDirectory, artifactName())
  const encoded = `${JSON.stringify(artifact, undefined, 2)}\n`
  writeFileSync(artifactPath, encoded, { flag: 'wx', mode: 0o600 })
  const artifactSha256 = createHash('sha256').update(encoded).digest('hex')
  process.stdout.write(`${JSON.stringify({ artifactPath, artifactSha256, ...artifact.summary }, undefined, 2)}\n`)
  if (!passed) throw new Error('Caddy did not meet the fixed edge performance and continuity thresholds')
} finally {
  await terminate(caddyProcess)
  await terminate(nginxProcess)
  upstream.close()
  if (upstream.listening) await once(upstream, 'close')
  rmSync(root, { recursive: true, force: true })
}
