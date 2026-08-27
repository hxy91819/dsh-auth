import type { IncomingMessage } from 'node:http'
import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto'
import type { ExternalIdentity } from './external-identity.js'

export interface GatewayIdentityConfig {
  readonly token: string
  readonly safeMode: boolean
  readonly maxAgeSeconds?: number
}

const replayCache = new WeakMap<object, Map<string, number>>()

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='), 'base64')
}

function decryptIdentity(compact: string, token: string, now: number): Record<string, unknown> {
  const parts = compact.split('.')
  if (parts.length !== 5) throw new Error('gateway identity JWE invalid')
  const part = (index: number): string => {
    const value = parts[index]
    if (value === undefined) throw new Error('gateway identity JWE invalid')
    return value
  }
  const protectedPart = part(0)
  const encryptedKey = part(1)
  const ivPart = part(2)
  const ciphertextPart = part(3)
  const tagPart = part(4)
  if (encryptedKey !== '') throw new Error('gateway identity JWE alg invalid')
  let header: Record<string, unknown>
  try { header = JSON.parse(decodeBase64Url(protectedPart).toString('utf8')) as Record<string, unknown> } catch { throw new Error('gateway identity JWE header invalid') }
  if (header.alg !== 'dir' || header.enc !== 'A256GCM') throw new Error('gateway identity JWE algorithm invalid')
  const key = Buffer.from(token, 'utf8')
  if (key.length !== 32) throw new Error('gateway identity token must be 32 bytes for A256GCM')
  const decipher = createDecipheriv('aes-256-gcm', key, decodeBase64Url(ivPart))
  decipher.setAAD(Buffer.from(protectedPart, 'ascii'))
  decipher.setAuthTag(decodeBase64Url(tagPart))
  let payload: Record<string, unknown>
  try { payload = JSON.parse(Buffer.concat([decipher.update(decodeBase64Url(ciphertextPart)), decipher.final()]).toString('utf8')) as Record<string, unknown> } catch { throw new Error('gateway identity payload invalid') }
  if (typeof payload.LoginName !== 'string' || typeof payload.Expiration !== 'string') throw new Error('gateway identity payload invalid')
  const expiration = Date.parse(payload.Expiration)
  if (!Number.isFinite(expiration) || expiration < now) throw new Error('gateway identity expired')
  return payload
}

/** Resolve and verify the identity assertion injected by a trusted TOF gateway. */
// The protocol has several independent validation branches; keeping them together mirrors the signed field contract.
// eslint-disable-next-line complexity
export function resolveGatewayIdentity(req: IncomingMessage, config: GatewayIdentityConfig, now = Date.now()): ExternalIdentity | undefined {
  const header = (name: string): string => {
    const value = req.headers[name]
    return typeof value === 'string' ? value : ''
  }
  const timestamp = header('timestamp')
  const signature = header('signature')
  const sequence = header('x-rio-seq')
  if (timestamp === '' || signature === '' || sequence === '') return undefined
  const seconds = Number(timestamp)
  if (!Number.isInteger(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > (config.maxAgeSeconds ?? 180)) throw new Error('gateway identity timestamp expired')
  const extra = config.safeMode ? ['', '', ''] : [header('staffid'), header('staffname'), header('x-ext-data')]
  const cache = replayCache.get(config) ?? new Map<string, number>()
  replayCache.set(config, cache)
  for (const [key, seen] of cache) if (seen < now - (config.maxAgeSeconds ?? 180) * 1000) cache.delete(key)
  const replayKey = `${timestamp}:${sequence}`
  if (cache.has(replayKey)) throw new Error('gateway identity replayed')
  const expected = createHash('sha256').update(`${timestamp}${config.token}${sequence},${extra.join(',')}${timestamp}`, 'utf8').digest('hex').toUpperCase()
  const provided = Buffer.from(signature.toUpperCase(), 'ascii')
  const wanted = Buffer.from(expected, 'ascii')
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) throw new Error('gateway identity signature invalid')
  cache.set(replayKey, now)
  const encrypted = header('x-tai-identity')
  if (encrypted !== '') {
    const value = decryptIdentity(encrypted, config.token, now)
    const subject = typeof value.LoginName === 'string' ? value.LoginName.split('@', 1)[0] : undefined
    if (subject === undefined || typeof value.Expiration !== 'string') throw new Error('gateway identity payload invalid')
    return {
      subject,
      username: subject,
      ...(typeof value.ChineseName === 'string' ? { displayName: value.ChineseName } : {}),
      ...(typeof value.Email === 'string' ? { email: value.Email } : {}),
      ...(typeof value.DeptId === 'string' || typeof value.DeptId === 'number' ? { departmentId: String(value.DeptId) } : {}),
      ...(typeof value.DeptName === 'string' ? { departmentName: value.DeptName } : {}),
    }
  }
  const username = header('staffname')
  if (username === '') throw new Error('gateway identity missing')
  return { subject: username, username }
}
