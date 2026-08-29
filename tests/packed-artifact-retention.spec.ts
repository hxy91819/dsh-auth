import { describe, expect, it } from 'vitest'
import { selectPackedArtifactRetention } from '../scripts/packed-artifact-retention.mjs'

describe('packed artifact retention', () => {
  it('keeps the latest completed packed artifact per source branch', () => {
    const artifacts = [
      { id: 10, name: 'packed-tarball', created_at: '2026-08-28T10:00:00Z', expired: true, workflow_run: { id: 100 } },
      { id: 11, name: 'packed-tarball', created_at: '2026-08-28T11:00:00Z', expired: false, workflow_run: { id: 101 } },
      { id: 12, name: 'packed-tarball', created_at: '2026-08-28T12:00:00Z', expired: false, workflow_run: { id: 102 } },
      { id: 20, name: 'packed-tarball', created_at: '2026-08-28T09:00:00Z', expired: true, workflow_run: { id: 200 } },
      { id: 30, name: 'dsh-auth-release', created_at: '2026-08-28T13:00:00Z', expired: false, workflow_run: { id: 300 } },
    ]
    const runs = new Map([
      [100, { status: 'completed', head_repository: { id: 1 }, head_branch: 'main' }],
      [101, { status: 'completed', head_repository: { id: 1 }, head_branch: 'main' }],
      [102, { status: 'in_progress', head_repository: { id: 1 }, head_branch: 'main' }],
      [200, { status: 'completed', head_repository: { id: 1 }, head_branch: 'feature' }],
      [300, { status: 'completed', head_repository: { id: 1 }, head_branch: 'main' }],
    ])

    expect(selectPackedArtifactRetention(artifacts, runs)).toEqual([
      { key: '1:main', kept: 11, stale: [10] },
      { key: '1:feature', kept: null, stale: [20] },
    ])
  })
})
