import type { IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import { compactDecrypt } from 'jose'
import type { ExternalIdentity } from './external-identity.js'

export interface GatewayIdentityConfig {
  readonly token: string
  readonly safeMode: boolean
  readonly maxAgeSeconds?: number
}

/** Resolve and verify the identity assertion injected by a trusted TOF gateway. */
export async function resolveGatewayIdentity(req: IncomingMessage, config: GatewayIdentityConfig, now = Date.now()): Promise<ExternalIdentity | undefined> {
  const header = (name: string): string => typeof req.headers[name] === 'string' ? req.headers[name] as string : ''
  const timestamp = header('timestamp')
  const signature = header('signature')
  const sequence = header('x-rio-seq')
  if (timestamp === '' || signature === '' || sequence === '') return undefined
  const seconds = Number(timestamp)
  if (!Number.isInteger(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > (config.maxAgeSeconds ?? 180)) throw new Error('gateway identity timestamp expired')
  const extra = config.safeMode ? ['', '', ''] : [header('staffid'), header('staffname'), header('x-ext-data')]
  const expected = createHash('sha256').update(`${timestamp}${config.token}${sequence},${extra.join(',')}${timestamp}`, 'utf8').digest('hex').toUpperCase()
  if (signature.toUpperCase() !== expected) throw new Error('gateway identity signature invalid')
  const encrypted = header('x-tai-identity')
  if (encrypted !== '') {
    const decrypted = await compactDecrypt(encrypted, new TextEncoder().encode(config.token))
    const value = JSON.parse(new TextDecoder().decode(decrypted.plaintext)) as Record<string, unknown>
    const subject = typeof value.LoginName === 'string' ? value.LoginName.split('@', 1)[0] : undefined
    if (subject === undefined || typeof value.Expiration !== 'string') throw new Error('gateway identity payload invalid')
    const expiration = Date.parse(value.Expiration)
    if (!Number.isFinite(expiration) || expiration < now - 180_000) throw new Error('gateway identity expired')
    return { subject, username: subject, ...(typeof value.ChineseName === 'string' ? { displayName: value.ChineseName } : {}) }
  }
  const username = header('staffname')
  if (username === '') throw new Error('gateway identity missing')
  return { subject: username, username }
}
