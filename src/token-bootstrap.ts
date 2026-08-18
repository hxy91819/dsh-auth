/** Same-origin bridge script filename served under the public auth prefix. */
export const TOKEN_BOOTSTRAP_FILE = 'token-bootstrap.js'

/** Meta tag carrying the signed CSRF value to the bridge script. */
const CSRF_META_NAME = 'dsh-auth-csrf'

/** DOM id of the server-rendered failure notice revealed without a valid fragment. */
const ERROR_NOTICE_ID = 'dsh-auth-token-error'

const TOKEN_BOOTSTRAP = `(() => {
  'use strict'
  const errorNotice = document.getElementById('${ERROR_NOTICE_ID}')
  const csrfMeta = document.querySelector('meta[name="${CSRF_META_NAME}"]')
  const revealError = () => { if (errorNotice !== null) errorNotice.hidden = false }
  if (csrfMeta === null) { revealError(); return }
  const fragment = window.location.hash
  if (fragment === '' || fragment === '#') { revealError(); return }
  const parameters = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment)
  const keys = Array.from(parameters.keys())
  if (keys.length !== 1 || keys[0] !== 'token' || parameters.getAll('token').length !== 1) { revealError(); return }
  const token = parameters.get('token') ?? ''
  if (token.length === 0 || token.length > 256) { revealError(); return }
  window.history.replaceState(null, '', window.location.pathname)
  const form = document.createElement('form')
  form.method = 'post'
  form.action = window.location.pathname
  const csrfField = document.createElement('input')
  csrfField.type = 'hidden'
  csrfField.name = 'csrf'
  csrfField.value = csrfMeta.content
  const tokenField = document.createElement('input')
  tokenField.type = 'hidden'
  tokenField.name = 'token'
  tokenField.value = token
  form.appendChild(csrfField)
  form.appendChild(tokenField)
  document.body.appendChild(form)
  form.submit()
})()`

/** Return the static fragment-bridge script body served same-origin. */
export function tokenBootstrapSource(): string {
  return TOKEN_BOOTSTRAP
}
