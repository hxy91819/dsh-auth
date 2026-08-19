import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthApplication } from '../src/application.js'
import { authStateSecretId, createAuthStateDocument } from '../src/auth-state.js'
import { resolveConfig } from '../src/config.js'
import type { ConfigInput, ResolvedConfig } from '../src/config.js'
import { hashPassword } from '../src/password.js'
import type { HarnessUiSettings } from '../src/preferences.js'
import type { AuthEventLogger } from '../src/logging.js'

/** Runtime-only credentials used by observable HTTP tests. */
export interface TestCredentials {
  readonly password: string
  readonly hash: string
  readonly secret: string
}

/** Generate fresh test credentials without storing a plaintext password in the repository. */
export async function testCredentials(): Promise<TestCredentials> {
  const password = randomBytes(24).toString('base64url')
  return {
    password,
    hash: await hashPassword(password),
    secret: randomBytes(48).toString('base64url'),
  }
}

/** Resolve a complete test configuration. */
export function testConfig(credentials: TestCredentials, overrides: ConfigInput = {}): ResolvedConfig {
  const root = mkdtempSync(join(tmpdir(), 'dsh-auth-test-config-'))
  const sessionSecretFile = overrides.sessionSecretFile ?? join(root, 'session-secret')
  const authStateFile = overrides.authStateFile ?? join(root, 'auth-state.json')
  mkdirSync(root, { recursive: true })
  if (overrides.sessionSecretFile === undefined) writeFileSync(sessionSecretFile, `${credentials.secret}\n`, { mode: 0o600 })
  if (!existsSync(authStateFile)) {
    const document = createAuthStateDocument(authStateSecretId(Buffer.from(credentials.secret)), {
      username: 'test-account',
      passwordHash: credentials.hash,
      configuredAt: Date.now(),
    })
    writeFileSync(authStateFile, `${JSON.stringify(document)}\n`, { mode: 0o600 })
  }
  return resolveConfig({
    authStateFile,
    sessionSecretFile,
    ...overrides,
  })
}

/** Running HTTP test application. */
export interface TestServer {
  readonly baseUrl: string
  readonly server: Server
}

/** Start the authentication application on an OS-assigned loopback port. */
export async function startTestServer(
  config: ResolvedConfig,
  now?: () => number,
  readHarnessUiSettings?: () => HarnessUiSettings,
  inspect?: (req: IncomingMessage) => void,
  logger?: AuthEventLogger,
): Promise<TestServer> {
  const application = new AuthApplication(config, now, readHarnessUiSettings, logger)
  const server = createServer((req, res) => {
    inspect?.(req)
    application.handle(req, res).catch((error: unknown) => {
      res.writeHead(500)
      res.end(error instanceof Error ? error.message : String(error))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return { baseUrl: `http://127.0.0.1:${String(port)}`, server }
}

/** Headers emitted by the trusted local Nginx proxy. */
export function proxyHeaders(client = '192.0.2.10'): Record<string, string> {
  return {
    origin: 'https://auth.test',
    'x-forwarded-host': 'auth.test',
    'x-forwarded-proto': 'https',
    'x-real-ip': client,
  }
}

/** Return one cookie pair from Set-Cookie response fields. */
export function cookiePair(headers: Headers, name: string): string {
  const field = headers.getSetCookie().find(value => value.startsWith(`${name}=`))
  if (field === undefined) throw new Error(`missing ${name} Set-Cookie`)
  return field.split(';', 1)[0] ?? ''
}

/** Extract a named hidden input value from the standalone HTML form. */
export function hiddenValue(html: string, name: string): string {
  const match = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`, 'u').exec(html)
  if (match?.[1] === undefined) throw new Error(`missing hidden input ${name}`)
  return match[1].replaceAll('&amp;', '&')
}
