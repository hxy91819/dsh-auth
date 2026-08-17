import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  REQUIRED_PACKAGE_FILES,
  classifyRegistryStatus,
  expectedTarballFilename,
  parseStableTag,
  validateArchivePaths,
  validatePackageFilePaths,
  validatePackageVersion,
  validatePackReport,
  validateReleaseManifest,
  validateReleaseSource,
} from '../scripts/release-validation.mjs'

const temporaryRepositories: string[] = []

function git(repository: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git failed: ${args.join(' ')}`)
  return result.stdout.trim()
}

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0)) rmSync(repository, { recursive: true, force: true })
})

const identity = {
  tag: 'v0.1.13',
  version: '0.1.13',
  commit: '0123456789abcdef0123456789abcdef01234567',
  filename: 'dsh-auth-0.1.13.tgz',
}

const packageFiles = [...REQUIRED_PACKAGE_FILES, 'lib/client.js']

describe('release validation', () => {
  it('accepts only exact stable tags and derives the tarball name', () => {
    expect(parseStableTag('v0.1.13')).toBe('0.1.13')
    expect(expectedTarballFilename('0.1.13')).toBe('dsh-auth-0.1.13.tgz')
    for (const tag of ['0.1.13', 'v01.2.3', 'v1.2.3-alpha.1', 'v1.2.3+build', 'v1.2.3\n']) {
      expect(() => parseStableTag(tag)).toThrow(/stable/u)
    }
  })

  it('requires package identity to match the stable tag', () => {
    expect(validatePackageVersion({ name: 'dsh-auth', version: '0.1.13' }, 'v0.1.13')).toBe('0.1.13')
    expect(() => validatePackageVersion({ name: 'other', version: '0.1.13' }, 'v0.1.13')).toThrow(/package\.json/u)
    expect(() => validatePackageVersion({ name: 'dsh-auth', version: '0.1.12' }, 'v0.1.13')).toThrow(/package\.json/u)
  })

  it('requires the checked-out tag commit to be reachable from origin/main', () => {
    const repository = mkdtempSync(join(tmpdir(), 'dsh-auth-release-git-'))
    temporaryRepositories.push(repository)
    writeFileSync(join(repository, 'package.json'), JSON.stringify({ name: 'dsh-auth', version: '0.1.13' }))
    git(repository, ['init', '--initial-branch=main'])
    git(repository, ['config', 'user.name', 'release-test'])
    git(repository, ['config', 'user.email', 'release-test@example.invalid'])
    git(repository, ['add', 'package.json'])
    git(repository, ['commit', '-m', 'initial'])
    writeFileSync(join(repository, 'marker.txt'), 'tagged\n')
    git(repository, ['add', 'marker.txt'])
    git(repository, ['commit', '-m', 'tagged'])
    const tagCommit = git(repository, ['rev-parse', 'HEAD'])
    git(repository, ['-c', 'tag.gpgSign=false', 'tag', 'v0.1.13'])
    git(repository, ['update-ref', 'refs/remotes/origin/main', tagCommit])

    expect(validateReleaseSource(repository, 'v0.1.13')).toMatchObject({
      tag: 'v0.1.13',
      version: '0.1.13',
      commit: tagCommit,
    })

    git(repository, ['update-ref', 'refs/remotes/origin/main', `${tagCommit}^`])
    expect(() => validateReleaseSource(repository, 'v0.1.13')).toThrow(/origin\/main/u)
  })

  it('accepts a complete manifest only when every identity field matches', () => {
    const manifest = { ...identity, sha256: 'a'.repeat(64) }
    expect(validateReleaseManifest(manifest, identity)).toEqual(manifest)
    expect(() => validateReleaseManifest({ ...manifest, commit: 'f'.repeat(40) }, identity)).toThrow(/manifest/u)
    expect(() => validateReleaseManifest({ ...manifest, extra: true }, identity)).toThrow(/unexpected/u)
    expect(() => validateReleaseManifest({ ...manifest, sha256: 'short' }, identity)).toThrow(/SHA-256/u)
  })

  it('requires safe published files and the complete pack dry-run report', () => {
    const report = [{ name: 'dsh-auth', filename: identity.filename, version: identity.version, files: packageFiles.map(path => ({ path })) }]
    expect(validatePackReport(report, identity.version).files).toEqual(packageFiles)
    expect(validatePackageFilePaths(packageFiles, identity.version)).toEqual(packageFiles)
    expect(() => validatePackageFilePaths([...packageFiles, 'src/private.ts'], identity.version)).toThrow(/forbidden/u)
    expect(() => validatePackageFilePaths([...packageFiles, '../secret'], identity.version)).toThrow(/unsafe/u)
    expect(() => validatePackReport([{ name: 'dsh-auth', filename: identity.filename, version: identity.version, files: [] }], identity.version)).toThrow(/missing required/u)
  })

  it('matches the final archive to the dry-run list and rejects traversal', () => {
    const archive = ['package/', ...packageFiles.map(path => `package/${path}`)]
    expect(validateArchivePaths(archive, identity.version, packageFiles)).toEqual(packageFiles)
    expect(() => validateArchivePaths([...archive, 'other/secret'], identity.version, packageFiles)).toThrow(/outside package/u)
    expect(() => validateArchivePaths([...archive, 'package/../secret/'], identity.version, packageFiles)).toThrow(/unsafe/u)
  })

  it('treats only an exact 404 as an absent registry version', () => {
    expect(classifyRegistryStatus(404)).toBe('absent')
    expect(classifyRegistryStatus(200)).toBe('present')
    expect(classifyRegistryStatus(401)).toBe('error')
    expect(classifyRegistryStatus(429)).toBe('error')
    expect(classifyRegistryStatus(500)).toBe('error')
  })
})
