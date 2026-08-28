import { createHash, randomBytes } from 'node:crypto'

/** Identity returned by an external authentication provider. */
export interface ExternalIdentity {
  readonly subject: string
  readonly username?: string
  readonly displayName?: string
  readonly picture?: string
  readonly email?: string
  readonly departmentId?: string
  readonly departmentName?: string
  readonly groups?: readonly string[]
}

/** Provider-neutral authorization-code contract. */
export interface ExternalIdentityProvider {
  readonly id: string
  readonly displayName: string
  authorizationUrl(input: { readonly state: string; readonly redirectUri: string; readonly nonce: string }): string
  exchangeCode(input: { readonly code: string; readonly redirectUri: string }): Promise<ExternalIdentity>
  logoutUrl?(input: { readonly redirectUri: string }): string | undefined
}

/** Encode a validated identity field for transport through a single HTTP header. */
export function encodeExternalIdentityHeader(value: string, label: string): string {
  if (value.length === 0 || /\p{C}/u.test(value) || Buffer.byteLength(value, 'utf8') > 512) {
    throw new Error(`identity ${label} cannot be represented in an auth header`)
  }
  let encoded: string
  try { encoded = encodeURIComponent(value) } catch { throw new Error(`identity ${label} cannot be represented in an auth header`) }
  if (Buffer.byteLength(encoded, 'ascii') > 2048) throw new Error(`identity ${label} cannot be represented in an auth header`)
  return encoded
}

/** Build the verified profile headers emitted by `/auth/verify`. */
export function externalIdentityHeaders(identity: ExternalIdentity): Record<string, string> {
  if (identity.picture !== undefined) assertHttpsPicture(identity.picture)
  return {
    'x-dsh-auth-subject': encodeExternalIdentityHeader(identity.subject, 'subject'),
    ...(identity.username === undefined ? {} : { 'x-dsh-auth-username': encodeExternalIdentityHeader(identity.username, 'username') }),
    ...(identity.displayName === undefined ? {} : { 'x-dsh-auth-display-name': encodeExternalIdentityHeader(identity.displayName, 'displayName') }),
    ...(identity.picture === undefined ? {} : { 'x-dsh-auth-picture': encodeExternalIdentityHeader(identity.picture, 'picture') }),
  }
}

/** Generate an unguessable value for OAuth state/nonce parameters. */
export function randomOAuthValue(): string {
  return randomBytes(32).toString('base64url')
}

/** Hash a value before putting it in a short-lived state cookie or log field. */
export function oauthValueFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function profileText(value: unknown, name: string, maxBytes = 512): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || /\p{C}/u.test(value)
    || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`external identity ${name} is invalid`)
  }
  return value
}

function assertHttpsPicture(picture: string): void {
  let url: URL
  try { url = new URL(picture) } catch { throw new Error('external identity picture is invalid') }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('external identity picture must be an HTTPS URL')
  }
}

/** IOA/Taihu authorization-code provider. The core remains unaware of Tencent-specific fields. */
export class TaihuAccessTokenProvider implements ExternalIdentityProvider {
  readonly id = 'ioa'
  readonly displayName = 'IOA'

  constructor(
    private readonly config: {
      readonly paasId: string
      readonly token: string
      readonly baseUrl: string
      readonly authorizationEndpoint?: string
      readonly accessTokenPath?: string
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  authorizationUrl(input: { readonly state: string; readonly redirectUri: string; readonly nonce: string }): string {
    const endpoint = this.config.authorizationEndpoint ?? 'https://passport.woa.com/modules/passport/signin.ashx'
    const url = new URL(endpoint)
    url.searchParams.set('oauth', 'true')
    url.searchParams.set('url', input.redirectUri)
    url.searchParams.set('appkey', this.config.paasId)
    url.searchParams.set('state', input.state)
    url.searchParams.set('nonce', input.nonce)
    return url.toString()
  }

  async exchangeCode(input: { readonly code: string; readonly redirectUri: string }): Promise<ExternalIdentity> {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = String(100000 + Math.floor(Math.random() * 900000))
    const signature = createHash('sha256')
      .update(`${timestamp}${this.config.token}${nonce}${timestamp}`, 'utf8')
      .digest('hex')
      .toUpperCase()
    const endpoint = new URL(this.config.accessTokenPath ?? '/ebus/tof4/api/v1/passport/AccessToken', this.config.baseUrl)
    endpoint.searchParams.set('code', required(input.code, 'code'))
    const response = await this.fetcher(endpoint, {
      headers: {
        'x-rio-paasid': this.config.paasId,
        'x-rio-nonce': nonce,
        'x-rio-timestamp': timestamp,
        'x-rio-signature': signature,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`external identity provider returned HTTP ${String(response.status)}`)
    const payload = await response.json() as { readonly Ret?: unknown; readonly ErrMsg?: unknown; readonly Data?: Record<string, unknown> }
    if (payload.Ret !== 0 || payload.Data === undefined) {
      throw new Error(typeof payload.ErrMsg === 'string' ? payload.ErrMsg : 'external identity provider rejected the code')
    }
    const loginName = profileText(typeof payload.Data.LoginName === 'string' ? payload.Data.LoginName.split('@', 1)[0] : undefined, 'username')
    const subject = required(loginName, 'LoginName')
    const text = (key: string): string | undefined => profileText(payload.Data?.[key], key)
    const numberText = (key: string): string | undefined => typeof payload.Data?.[key] === 'number' ? profileText(String(payload.Data[key]), key) : text(key)
    const picture = text('Picture') ?? text('AvatarUrl')
    if (picture !== undefined) assertHttpsPicture(picture)
    const displayName = text('ChineseName')
    const email = text('Email')
    const departmentId = numberText('DeptId')
    const departmentName = text('DeptName')
    return {
      subject,
      ...(loginName === undefined ? {} : { username: loginName }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(picture === undefined ? {} : { picture }),
      ...(email === undefined ? {} : { email }),
      ...(departmentId === undefined ? {} : { departmentId }),
      ...(departmentName === undefined ? {} : { departmentName }),
    }
  }

  logoutUrl(input: { readonly redirectUri: string }): string {
    const url = new URL('https://passport.woa.com/modules/passport/signout.ashx')
    url.searchParams.set('oauth', 'true')
    url.searchParams.set('appkey', this.config.paasId)
    url.searchParams.set('url', input.redirectUri)
    return url.toString()
  }
}
