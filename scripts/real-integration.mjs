/**
 * Exercise the packed bundle through a real DSH, TLS edge, and headless
 * browser. The test owns every generated profile, secret, process, and port.
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { accessSync, chmodSync, constants, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import WebSocket from 'ws'
import { renderCaddyfile } from './caddy-config.mjs'
import { prepareCaddyRelease } from './caddy-release.mjs'

const checkout = resolve(import.meta.dirname, '..')
const HELP = `Usage:
  corepack pnpm run test:e2e
  node scripts/real-integration.mjs [PATH.tgz]

Description:
  Pack the current checkout when PATH.tgz is omitted, install that artifact
  into a disposable DSH profile, and verify the real Caddy TLS edge, v2
  authentication state, password and login-token journeys, protected routes,
  session persistence, and browser sign-out behavior.

Arguments:
  PATH.tgz  Optional local package artifact. It must resolve to a .tgz file.

Environment:
  DSH_E2E_CWD         Absolute DSH workspace path (default: repository root).
  DSH_E2E_DSH_BIN     Absolute DSH executable (default: local dependency).
  DSH_E2E_CHROME_BIN  Absolute Chrome/Chromium executable (default: auto-detect).
  DSH_E2E_EDGE        caddy or nginx (default: caddy).
  DSH_E2E_CADDY_BIN   Absolute Caddy executable (default: verified test binary).
  DSH_E2E_CADDY_TLS   manual or internal (default: manual).
  DSH_E2E_BOOTSTRAP   password or login-token (default: login-token).

Outputs:
  Writes a JSON behavior summary to stdout and exits 0 on success. Failures
  exit nonzero. All temporary profiles, credentials, certificates, and child
  processes are cleaned up.

Examples:
  corepack pnpm run test:e2e
  DSH_E2E_CHROME_BIN=/usr/bin/chromium node scripts/real-integration.mjs packed/dsh-auth-0.1.15.tgz
  DSH_E2E_BOOTSTRAP=password DSH_E2E_EDGE=caddy node scripts/real-integration.mjs
`

const args = process.argv.slice(2).filter(argument => argument !== '--')
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (args.length > 1 || args.some(argument => argument.startsWith('-'))) {
  process.stderr.write(HELP)
  process.exit(2)
}

function executable(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`)
  try {
    accessSync(path, constants.X_OK)
  } catch {
    throw new Error(`${label} is not executable: ${path}`)
  }
  return path
}

function chromeExecutable() {
  if (process.env.DSH_E2E_CHROME_BIN !== undefined) {
    return executable(process.env.DSH_E2E_CHROME_BIN, 'DSH_E2E_CHROME_BIN')
  }
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    try {
      return executable(candidate, 'browser')
    } catch {
      continue
    }
  }
  throw new Error('Chrome/Chromium was not found; set DSH_E2E_CHROME_BIN to its absolute executable path')
}

const launchCwd = process.env.DSH_E2E_CWD ?? checkout
if (!isAbsolute(launchCwd) || !statSync(launchCwd).isDirectory()) {
  throw new Error('DSH_E2E_CWD must be an absolute directory path')
}
const dshExecutable = executable(
  process.env.DSH_E2E_DSH_BIN ?? join(checkout, 'node_modules', '.bin', 'dsh'),
  'DSH executable',
)
const browserExecutable = chromeExecutable()
const edgeRuntime = process.env.DSH_E2E_EDGE ?? 'caddy'
if (edgeRuntime !== 'nginx' && edgeRuntime !== 'caddy') throw new Error('DSH_E2E_EDGE must be nginx or caddy')
const requestedCaddy = process.env.DSH_E2E_CADDY_BIN
const caddyTls = process.env.DSH_E2E_CADDY_TLS ?? 'manual'
if (caddyTls !== 'manual' && caddyTls !== 'internal') throw new Error('DSH_E2E_CADDY_TLS must be manual or internal')
const bootstrap = process.env.DSH_E2E_BOOTSTRAP ?? 'login-token'
if (bootstrap !== 'password' && bootstrap !== 'login-token') {
  throw new Error('DSH_E2E_BOOTSTRAP must be password or login-token')
}
const root = mkdtempSync(join(tmpdir(), 'dsh-auth-real-integration-'))
const home = join(root, 'dsh-home')
const secrets = join(root, 'managed')
const nginxRoot = join(root, 'edge')
mkdirSync(secrets, { mode: 0o700 })
mkdirSync(join(secrets, 'state', 'login-tokens'), { recursive: true, mode: 0o700 })
chmodSync(join(secrets, 'state', 'login-tokens'), 0o700)
mkdirSync(nginxRoot, { recursive: true })

let dshProcess
let edgeProcess
let chromeProcess
let caddyExecutable

function issueLoginToken(authStateFile, origin) {
  const result = spawnSync(process.execPath, [
    join(checkout, 'lib/cli.js'), 'issue-login-token',
    '--non-interactive', '--authorize-login-token-issue', '--json',
    '--auth-state-file', authStateFile,
    '--public-origin', origin,
  ], { encoding: 'utf8', cwd: checkout })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`issue-login-token failed\n${result.stdout}${result.stderr}`)
  assert(!result.stderr.includes('dsh_otl_v1_'), 'token issue leaked a bearer secret to stderr')
  const document = JSON.parse(result.stdout)
  assert(document.schemaVersion === 2 && document.status === 'success' && typeof document.token === 'string', 'token issue JSON was not a v2 success document')
  assert(document.loginUrl === `${origin}/auth/token#token=${document.token}`, 'token issue URL did not use the fragment contract')
  return document
}

async function resolveCaddyBinary() {
  if (edgeRuntime !== 'caddy') return undefined
  if (requestedCaddy !== undefined) return executable(requestedCaddy, 'DSH_E2E_CADDY_BIN')
  return (await prepareCaddyRelease(join(root, 'caddy-runtime'))).binary
}

function writeAuthLayout(authState, passwordHash, sessionSecret, configured) {
  const stateDirectory = join(secrets, 'state')
  const authStateFile = join(stateDirectory, 'auth-state.json')
  const tokenDirectory = join(stateDirectory, 'login-tokens')
  const secretFile = join(secrets, 'session-secret')
  const environmentFile = join(secrets, 'dsh-auth.env')
  writeFileSync(secretFile, `${sessionSecret}\n`, { mode: 0o600 })
  const document = configured
    ? authState.createAuthStateDocument(authState.authStateSecretId(Buffer.from(sessionSecret)), {
      username: 'integration-account',
      passwordHash,
      configuredAt: Date.now(),
    })
    : authState.createAuthStateDocument(authState.authStateSecretId(Buffer.from(sessionSecret)))
  writeFileSync(authStateFile, `${JSON.stringify(document)}\n`, { mode: 0o600 })
  chmodSync(authStateFile, 0o600)
  chmodSync(tokenDirectory, 0o700)
  writeFileSync(environmentFile, [
    `DSH_AUTH_STATE_FILE="${authStateFile}"`,
    `DSH_AUTH_SESSION_SECRET_FILE="${secretFile}"`,
    'DSH_AUTH_LOGIN_TOKEN_ENABLED=true',
    `DSH_AUTH_LOGIN_TOKEN_DIRECTORY="${tokenDirectory}"`,
    '',
  ].join('\n'), { mode: 0o600 })
  return { authStateFile, tokenDirectory, secretFile }
}

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout}${result.stderr}`)
  return result.stdout
}

function packageTarball() {
  if (args[0] !== undefined) {
    const supplied = resolve(args[0])
    if (!supplied.endsWith('.tgz') || !statSync(supplied).isFile()) {
      throw new Error('PATH.tgz must resolve to a package tarball file')
    }
    return supplied
  }

  const artifactDirectory = join(root, 'artifacts')
  mkdirSync(artifactDirectory)
  checked('corepack', ['pnpm', 'pack', '--pack-destination', artifactDirectory], { cwd: checkout })
  const manifest = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'))
  return join(artifactDirectory, `${manifest.name}-${manifest.version}.tgz`)
}

async function availablePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to allocate a port')
  const port = address.port
  server.close()
  await once(server, 'close')
  return port
}

function child(command, args, options) {
  const process = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
  let output = ''
  const collect = chunk => {
    output = `${output}${chunk.toString()}`.slice(-8_000)
  }
  process.stdout?.on('data', collect)
  process.stderr?.on('data', collect)
  process.testOutput = () => output
  return process
}

async function terminate(process) {
  if (process === undefined || process.exitCode !== null) return
  process.kill('SIGTERM')
  await Promise.race([
    once(process, 'exit'),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 5_000)),
  ])
  if (process.exitCode === null) {
    process.kill('SIGKILL')
    await once(process, 'exit')
  }
}

async function waitUntil(check, label, watchedProcesses = []) {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    for (const watched of watchedProcesses) {
      if (watched.process.exitCode !== null) {
        throw new Error(`${watched.name} exited with code ${String(watched.process.exitCode)}\n${watched.process.testOutput()}`)
      }
    }
    try {
      if (await check()) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 200))
  }
  const childOutput = watchedProcesses.map(watched => `\n${watched.name}:\n${watched.process.testOutput()}`).join('')
  throw new Error(`${label} did not become ready${lastError instanceof Error ? `: ${lastError.message}` : ''}${childOutput}`)
}

function clientRequest(client, port, path, options = {}) {
  const body = options.body === undefined ? undefined : Buffer.from(options.body)
  const headers = {
    host: `localhost:${String(port)}`,
    ...options.headers,
    ...body === undefined ? {} : { 'content-length': String(body.length) },
  }
  return new Promise((resolveRequest, rejectRequest) => {
    const req = client.request({
      hostname: '127.0.0.1', port, path,
      method: options.method ?? 'GET', headers,
      ...client === https ? { rejectUnauthorized: false, servername: 'localhost' } : {},
    }, response => {
      const chunks = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.on('end', () => {
        resolveRequest({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        })
      })
    })
    req.on('error', rejectRequest)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function request(port, path, options = {}) {
  return clientRequest(https, port, path, options)
}

function requestHttp(port, path, options = {}) {
  return clientRequest(http, port, path, options)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function cookiePair(setCookie, name) {
  const fields = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie]
  const field = fields.find(value => value.startsWith(`${name}=`))
  if (field === undefined) throw new Error(`missing ${name} cookie`)
  return { field, pair: field.split(';', 1)[0] }
}

function hidden(html, name) {
  const match = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`, 'u').exec(html)
  if (match?.[1] === undefined) throw new Error(`missing ${name} form value`)
  return match[1].replaceAll('&amp;', '&')
}

function form(fields) {
  return new URLSearchParams(fields).toString()
}

async function websocketStatus(port, cookie) {
  return new Promise((resolveSocket, rejectSocket) => {
    const headers = { host: `localhost:${String(port)}` }
    if (cookie !== undefined) headers.cookie = cookie
    const socket = new WebSocket(`wss://127.0.0.1:${String(port)}/api/events.mux`, {
      headers,
      origin: `https://localhost:${String(port)}`,
      rejectUnauthorized: false,
      servername: 'localhost',
    })
    socket.once('open', () => {
      socket.close()
      resolveSocket(101)
    })
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolveSocket(response.statusCode)
    })
    socket.once('error', error => {
      if (socket.readyState !== WebSocket.CLOSED) rejectSocket(error)
    })
  })
}

async function http2Status(port, path) {
  const client = http2.connect(`https://localhost:${String(port)}`, { rejectUnauthorized: false })
  try {
    const request = client.request({ ':method': 'GET', ':path': path })
    const [headers] = await once(request, 'response')
    request.close()
    return headers[':status']
  } finally {
    client.close()
  }
}

async function sseStatus(port, cookie) {
  return await new Promise((resolveStream, rejectStream) => {
    const request = https.request({
      hostname: '127.0.0.1', port, path: '/plugins/events',
      headers: { host: `localhost:${String(port)}`, ...cookie === undefined ? {} : { cookie } },
      rejectUnauthorized: false,
      servername: 'localhost',
    })
    const timer = setTimeout(() => {
      request.destroy()
      rejectStream(new Error('SSE did not produce an initial frame'))
    }, 5_000)
    request.once('response', response => {
      if (response.statusCode !== 200) {
        clearTimeout(timer)
        response.resume()
        resolveStream({ status: response.statusCode })
        return
      }
      let body = ''
      response.on('data', chunk => {
        body += chunk.toString()
        if (!body.includes(': connected\n\n') || !body.includes('"type":"graph"')) return
        clearTimeout(timer)
        response.destroy()
        resolveStream({ status: response.statusCode, contentType: response.headers['content-type'], initialFrame: true })
      })
      response.once('error', error => {
        if (!response.destroyed) rejectStream(error)
      })
    })
    request.once('error', error => {
      clearTimeout(timer)
      rejectStream(error)
    })
    request.end()
  })
}

async function openBrowser(chromePort, targetUrl) {
  const targetResponse = await fetch(`http://127.0.0.1:${String(chromePort)}/json/new?${encodeURIComponent(targetUrl)}`, {
    method: 'PUT',
  })
  if (!targetResponse.ok) throw new Error(`Chrome target creation failed with status ${String(targetResponse.status)}`)
  const target = await targetResponse.json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  let nextId = 1
  const pending = new Map()
  socket.on('message', data => {
    const message = JSON.parse(data.toString())
    if (message.id === undefined) return
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const id = nextId
    nextId += 1
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text ?? 'browser evaluation failed')
    return result.result.value
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Network.enable')
  return {
    evaluate,
    navigate: url => send('Page.navigate', { url }),
    clearCookies: () => send('Network.clearBrowserCookies'),
    close: () => { socket.close() },
  }
}

async function waitForBrowser(evaluate, expression, label) {
  try {
    await waitUntil(async () => await evaluate(expression) === true, label)
  } catch (error) {
    let extra = ''
    try {
      extra = `; browser at ${JSON.stringify(await evaluate('({ href: location.href, text: (document.body && document.body.innerText || "").slice(0, 240) })'))}`
    } catch (inspectError) {
      extra = `; inspect failed: ${inspectError instanceof Error ? inspectError.message : String(inspectError)}`
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}${extra}`)
  }
}

const AUTHENTICATED_SPA = 'location.pathname === "/" && Array.from(document.querySelectorAll("button")).some(button => { const text = button.textContent?.trim(); return text === "Settings" || text === "设置" })'

async function openHarnessSettings(browser, label) {
  await waitForBrowser(browser.evaluate, AUTHENTICATED_SPA, label)
  await browser.evaluate(`(() => {
    const labels = new Set(['Settings', '设置'])
    const settings = Array.from(document.querySelectorAll('button')).find(button => labels.has(button.textContent?.trim() ?? ''))
    settings?.click()
    return settings !== undefined
  })()`)
}

async function signOutFromSettings(browser, readyLabel, redirectLabel) {
  await openHarnessSettings(browser, readyLabel)
  await waitForBrowser(browser.evaluate, 'document.querySelector(".dsh-auth-logout") !== null', 'Settings sign-out row')
  await browser.evaluate('document.querySelector(".dsh-auth-logout")?.click()')
  await waitForBrowser(browser.evaluate, 'location.pathname === "/auth/login"', redirectLabel)
}

async function completeTokenOnboarding(httpsPort, chromePort, authStateFile, username, password) {
  const origin = `https://localhost:${String(httpsPort)}`
  const loginPage = await request(httpsPort, '/auth/login')
  const loginHtml = loginPage.body.toString('utf8')
  assert(loginPage.status === 200 && !loginHtml.includes('name="password"'), 'unset administrator still rendered a password form')
  const bridge = await request(httpsPort, '/auth/token')
  const bridgeHtml = bridge.body.toString('utf8')
  assert(bridge.status === 200 && bridgeHtml.includes('token-bootstrap.js'), 'token bridge page was not public')
  const probe = issueLoginToken(authStateFile, origin)
  const probeCsrf = cookiePair(bridge.headers['set-cookie'], '__Host-dsh_auth_csrf')
  const probeToken = /<meta name="dsh-auth-csrf" content="([^"]*)">/u.exec(bridgeHtml)?.[1]
  assert(probeToken !== undefined, 'token bridge CSRF meta was missing')
  const redeemed = await request(httpsPort, '/auth/token', {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: probeCsrf.pair,
    },
    body: form({ csrf: probeToken.replaceAll('&amp;', '&'), token: probe.token }),
  })
  assert(
    redeemed.status === 303 && redeemed.headers.location === '/auth/admin/setup?returnTo=%2F',
    `container-issued token did not redeem (${String(redeemed.status)} ${String(redeemed.headers.location)} ${redeemed.body.toString('utf8').slice(0, 180)})`,
  )
  const first = issueLoginToken(authStateFile, origin)
  const browser = await openBrowser(chromePort, `${origin}/auth/login`)
  try {
    await waitForBrowser(browser.evaluate, 'location.pathname === "/auth/login"', 'token flow starting login page')
    await browser.evaluate(`location.replace(${JSON.stringify(first.loginUrl)})`)
    await waitForBrowser(
      browser.evaluate,
      'location.pathname === "/auth/admin/setup" && location.hash === "" && document.querySelector("form") !== null',
      'first token setup page',
    )
    await browser.evaluate('document.querySelector("a.button.secondary")?.click()')
    await signOutFromSettings(browser, 'Later returnTo', 'sign out after Later')
    const second = issueLoginToken(authStateFile, origin)
    await browser.evaluate(`location.replace(${JSON.stringify(second.loginUrl)})`)
    await waitForBrowser(
      browser.evaluate,
      'location.pathname === "/auth/admin/setup" && document.querySelector("form") !== null',
      'second token setup page',
    )
    await browser.evaluate(`(() => {
      const usernameInput = document.querySelector('input[name="username"]')
      const passwordInput = document.querySelector('input[name="password"]')
      const confirm = document.querySelector('input[name="confirmPassword"]')
      const form = document.querySelector('form')
      if (!(usernameInput instanceof HTMLInputElement) || !(passwordInput instanceof HTMLInputElement) || !(confirm instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) return false
      usernameInput.value = ${JSON.stringify(username)}
      passwordInput.value = ${JSON.stringify(password)}
      confirm.value = ${JSON.stringify(password)}
      form.requestSubmit()
      return true
    })()`)
    await waitForBrowser(browser.evaluate, AUTHENTICATED_SPA, 'setup saved returnTo')
    await browser.clearCookies()
  } finally {
    browser.close()
  }
}

/**
 * A freshly pre-installed bundle must leave an unconfigured Web usable with
 * zero authentication surface, and a partially configured one must fail
 * closed with a diagnostic before any authenticated phase starts.
 */
