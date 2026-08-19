import { describe, expect, it } from 'vitest'
import { isOfflinePluginSpec, offlinePluginAddFlags } from '../src/installer/profile-package.js'

describe('offline plugin specs', () => {
  it('keeps absolute tarball paths and pnpm file: specs offline', () => {
    expect(isOfflinePluginSpec('/artifacts/dsh-auth-0.2.2.tgz')).toBe(true)
    expect(isOfflinePluginSpec('file:/artifacts/dsh-auth-0.2.2.tgz')).toBe(true)
    expect(isOfflinePluginSpec('dsh-auth@0.2.2')).toBe(false)
    expect(offlinePluginAddFlags('file:/artifacts/dsh-auth-0.2.2.tgz')).toEqual([
      '--offline',
      '--config.auto-install-peers=false',
    ])
    expect(offlinePluginAddFlags('dsh-auth@0.2.2')).toEqual([])
  })
})
