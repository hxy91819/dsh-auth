/**
 * Run a disposable real DSH + dsh-auth tarball + TLS Nginx integration.
 *
 * Usage:
 *   DSH_INTEGRATION_CWD=/path/to/workspace node scripts/real-integration.mjs ./dsh-auth-<version>.tgz
 *
 * The workspace is read by DSH exactly as a normal launch directory. All
 * generated profile data, credentials, cookies, certificates, and logs live
 * in one temporary directory that is removed after exact child-PID shutdown.
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import WebSocket from 'ws'
import { hashPassword } from '../lib/password.js'

const checkout = resolve(import.meta.dirname, '..')
const tarballArgument = process.argv.slice(2).find(argument => argument !== '--')
const launchCwd = process.env.DSH_INTEGRATION_CWD
if (tarballArgument === undefined || launchCwd === undefined || !isAbsolute(launchCwd)) {
  throw new Error('provide a tarball argument and an absolute DSH_INTEGRATION_CWD')
}
const tarball = resolve(tarballArgument)
const root = mkdtempSync(join(tmpdir(), 'dsh-auth-real-integration-'))
const home = join(root, 'dsh-home')
const secrets = join(root, 'secrets')
const nginxRoot = join(root, 'nginx')
mkdirSync(secrets, { mode: 0o700 })
mkdirSync(nginxRoot, { recursive: true })

let dshProcess
let nginxProcess
let chromeProcess

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout}${result.stderr}`)
  return result.stdout
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
  process.stdout?.resume()
  process.stderr?.resume()
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

async function waitUntil(check, label) {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 200))
  }
  throw new Error(`${label} did not become ready${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
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
      ...client === https ? { rejectUnauthorized: false } : {},
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
  return { evaluate, close: () => { socket.close() } }
}

async function waitForBrowser(evaluate, expression, label) {
  await waitUntil(async () => await evaluate(expression) === true, label)
}

async function main() {
  const password = randomBytes(24).toString('base64url')
  const passwordHash = await hashPassword(password)
  const hashFile = join(secrets, 'password-hash')
  const secretFile = join(secrets, 'session-secret')
  writeFileSync(hashFile, `${passwordHash}\n`, { mode: 0o600 })
  writeFileSync(secretFile, `${randomBytes(48).toString('base64url')}\n`, { mode: 0o600 })

  checked('dsh', [
    'plugin', '--profile', 'web', 'add', '--offline', '--config.auto-install-peers=false', tarball,
  ], { cwd: checkout, env: { ...process.env, DSH_HOME: home } })
  const settingsFile = join(home, 'settings.yaml')
  writeFileSync(settingsFile, 'locale:\n  preference: zh\nui-theme:\n  preference: dark\n')

  const dshPort = await availablePort()
  const httpPort = await availablePort()
  const httpsPort = await availablePort()
  const chromePort = await availablePort()
  const dshEnvironment = {
    ...process.env,
    DSH_HOME: home,
    DSH_AUTH_USER_ID: 'integration-user',
    DSH_AUTH_USERNAME: 'integration-account',
    DSH_AUTH_ROLES: 'admin,operator',
    DSH_AUTH_TRUSTED_PROXY_ADDRESSES: '127.0.0.2',
    DSH_AUTH_PASSWORD_HASH_FILE: hashFile,
    DSH_AUTH_SESSION_SECRET_FILE: secretFile,
  }
  dshProcess = child('dsh', ['web', '--port', String(dshPort)], { cwd: launchCwd, env: dshEnvironment })
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${String(dshPort)}/auth/login`)
    return response.status === 200
  }, 'DSH')

  const certificate = join(nginxRoot, 'certificate.pem')
  const key = join(nginxRoot, 'key.pem')
  checked('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', key, '-out', certificate,
  ])
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
  nginxProcess = child('nginx', ['-p', nginxRoot, '-c', nginxConfig, '-g', 'daemon off;'], { cwd: checkout })
  await waitUntil(async () => (await request(httpsPort, '/auth/login')).status === 200, 'Nginx')

  chromeProcess = child('google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--ignore-certificate-errors',
    '--window-size=1280,900', `--user-data-dir=${join(root, 'chrome')}`,
    `--remote-debugging-port=${String(chromePort)}`, 'about:blank',
  ], { cwd: checkout })
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${String(chromePort)}/json/version`)).ok, 'Chrome')

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
  assert(unknownHost.status === 421 && unknownHost.headers.location === undefined, 'unknown Host was not rejected')

  const pageDenied = await request(httpsPort, '/')
  assert(
    pageDenied.status === 303,
    `unauthenticated page did not redirect (status ${String(pageDenied.status)}, location ${String(pageDenied.headers.location)})`,
  )
  const loginRedirect = new URL(pageDenied.headers.location)
  assert(
    loginRedirect.origin === `https://localhost:${String(httpsPort)}`
      && loginRedirect.pathname === '/auth/login'
      && loginRedirect.searchParams.get('returnTo') === '/',
    `page redirect did not preserve a safe same-origin path (${String(pageDenied.headers.location)})`,
  )
  assert((await request(httpsPort, '/api/host.describe')).status === 401, 'unauthenticated API was not 401')
  assert((await request(httpsPort, '/auth/verify')).status === 404, 'verify route was public')
  assert((await request(httpsPort, '/auth/browser-bootstrap.js')).status === 404, 'HTTP compatibility script was served in HTTPS mode')
  assert(await websocketStatus(httpsPort) === 401, 'unauthenticated WebSocket was not rejected')
  const oversizedLogin = await request(httpsPort, '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `padding=${'x'.repeat(21 * 1024)}`,
  })
  assert(oversizedLogin.status === 413, 'Nginx did not reject an oversized authentication body')

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
      csrf: hidden(loginHtml, 'csrf'), returnTo: '/workspace', username: 'integration-account',
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
      csrf: hidden(freshHtml, 'csrf'), returnTo: '/workspace', username: 'integration-account', password,
    }),
  })
  assert(accepted.status === 303 && accepted.headers.location === '/workspace', 'correct login did not return to the SPA path')
  const session = cookiePair(accepted.headers['set-cookie'], '__Host-dsh_auth_session')
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
    assert(session.field.includes(attribute), `session cookie omitted ${attribute}`)
  }

  const sessionView = await request(httpsPort, '/auth/session', { headers: { cookie: session.pair } })
  const sessionJson = JSON.parse(sessionView.body.toString('utf8'))
  assert(sessionView.status === 200 && sessionJson.user.userId === 'integration-user', 'session identity was unavailable')

  const spa = await request(httpsPort, '/', { headers: { cookie: session.pair } })
  const spaHtml = spa.body.toString('utf8')
  assert(spa.status === 200 && spaHtml.includes('window.__DSH_BOOT__'), 'authenticated real SPA was unavailable')
  assert(!spaHtml.includes('browser-bootstrap.js'), 'HTTPS SPA included the HTTP compatibility script')
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
    headers: { cookie: session.pair, 'content-type': 'application/json' },
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
  assert(await websocketStatus(httpsPort, session.pair) === 101, 'authenticated real WebSocket did not upgrade')

  const browser = await openBrowser(chromePort, `https://localhost:${String(httpsPort)}/auth/login`)
  try {
    await waitForBrowser(browser.evaluate, 'document.readyState === "complete" && document.querySelector("form") !== null', 'browser login page')
    await browser.evaluate(`(() => {
      const username = document.querySelector('input[name="username"]')
      const password = document.querySelector('input[name="password"]')
      const form = document.querySelector('form')
      if (!(username instanceof HTMLInputElement) || !(password instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) return false
      username.value = ${JSON.stringify('integration-account')}
      password.value = ${JSON.stringify(password)}
      form.requestSubmit()
      return true
    })()`)
    await waitForBrowser(
      browser.evaluate,
      'location.pathname === "/" && document.querySelector(".dsh-auth-logout") !== null',
      'Harness sidebar logout action',
    )
    const logoutView = await browser.evaluate(`(() => {
      const button = document.querySelector('.dsh-auth-logout')
      return button === null ? null : {
        label: button.textContent?.trim(),
        aria: button.getAttribute('aria-label'),
        wide: button.querySelector('.dsh-auth-logout-label') !== null,
      }
    })()`)
    assert(
      logoutView?.label === 'Sign out' && logoutView.aria === 'Sign out' && logoutView.wide === true,
      'Harness sidebar logout action did not follow the active locale or wide layout',
    )
    await browser.evaluate('document.querySelector(".dsh-auth-logout")?.click()')
    await waitForBrowser(browser.evaluate, 'location.pathname === "/auth/login"', 'browser logout redirect')
  } finally {
    browser.close()
  }

  const logoutToken = await request(httpsPort, '/auth/csrf', { headers: { cookie: session.pair } })
  const logoutCsrf = cookiePair(logoutToken.headers['set-cookie'], '__Host-dsh_auth_csrf')
  const logoutTokenJson = JSON.parse(logoutToken.body.toString('utf8'))
  assert(logoutToken.status === 200 && typeof logoutTokenJson.csrf === 'string', 'sidebar logout token was unavailable')
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
    harnessUiSettings: 'live locale/theme sync',
    canonicalHttpRedirect: httpRedirect.status,
    unknownHost: unknownHost.status,
    oversizedAuthBody: oversizedLogin.status,
    unauthenticatedPage: pageDenied.status,
    unauthenticatedApi: 401,
    unauthenticatedWebSocket: 401,
    httpsCompatibilityScript: 404,
    authenticatedSpa: spa.status,
    authClientBundle: authClient.status,
    authenticatedApi: createdResponse.status,
    authenticatedDownload: download.status,
    authenticatedWebSocket: 101,
    browserSidebarSignOut: 'Sign out -> /auth/login',
    logoutRevocation: 401,
    tamperedCookie: 401,
    dshBind: '127.0.0.1',
  }, undefined, 2) + '\n')
}

try {
  await main()
} finally {
  await terminate(nginxProcess)
  await terminate(dshProcess)
  await terminate(chromeProcess)
  rmSync(root, { recursive: true, force: true })
}
