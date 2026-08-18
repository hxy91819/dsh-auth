import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  REQUIRED_PACKAGE_FILES,
  assertRegistryVersionPublished,
  classifyRegistryStatus,
  expectedTarballFilename,
  isPublishedRegistryState,
  parseStableTag,
  validateArchivePaths,
  validateGitHubReleaseMetadata,
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

  it('requires a final GitHub Release with exactly the npm tarball and manifest', () => {
    const release = {
      tagName: identity.tag,
      name: identity.tag,
      body: 'Release notes\n',
      isDraft: false,
      isPrerelease: false,
      assets: [
        { name: identity.filename, size: 100, state: 'uploaded' },
        { name: 'manifest.json', size: 200, state: 'uploaded' },
      ],
    }
    expect(validateGitHubReleaseMetadata(release, identity.tag, 'Release notes\n')).toEqual([identity.filename, 'manifest.json'])
    expect(() => validateGitHubReleaseMetadata({ ...release, isDraft: true }, identity.tag, 'Release notes')).toThrow(/final stable/u)
    expect(() => validateGitHubReleaseMetadata({ ...release, body: 'Other notes' }, identity.tag, 'Release notes')).toThrow(/final stable/u)
    expect(() => validateGitHubReleaseMetadata({ ...release, assets: [...release.assets, { name: 'notes.md', size: 1, state: 'uploaded' }] }, identity.tag, 'Release notes')).toThrow(/asset set/u)
    expect(() => validateGitHubReleaseMetadata({ ...release, assets: [{ name: identity.filename, size: 0, state: 'new' }] }, identity.tag, 'Release notes')).toThrow(/incomplete/u)
  })

  it('keeps compiled lib files publishable while git still ignores the build tree', () => {
    const gitignore = readFileSync('.gitignore', 'utf8')
    const npmignore = readFileSync('.npmignore', 'utf8')
    const manifest: unknown = JSON.parse(readFileSync('package.json', 'utf8'))
    const files = manifest !== null && typeof manifest === 'object' && 'files' in manifest ? manifest.files : undefined
    expect(gitignore.split('\n')).toContain('lib/')
    expect(npmignore.split('\n').some(line => line === 'lib/' || line === 'lib')).toBe(false)
    expect(files).toEqual(expect.arrayContaining(['lib/**/*.js', 'lib/**/*.d.ts']))
  })

  it('requires safe published files and the complete pack dry-run report', () => {
    const entry = { name: 'dsh-auth', filename: identity.filename, version: identity.version, files: packageFiles.map(path => ({ path })) }
    const report = { 'dsh-auth': entry }
    expect(validatePackReport(report, identity.version).files).toEqual(packageFiles)
    expect(validatePackageFilePaths(packageFiles, identity.version)).toEqual(packageFiles)
    expect(() => validatePackageFilePaths([...packageFiles, 'src/private.ts'], identity.version)).toThrow(/forbidden/u)
    expect(() => validatePackageFilePaths([...packageFiles, '../secret'], identity.version)).toThrow(/unsafe/u)
    expect(() => validatePackReport([entry], identity.version)).toThrow(/npm 12/u)
    expect(() => validatePackReport({ 'dsh-auth': { ...entry, files: [] } }, identity.version)).toThrow(/missing required/u)
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

  it('requires both official registry views to converge on the release', () => {
    const versionResponse = { status: 200, body: { version: identity.version } }
    const packageResponse = {
      status: 200,
      body: { 'dist-tags': { latest: identity.version }, versions: { [identity.version]: {} } },
    }
    expect(isPublishedRegistryState(versionResponse, packageResponse, identity.version)).toBe(true)
    expect(isPublishedRegistryState(versionResponse, { ...packageResponse, body: { ...packageResponse.body, 'dist-tags': { latest: '0.1.12' } } }, identity.version)).toBe(false)
    expect(isPublishedRegistryState({ status: 404, body: {} }, packageResponse, identity.version)).toBe(false)
  })

  it('retries stale post-publish metadata and fails after the bound', async () => {
    let latestRequests = 0
    let waits = 0
    const fetchJson = (url: string) => {
      if (url.endsWith(`/${identity.version}`)) return Promise.resolve({ status: 200, body: { version: identity.version } })
      latestRequests += 1
      return Promise.resolve({
        status: 200,
        body: {
          'dist-tags': { latest: latestRequests === 1 ? '0.1.12' : identity.version },
          versions: { [identity.version]: {} },
        },
      })
    }
    await expect(assertRegistryVersionPublished(identity.tag, {
      attempts: 2,
      delayMs: 0,
      fetchJson,
      wait: () => {
        waits += 1
        return Promise.resolve()
      },
    })).resolves.toBeUndefined()
    expect(latestRequests).toBe(2)
    expect(waits).toBe(1)

    let failedRequests = 0
    await expect(assertRegistryVersionPublished(identity.tag, {
      attempts: 2,
      delayMs: 0,
      fetchJson: () => {
        failedRequests += 1
        return Promise.resolve({ status: 404, body: {} })
      },
      wait: () => Promise.resolve(),
    })).rejects.toThrow(/bounded retries/u)
    expect(failedRequests).toBe(4)
  })
})
