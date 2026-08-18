/** Public filename served by the authentication route in plain-HTTP mode. */
export const BROWSER_BOOTSTRAP_FILE = 'browser-bootstrap.js'

/** Meta name used by the browser half to discover the configured route prefix. */
const AUTH_BASE_PATH_META = 'dsh-auth-base-path'

const RANDOM_UUID_BOOTSTRAP = `(() => {
  const api = globalThis.crypto
  if (api === undefined || typeof api.randomUUID === 'function' || typeof api.getRandomValues !== 'function') return
  Object.defineProperty(api, 'randomUUID', {
    configurable: true,
    writable: true,
    value: () => {
      const bytes = api.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 15) | 64
      bytes[8] = (bytes[8] & 63) | 128
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
    },
  })
})()`

/** Return the static JavaScript body served to plain-HTTP browsers. */
export function browserBootstrapSource(): string {
  return RANDOM_UUID_BOOTSTRAP
}

function injectHeadTag(html: string, tag: string): string {
  const head = /<head(?:\s[^>]*)?>/iu.exec(html)
  if (head !== null) {
    const at = head.index + head[0].length
    return `${html.slice(0, at)}${tag}${html.slice(at)}`
  }
  const body = /<body(?:\s[^>]*)?>/iu.exec(html)
  if (body !== null) return `${html.slice(0, body.index)}${tag}${html.slice(body.index)}`
  const doctype = /<!doctype\s+html\s*>/iu.exec(html)
  if (doctype === null) return `${tag}${html}`
  const at = doctype.index + doctype[0].length
  return `${html.slice(0, at)}${tag}${html.slice(at)}`
}

/** Publish the validated authentication route prefix to the browser plugin. */
export function injectAuthBasePath(html: string, basePath: string): string {
  return injectHeadTag(html, `<meta name="${AUTH_BASE_PATH_META}" content="${basePath}">`)
}

/** Add a blocking same-origin script before the SPA module starts. */
export function injectBrowserBootstrap(html: string, basePath: string): string {
  return injectHeadTag(html, `<script src="${basePath}/${BROWSER_BOOTSTRAP_FILE}"></script>`)
}
