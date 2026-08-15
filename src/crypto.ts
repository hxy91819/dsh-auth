import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

function base64url(value: Buffer): string {
  return value.toString('base64url')
}

function decodeBase64url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  return decoded.toString('base64url') === value ? decoded : undefined
}

/** HMAC signer for opaque cookie values. */
export class CookieSigner {
  constructor(private readonly secret: Buffer) {}

  /** Return a random opaque value with an HMAC signature. */
  issue(): { readonly value: string; readonly token: string } {
    const token = base64url(randomBytes(32))
    return { token, value: `${token}.${this.signature(token)}` }
  }

  /** Verify and return the token portion of a signed value. */
  verify(value: string | undefined): string | undefined {
    if (value === undefined || value.length > 256) return undefined
    const dot = value.indexOf('.')
    if (dot <= 0 || dot !== value.lastIndexOf('.')) return undefined
    const token = value.slice(0, dot)
    const supplied = decodeBase64url(value.slice(dot + 1))
    if (supplied === undefined) return undefined
    const expected = createHmac('sha256', this.secret).update(token).digest()
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined
    return token
  }

  private signature(token: string): string {
    return base64url(createHmac('sha256', this.secret).update(token).digest())
  }
}

/** Constant-time comparison for short authentication form values. */
export function constantTimeTextEqual(left: string, right: string, secret: Buffer): boolean {
  const digest = (value: string): Buffer => createHmac('sha256', secret).update(value).digest()
  return timingSafeEqual(digest(left), digest(right))
}
