import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('bundled Caddy packer', () => {
  it('documents the vendor layout and refuses a relative output directory', () => {
    const help = spawnSync('node', ['scripts/pack-caddy-platform.mjs', '--help'], { encoding: 'utf8' })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('vendor/caddy')
    expect(help.stdout).toContain('--clean')
    expect(help.stdout).toContain('linux-x64/caddy')
    expect(help.stdout).toContain('linux-arm64/caddy')

    const relative = spawnSync('node', ['scripts/pack-caddy-platform.mjs', '--output', 'vendor/caddy'], { encoding: 'utf8' })
    expect(relative.status).toBe(2)
    expect(relative.stderr).toContain('absolute directory')
  })

  it('refuses to replace an existing vendor directory without --clean', () => {
    const output = mkdtempSync(join(tmpdir(), 'dsh-auth-vendor-caddy-'))
    try {
      writeFileSync(join(output, 'keep.txt'), 'keep\n')
      const result = spawnSync('node', ['scripts/pack-caddy-platform.mjs', '--output', output], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('pass --clean')
      expect(readFileSync(join(output, 'keep.txt'), 'utf8')).toBe('keep\n')
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
