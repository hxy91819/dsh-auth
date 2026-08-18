import { TLSSocket } from 'node:tls'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedConfig } from './config.js'

const MAX_FORM_BYTES = 20 * 1024

const HTML_SECURITY_HEADERS = {
  'cache-control': 'no-store, max-age=0',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const

const TOKEN_PAGE_SECURITY_HEADERS = {
  ...HTML_SECURITY_HEADERS,
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
} as const

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function normalizeRemoteAddress(value: string | undefined): string {
  if (value?.startsWith('::ffff:') === true) return value.slice('::ffff:'.length)
  return value ?? 'unknown'
}

function firstForwarded(value: string | undefined): string | undefined {
  return value?.split(',', 1)[0]?.trim()
}

function isTrustedProxy(req: IncomingMessage, config: ResolvedConfig): boolean {
  return config.trustedProxyAddresses.has(normalizeRemoteAddress(req.socket.remoteAddress))
}

export function clientAddress(req: IncomingMessage, config: ResolvedConfig): string {
  if (!isTrustedProxy(req, config)) return normalizeRemoteAddress(req.socket.remoteAddress)
  return firstForwarded(headerValue(req, 'x-real-ip'))
    ?? firstForwarded(headerValue(req, 'x-forwarded-for'))
    ?? normalizeRemoteAddress(req.socket.remoteAddress)
}

function publicOrigin(req: IncomingMessage, config: ResolvedConfig): string | undefined {
  const proxy = isTrustedProxy(req, config)
  const protocol = proxy
    ? firstForwarded(headerValue(req, 'x-forwarded-proto'))
    : req.socket instanceof TLSSocket ? 'https' : 'http'
  const host = proxy
    ? firstForwarded(headerValue(req, 'x-forwarded-host')) ?? req.headers.host
    : req.headers.host
  if ((protocol !== 'http' && protocol !== 'https') || host === undefined || /[\s\\/]/u.test(host)) return undefined
  try {
    return new URL(`${protocol}://${host}`).origin
  } catch {
    return undefined
  }
}

export function hasSameOrigin(req: IncomingMessage, config: ResolvedConfig): boolean {
  const expected = publicOrigin(req, config)
  if (expected === undefined) return false
  const supplied = headerValue(req, 'origin') ?? headerValue(req, 'referer')
  if (supplied === undefined) return false
  try {
    return new URL(supplied).origin === expected
  } catch {
    return false
  }
}

export function protectedRequestOriginAllowed(req: IncomingMessage, config: ResolvedConfig): boolean {
  const originalMethod = headerValue(req, 'x-original-method') ?? 'GET'
  const originalUpgrade = headerValue(req, 'x-original-upgrade')
  if ((originalMethod === 'GET' || originalMethod === 'HEAD') && !originalUpgrade) return true
  const fetchSite = headerValue(req, 'sec-fetch-site')
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  return hasSameOrigin(req, config)
}

/** Keep redirects on this origin and preserve only an absolute path/query. */
export function safeReturnTarget(value: string | null | undefined): string {
  if (value === undefined || value === null || value.length === 0 || value.length > 4096) return '/'
  let hasControl = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) {
      hasControl = true
      break
    }
  }
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || hasControl) return '/'
  try {
    const parsed = new URL(value, 'https://dsh-auth.invalid')
    if (parsed.origin !== 'https://dsh-auth.invalid') return '/'
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/'
  }
}

export function write(res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(body)
}

export function writeHtml(res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { ...HTML_SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(body)
}

export function writeTokenHtml(res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { ...TOKEN_PAGE_SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(body)
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(303, { ...HTML_SECURITY_HEADERS, location, ...headers })
  res.end()
}

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(status, {
    'cache-control': 'no-store, max-age=0',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

export function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const mediaType = headerValue(req, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/x-www-form-urlencoded') {
    return Promise.reject(new HttpError(415, 'form content type required'))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      req.removeAllListeners('data')
      req.removeAllListeners('end')
      req.resume()
      reject(error)
    }
    req.on('error', fail)
    req.on('aborted', () => { fail(new HttpError(400, 'request aborted')) })
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_FORM_BYTES) {
        fail(new HttpError(413, 'form too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
    })
  })
}
