import { createHash, randomBytes } from 'node:crypto'

/** Identity returned by an external authentication provider. */
export interface ExternalIdentity {
  readonly subject: string
  readonly username?: string
  readonly displayName?: string
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
    const loginName = typeof payload.Data.LoginName === 'string' ? payload.Data.LoginName.split('@', 1)[0] : undefined
    const subject = required(loginName, 'LoginName')
    const text = (key: string): string | undefined => typeof payload.Data?.[key] === 'string' ? payload.Data[key] : undefined
    const numberText = (key: string): string | undefined => typeof payload.Data?.[key] === 'number' ? String(payload.Data[key]) : text(key)
    const displayName = text('ChineseName')
    const email = text('Email')
    const departmentId = numberText('DeptId')
    const departmentName = text('DeptName')
    return {
      subject,
      ...(loginName === undefined ? {} : { username: loginName }),
      ...(displayName === undefined ? {} : { displayName }),
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
