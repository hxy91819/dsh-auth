/** Authentication cookie name; `__Host-` forbids Domain and requires Secure plus Path=/. */
export const SESSION_COOKIE = '__Host-dsh_auth_session'

/** Login/logout CSRF cookie name. */
export const CSRF_COOKIE = '__Host-dsh_auth_csrf'

/** Session cookie name used only when an operator explicitly enables plain HTTP. */
export const INSECURE_SESSION_COOKIE = 'dsh_auth_session'

/** CSRF cookie name used only when an operator explicitly enables plain HTTP. */
export const INSECURE_CSRF_COOKIE = 'dsh_auth_csrf'

/** Select names that browsers accept for the configured transport security. */
export function cookieNames(secure: boolean): { readonly session: string; readonly csrf: string } {
  return secure
    ? { session: SESSION_COOKIE, csrf: CSRF_COOKIE }
    : { session: INSECURE_SESSION_COOKIE, csrf: INSECURE_CSRF_COOKIE }
}

/** Parse a Cookie request header without decoding attacker-controlled text. */
export function parseCookies(header: string | undefined): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  if (header === undefined || header.length > 16 * 1024) return result
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (!result.has(name)) result.set(name, value)
  }
  return result
}

/** Serialize one host-only authentication cookie. */
export function authCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  const expires = new Date(Date.now() + Math.max(0, maxAgeSeconds) * 1000).toUTCString()
  const security = secure ? '; Secure' : ''
  return `${name}=${value}; Path=/; Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}; Expires=${expires}; HttpOnly${security}; SameSite=Lax`
}