async function verifyDormantPreinstall(authStateFile) {
  const dormantEnvironment = { ...process.env, DSH_HOME: home }
  delete dormantEnvironment.DSH_AUTH_STATE_FILE
  delete dormantEnvironment.DSH_AUTH_SESSION_SECRET_FILE
  const dormantPort = await availablePort()
  const dormantProcess = child(dshExecutable, ['web', '--port', String(dormantPort)], {
    cwd: launchCwd, env: dormantEnvironment,
  })
  try {
    await waitUntil(async () => (await fetch(`http://127.0.0.1:${String(dormantPort)}/`)).status === 200, 'dormant DSH', [
      { name: 'dormant DSH', process: dormantProcess },
    ])
    const dormantIndex = await (await fetch(`http://127.0.0.1:${String(dormantPort)}/`)).text()
    assert(!dormantIndex.includes('"id":"dsh-auth"'), 'dormant bundle entered the client boot roster')
    const dormantLogin = await fetch(`http://127.0.0.1:${String(dormantPort)}/auth/login`)
    const dormantLoginHtml = await dormantLogin.text()
    assert(
      dormantLogin.status === 200
        && dormantLoginHtml.includes('window.__DSH_BOOT__')
        && !dormantLoginHtml.includes('name="password"'),
      'dormant bundle exposed an authentication route',
    )
  } finally {
    await terminate(dormantProcess)
  }

  const partialEnvironment = { ...dormantEnvironment, DSH_AUTH_STATE_FILE: authStateFile }
  const partialPort = await availablePort()
  const partialProcess = child(dshExecutable, ['web', '--port', String(partialPort)], {
    cwd: launchCwd, env: partialEnvironment,
  })
  const partialExit = await new Promise(resolve => {
    const timer = setTimeout(() => {
      partialProcess.kill('SIGKILL')
      resolve(null)
    }, 30_000)
    partialProcess.once('exit', code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  assert(partialExit !== 0 && partialExit !== null, `partial core configuration booted (exit ${String(partialExit)})`)
  assert(partialProcess.testOutput().includes('invalid config'), 'partial core configuration failed without a diagnostic')
  return { dormantBoot: 'web usable without auth surface', partialConfig: `exit ${String(partialExit)}` }
}

// eslint-disable-next-line max-lines-per-function, max-statements -- 真实 E2E 按部署→令牌或密码登录→受保护资源→重启→浏览器的时间顺序编排；STORY-06 将契约改为 v2 authStateFile 与默认 Caddy。
async function main() {
  const tarball = packageTarball()
  const harnessVersion = checked(dshExecutable, ['--version']).trim()
  if (harnessVersion.length === 0) throw new Error('DSH executable returned an empty version')
  caddyExecutable = await resolveCaddyBinary()
  const { hashPassword } = await import('../lib/password.js')
  const authState = await import('../lib/auth-state.js')
  const password = randomBytes(24).toString('base64url')
  const passwordHash = await hashPassword(password)
  const sessionSecret = randomBytes(48).toString('base64url')
  const layout = writeAuthLayout(authState, passwordHash, sessionSecret, bootstrap === 'password')
  const username = bootstrap === 'password' ? 'integration-account' : 'operator-admin'

  checked(dshExecutable, [
    'plugin', '--profile', 'web', 'add', '--offline', '--config.auto-install-peers=false', tarball,
  ], { cwd: checkout, env: { ...process.env, DSH_HOME: home } })
  const settingsFile = join(home, 'settings.yaml')
  writeFileSync(settingsFile, 'locale:\n  preference: zh\nui-theme:\n  preference: dark\n')

  const preinstall = await verifyDormantPreinstall(layout.authStateFile)

  const dshPort = await availablePort()
  const httpPort = await availablePort()
  const httpsPort = await availablePort()
  const chromePort = await availablePort()
  const dshEnvironment = {
    ...process.env,
    DSH_HOME: home,
    DSH_AUTH_STATE_FILE: layout.authStateFile,
    DSH_AUTH_SESSION_SECRET_FILE: layout.secretFile,
    DSH_AUTH_LOGIN_TOKEN_ENABLED: 'true',
    DSH_AUTH_LOGIN_TOKEN_DIRECTORY: layout.tokenDirectory,
    DSH_AUTH_TRUSTED_PROXY_ADDRESSES: edgeRuntime === 'nginx' ? '127.0.0.2' : '127.0.0.1,::1',
    DSH_AUTH_SESSION_RENEWAL_SECONDS: '1',
  }
  dshProcess = child(dshExecutable, ['web', '--port', String(dshPort)], { cwd: launchCwd, env: dshEnvironment })
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${String(dshPort)}/auth/login`)
    return response.status === 200
  }, 'DSH', [{ name: 'DSH', process: dshProcess }])

  const certificate = join(nginxRoot, 'certificate.pem')
  const key = join(nginxRoot, 'key.pem')
  checked('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', key, '-out', certificate,
  ])
  if (edgeRuntime === 'nginx') {
    const replacements = new Map([
      ['${DSH_UPSTREAM}', `127.0.0.1:${String(dshPort)}`],
      ['${DSH_HTTP_LISTEN}', `127.0.0.1:${String(httpPort)}`],
      ['${DSH_HTTPS_LISTEN}', `127.0.0.1:${String(httpsPort)}`],
      ['${DSH_PUBLIC_SERVER_NAME}', 'localhost'],
      ['${DSH_PUBLIC_HTTPS_AUTHORITY}', `localhost:${String(httpsPort)}`],
      ['${DSH_TLS_CERTIFICATE}', certificate],
      ['${DSH_TLS_CERTIFICATE_KEY}', key],
      ['${DSH_LOGIN_RATE}', '100r/s'],
      ['${DSH_LOGIN_BURST}', '20'],
    ])
    let rendered = readFileSync(join(checkout, 'deploy/nginx/dsh-auth.conf.template'), 'utf8')
    for (const [placeholder, value] of replacements) rendered = rendered.replaceAll(placeholder, value)
    rendered = rendered.replace('    client_max_body_size 170m;', '    client_max_body_size 170m;\n    proxy_bind 127.0.0.2;')
    const nginxConfig = join(nginxRoot, 'nginx.conf')
    writeFileSync(nginxConfig, [
      `pid ${join(nginxRoot, 'nginx.pid')};`,
      `error_log ${join(nginxRoot, 'error.log')} notice;`,
      'events {}',
      'http {',
      `  access_log ${join(nginxRoot, 'access.log')};`,
      rendered,
      '}',
      '',
    ].join('\n'))
    checked('nginx', ['-t', '-p', nginxRoot, '-c', nginxConfig])
    edgeProcess = child('nginx', ['-p', nginxRoot, '-c', nginxConfig, '-g', 'daemon off;'], { cwd: checkout })
  } else {
    const caddyConfig = join(nginxRoot, 'Caddyfile')
    writeFileSync(caddyConfig, renderCaddyfile({
      publicHost: 'localhost', httpPort, httpsPort, listenAddress: '127.0.0.1',
      upstream: `127.0.0.1:${String(dshPort)}`,
      tls: caddyTls === 'internal' ? { mode: 'internal' } : { mode: 'manual', certificate, key },
      accessLogFile: join(nginxRoot, 'caddy-access.log'),
    }))
    checked(caddyExecutable, ['validate', '--config', caddyConfig, '--adapter', 'caddyfile'], {
      env: { ...process.env, XDG_DATA_HOME: join(nginxRoot, 'data'), XDG_CONFIG_HOME: join(nginxRoot, 'config') },
    })
    edgeProcess = child(caddyExecutable, ['run', '--config', caddyConfig, '--adapter', 'caddyfile'], {
      cwd: checkout,
      env: { ...process.env, XDG_DATA_HOME: join(nginxRoot, 'data'), XDG_CONFIG_HOME: join(nginxRoot, 'config') },
    })
  }
  await waitUntil(async () => (await request(httpsPort, '/auth/login')).status === 200, edgeRuntime, [
    { name: 'DSH', process: dshProcess },
    { name: edgeRuntime, process: edgeProcess },
  ])

  chromeProcess = child(browserExecutable, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--ignore-certificate-errors',
    '--window-size=1280,900', `--user-data-dir=${join(root, 'chrome')}`,
    `--remote-debugging-port=${String(chromePort)}`, 'about:blank',
  ], { cwd: checkout })
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${String(chromePort)}/json/version`)).ok, 'Chrome', [
    { name: 'DSH', process: dshProcess },
    { name: edgeRuntime, process: edgeProcess },
    { name: 'Chrome', process: chromeProcess },
  ])

  const harnessStyled = await request(httpsPort, '/auth/login?lang=en&theme=light', {
    headers: { 'accept-language': 'en-US,en;q=0.9' },
  })
  const harnessStyledHtml = harnessStyled.body.toString('utf8')
  assert(
    harnessStyledHtml.includes('<html lang="zh-CN">')
      && harnessStyledHtml.includes('<body data-theme="dark">')
      && !harnessStyledHtml.includes('class="preferences"'),
    'authentication UI did not use Harness locale/theme settings exclusively',
  )
  writeFileSync(settingsFile, 'locale:\n  preference: en\nui-theme:\n  preference: light\n')
  await waitUntil(async () => {
    const response = await request(httpsPort, '/auth/login')
    const html = response.body.toString('utf8')
    return html.includes('<html lang="en">') && html.includes('<body data-theme="light">')
  }, 'Harness UI settings reload')

  const httpRedirect = await requestHttp(httpPort, '/workspace?tab=recent')
  assert(
    httpRedirect.status === 308
      && httpRedirect.headers.location === `https://localhost:${String(httpsPort)}/workspace?tab=recent`,
    'HTTP did not redirect to the configured canonical HTTPS authority',
  )
  const unknownHost = await request(httpsPort, '/', { headers: { host: 'attacker.example' } })
  assert(
    unknownHost.status === 421 && unknownHost.headers.location === undefined,
    `unknown Host was not rejected (status ${String(unknownHost.status)}, location ${String(unknownHost.headers.location)})`,
  )

  const pageDenied = await request(httpsPort, '/')
  assert(
    pageDenied.status === 303,
    `unauthenticated page did not redirect (status ${String(pageDenied.status)}, location ${String(pageDenied.headers.location)})`,
  )
  const loginRedirect = new URL(pageDenied.headers.location, `https://localhost:${String(httpsPort)}`)
  assert(
    loginRedirect.origin === `https://localhost:${String(httpsPort)}`
      && loginRedirect.pathname === '/auth/login'
      && loginRedirect.searchParams.get('returnTo') === '/',
    `page redirect did not preserve a safe same-origin path (${String(pageDenied.headers.location)})`,
  )
  assert((await request(httpsPort, '/api/host.describe')).status === 401, 'unauthenticated API was not 401')
  assert((await request(httpsPort, '/auth/verify')).status === 404, 'verify route was public')
  assert((await request(httpsPort, '/auth/browser-bootstrap.js')).status === 404, 'HTTP compatibility script was served in HTTPS mode')
  const unauthenticatedWebSocket = await websocketStatus(httpsPort)
  assert(unauthenticatedWebSocket === 401, `unauthenticated WebSocket returned ${String(unauthenticatedWebSocket)}`)
  const unauthenticatedSse = await sseStatus(httpsPort)
  const expectedSseDenial = edgeRuntime === 'caddy' ? 401 : 303
  assert(unauthenticatedSse.status === expectedSseDenial, 'unauthenticated SSE was not rejected')
  assert(await http2Status(httpsPort, '/auth/login') === 200, `${edgeRuntime} did not negotiate HTTP/2`)
  const oversizedLogin = await request(httpsPort, '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `padding=${'x'.repeat(21 * 1024)}`,
  })
  assert(oversizedLogin.status === 413, `${edgeRuntime} did not reject an oversized authentication body`)

  if (bootstrap === 'login-token') {
    await completeTokenOnboarding(httpsPort, chromePort, layout.authStateFile, username, password)
  }

  const login = await request(httpsPort, '/auth/login?returnTo=%2Fworkspace')
  const loginHtml = login.body.toString('utf8')
  const csrf = cookiePair(login.headers['set-cookie'], '__Host-dsh_auth_csrf')
  const commonPostHeaders = {
    origin: `https://localhost:${String(httpsPort)}`,
    'content-type': 'application/x-www-form-urlencoded',
  }
  const wrong = await request(httpsPort, '/auth/login', {
    method: 'POST',
    headers: { ...commonPostHeaders, cookie: csrf.pair },
    body: form({
      csrf: hidden(loginHtml, 'csrf'), returnTo: '/workspace', username,
      password: randomBytes(24).toString('base64url'),
    }),
  })
  assert(wrong.status === 401, 'wrong login was not rejected')

  const fresh = await request(httpsPort, '/auth/login?returnTo=%2Fworkspace')
  const freshHtml = fresh.body.toString('utf8')
  const freshCsrf = cookiePair(fresh.headers['set-cookie'], '__Host-dsh_auth_csrf')
  const accepted = await request(httpsPort, '/auth/login', {
    method: 'POST',
    headers: { ...commonPostHeaders, cookie: freshCsrf.pair },
    body: form({
      csrf: hidden(freshHtml, 'csrf'), returnTo: '/workspace', username, password,
    }),
  })
  assert(accepted.status === 303 && accepted.headers.location === '/workspace', 'correct login did not return to the SPA path')
  const session = cookiePair(accepted.headers['set-cookie'], '__Host-dsh_auth_session')
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
    assert(session.field.includes(attribute), `session cookie omitted ${attribute}`)
  }

  await new Promise(resolveTimeout => setTimeout(resolveTimeout, 1_100))
  const spa = await request(httpsPort, '/', { headers: { cookie: session.pair } })
  const spaHtml = spa.body.toString('utf8')
  assert(spa.status === 200 && spaHtml.includes('window.__DSH_BOOT__'), 'authenticated real SPA was unavailable')
  assert(
    (Array.isArray(spa.headers['set-cookie']) ? spa.headers['set-cookie'] : [spa.headers['set-cookie']])
      .some(field => field?.startsWith('__Host-dsh_auth_session=')),
    `${edgeRuntime} did not forward the renewed session cookie from the authentication check`,
  )
  assert(!spaHtml.includes('browser-bootstrap.js'), 'HTTPS SPA included the HTTP compatibility script')
  const sessionView = await request(httpsPort, '/auth/session', { headers: { cookie: session.pair } })
  const sessionJson = JSON.parse(sessionView.body.toString('utf8'))
  assert(sessionView.status === 200 && sessionJson.user.userId === 'admin', 'session identity was unavailable')
  const assetPath = /<script[^>]+src="([^"]+\.js)"/u.exec(spaHtml)?.[1]
  assert(assetPath !== undefined, 'SPA entry asset was not discoverable')
  assert((await request(httpsPort, assetPath, { headers: { cookie: session.pair } })).status === 200, 'SPA asset was unavailable')
  const authClient = await request(httpsPort, '/plugins/dsh-auth/client.js', { headers: { cookie: session.pair } })
  assert(
    authClient.status === 200 && authClient.body.toString('utf8').includes('id: "dsh-auth"'),
    'dsh-auth browser client bundle was not discovered',
  )

  const rpcBody = JSON.stringify({
    type: 'client-request', rpcId: 'dsh-auth-integration', method: 'session.create', payload: {},
  })
  const createdResponse = await request(httpsPort, '/api/session.create', {
    method: 'POST',
    headers: { ...commonPostHeaders, cookie: session.pair, 'content-type': 'application/json' },
    body: rpcBody,
  })
  assert(createdResponse.status === 200, 'authenticated real API was unavailable')
  const created = JSON.parse(createdResponse.body.toString('utf8'))
  assert(created.result?.ok === true, 'session.create returned a business error')
  const sessionId = created.result.value.sessionId
  const downloadPath = `/api/session.export?sessionId=${encodeURIComponent(sessionId)}`
  const downloadHead = await request(httpsPort, downloadPath, { method: 'HEAD', headers: { cookie: session.pair } })
  assert(downloadHead.status === 200, 'authenticated download preflight failed')
  const download = await request(httpsPort, downloadPath, { headers: { cookie: session.pair } })
  assert(download.status === 200 && download.body.length > 0, 'authenticated download returned no artifact')
  const sse = await sseStatus(httpsPort, session.pair)
  assert(
    sse.status === 200 && sse.contentType === 'text/event-stream' && sse.initialFrame === true,
    'authenticated SSE did not deliver its initial frame',
  )
  assert(await websocketStatus(httpsPort, session.pair) === 101, 'authenticated real WebSocket did not upgrade')

  await terminate(dshProcess)
  dshProcess = child(dshExecutable, ['web', '--port', String(dshPort)], { cwd: launchCwd, env: dshEnvironment })
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${String(dshPort)}/auth/login`)
    return response.status === 200
  }, 'restarted DSH', [{ name: 'DSH', process: dshProcess }])
  const afterRestartSession = await request(httpsPort, '/auth/session', { headers: { cookie: session.pair } })
  const afterRestartIdentity = JSON.parse(afterRestartSession.body.toString('utf8'))
  assert(
    afterRestartSession.status === 200 && afterRestartIdentity.user?.userId === 'admin',
    'persisted session identity did not survive a DSH restart',
  )
  const afterRestartSpa = await request(httpsPort, '/', { headers: { cookie: session.pair } })
  assert(afterRestartSpa.status === 200, 'persisted session did not reach the protected SPA after a DSH restart')

  const browser = await openBrowser(chromePort, 'about:blank')
  try {
    await browser.clearCookies()
    await browser.navigate(`https://localhost:${String(httpsPort)}/auth/login`)
    await waitForBrowser(browser.evaluate, 'document.readyState === "complete" && document.querySelector("form") !== null', 'browser login page')
    await browser.evaluate(`(() => {
      const username = document.querySelector('input[name="username"]')
      const password = document.querySelector('input[name="password"]')
      const form = document.querySelector('form')
      if (!(username instanceof HTMLInputElement) || !(password instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) return false
      username.value = ${JSON.stringify(username)}
      password.value = ${JSON.stringify(password)}
      form.requestSubmit()
      return true
    })()`)
    await openHarnessSettings(browser, 'Harness authenticated SPA')
    await waitForBrowser(
      browser.evaluate,
      'document.querySelector(".dsh-auth-password") !== null && document.querySelector(".dsh-auth-logout") !== null',
      'Settings account rows',
    )
    const accountView = await browser.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.dsh-auth-settings-row'))
      const password = document.querySelector('.dsh-auth-password')
      const logout = document.querySelector('.dsh-auth-logout')
      return {
        passwordTitle: rows.find(row => row.querySelector('.dsh-auth-password'))?.querySelector('.dsh-auth-settings-title')?.textContent?.trim(),
        passwordAction: password?.textContent?.trim(),
        logoutTitle: rows.find(row => row.querySelector('.dsh-auth-logout'))?.querySelector('.dsh-auth-settings-title')?.textContent?.trim(),
        logoutAction: logout?.textContent?.trim(),
      }
    })()`)
    assert(
      accountView.passwordTitle === 'Reset password' && accountView.passwordAction === 'Reset',
      'Settings password-reset row did not follow the active locale',
    )
    assert(
      accountView.logoutTitle === 'Current session' && accountView.logoutAction === 'Sign out',
      'Settings sign-out row did not follow the active locale',
    )
    await browser.evaluate('document.querySelector(".dsh-auth-logout")?.click()')
    await waitForBrowser(browser.evaluate, 'location.pathname === "/auth/login"', 'browser logout redirect')
  } finally {
    browser.close()
  }

  const logoutToken = await request(httpsPort, '/auth/csrf', { headers: { cookie: session.pair } })
  const logoutCsrf = cookiePair(logoutToken.headers['set-cookie'], '__Host-dsh_auth_csrf')
  const logoutTokenJson = JSON.parse(logoutToken.body.toString('utf8'))
  assert(logoutToken.status === 200 && typeof logoutTokenJson.csrf === 'string', 'settings logout token was unavailable')
  const logout = await request(httpsPort, '/auth/logout', {
    method: 'POST',
    headers: { ...commonPostHeaders, cookie: `${session.pair}; ${logoutCsrf.pair}` },
    body: form({ csrf: logoutTokenJson.csrf }),
  })
  assert(logout.status === 303, 'logout failed')
  assert((await request(httpsPort, '/auth/session', { headers: { cookie: session.pair } })).status === 401, 'logout did not revoke the session')
  assert((await request(httpsPort, '/api/host.describe', { headers: { cookie: session.pair } })).status === 401, 'revoked session still reached the API')
  assert((await request(httpsPort, '/api/host.describe', {
    headers: { cookie: '__Host-dsh_auth_session=tampered.value' },
  })).status === 401, 'tampered session reached the API')

  const listeners = checked('ss', ['-ltnp', `( sport = :${String(dshPort)} )`])
  assert(listeners.includes(`127.0.0.1:${String(dshPort)}`), 'DSH did not bind to loopback')
  assert(!listeners.includes(`0.0.0.0:${String(dshPort)}`) && !listeners.includes(`[::]:${String(dshPort)}`), 'DSH exposed a bypass listener')

  process.stdout.write(JSON.stringify({
    packageInstall: 'offline tarball',
    harnessVersion,
    preinstall: preinstall.dormantBoot,
    partialPreinstall: preinstall.partialConfig,
    edgeRuntime,
    bootstrap,
    http2: 200,
    harnessUiSettings: 'live locale/theme sync',
    canonicalHttpRedirect: httpRedirect.status,
    unknownHost: unknownHost.status,
    oversizedAuthBody: oversizedLogin.status,
    unauthenticatedPage: pageDenied.status,
    unauthenticatedApi: 401,
    unauthenticatedSse: unauthenticatedSse.status,
    unauthenticatedWebSocket: 401,
    httpsCompatibilityScript: 404,
    authenticatedSpa: spa.status,
    authClientBundle: authClient.status,
    authenticatedApi: createdResponse.status,
    authenticatedDownload: download.status,
    authenticatedSse: sse.status,
    authenticatedWebSocket: 101,
    sessionRenewal: `Set-Cookie via ${edgeRuntime === 'caddy' ? 'forward_auth' : 'auth_request'}`,
    sessionPersistence: 'survived DSH restart',
    browserSettingsSignOut: 'Settings -> Sign out -> /auth/login',
    browserSettingsPasswordReset: 'Settings -> Reset password',
    logoutRevocation: 401,
    tamperedCookie: 401,
    dshBind: '127.0.0.1',
    ...(bootstrap === 'login-token' ? { tokenOnboarding: 'later then setup', containerTokenIssue: 'json v2' } : {}),
  }, undefined, 2) + '\n')
}

try {
  await main()
} finally {
  await terminate(edgeProcess)
  await terminate(dshProcess)
  await terminate(chromeProcess)
  rmSync(root, { recursive: true, force: true })
}
