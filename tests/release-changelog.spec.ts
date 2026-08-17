import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractSection,
  main,
  pullRequestNumber,
  renderSection,
} from '../scripts/release-changelog.mjs'

const repositories: string[] = []

function git(repository: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function commit(repository: string, filename: string, subject: string, author = 'Release Tester'): void {
  writeFileSync(join(repository, filename), `${subject}\n`)
  git(repository, 'add', filename)
  const result = spawnSync('git', ['commit', '-m', subject], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: 'release@example.invalid' },
  })
  if (result.status !== 0) throw new Error(result.stderr)
}

function repository(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-auth-changelog-'))
  repositories.push(path)
  git(path, 'init', '--initial-branch=main')
  git(path, 'config', 'user.name', 'Release Tester')
  git(path, 'config', 'user.email', 'release@example.invalid')
  git(path, 'remote', 'add', 'origin', 'https://github.com/acme/dsh-auth.git')
  commit(path, 'initial.txt', 'Initial release')
  git(path, '-c', 'tag.gpgSign=false', 'tag', '-a', 'v0.1.13', '-m', 'v0.1.13')
  return path
}

afterEach(() => {
  for (const path of repositories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('release changelog', () => {
  it('renders stable sections and recognizes GitHub pull-request subjects', () => {
    expect(pullRequestNumber('Merge pull request #12 from acme/topic')).toBe(12)
    expect(pullRequestNumber('fix: preserve auth state (#13)')).toBe(13)
    expect(pullRequestNumber('fix: preserve auth state')).toBeUndefined()
    const section = renderSection('v0.1.14', 'v0.1.13', 'acme/dsh-auth', [{
      title: 'Fix auth state',
      reference: '`0123456`',
      credit: ' Thanks Maintainer.',
      contributor: 'Maintainer',
    }])
    expect(extractSection(`# Changelog\n\n${section}`, 'v0.1.14')).toBe(section)
  })

  it('prepends generated history and check rejects drift', () => {
    const root = repository()
    commit(root, 'feature.txt', 'feat: add release notes', 'Original Author')
    writeFileSync(join(root, 'package.json'), '{"name":"dsh-auth","version":"0.1.14"}\n')
    git(root, 'add', 'package.json')
    git(root, 'commit', '-m', 'release: prepare v0.1.14')
    const changelog = join(root, 'CHANGELOG.md')

    main(['prepend', '--tag', 'v0.1.14', '--target', 'HEAD', '--output', changelog], root)
    const generated = readFileSync(changelog, 'utf8')
    expect(generated).toContain('Changes since [v0.1.13]')
    expect(generated).toContain('Thanks Original Author.')
    git(root, 'add', 'CHANGELOG.md')
    git(root, 'commit', '-m', 'docs: update changelog')
    git(root, '-c', 'tag.gpgSign=false', 'tag', '-a', 'v0.1.14', '-m', 'v0.1.14')

    const notes = join(root, 'notes.md')
    expect(() => main([
      'check', '--tag', 'v0.1.14', '--target', 'v0.1.14', '--output', changelog, '--notes', notes,
    ], root)).not.toThrow()
    expect(readFileSync(notes, 'utf8')).toBe(extractSection(generated, 'v0.1.14'))
    expect(readFileSync(notes, 'utf8')).not.toContain('docs: update changelog')

    writeFileSync(changelog, generated.replace('feat: add release notes', 'changed by hand'))
    expect(() => main([
      'check', '--tag', 'v0.1.14', '--target', 'v0.1.14', '--output', changelog,
    ], root)).toThrow(/differs from generated release history/u)
  })

  it('writes release notes from offline pull-request metadata without crediting bots', () => {
    const root = repository()
    commit(root, 'dependency.txt', 'build: update dependency (#7)')
    const fixture = join(root, 'pull-requests.json')
    writeFileSync(fixture, JSON.stringify([{
      number: 7,
      title: 'Update dependency',
      author: 'dependabot[bot]',
      isBot: true,
      url: 'https://github.com/acme/dsh-auth/pull/7',
    }]))
    const notes = join(root, 'notes.md')

    main([
      'notes', '--tag', 'v0.1.14', '--target', 'HEAD', '--output', notes,
      '--repository', 'acme/dsh-auth', '--pr-data', fixture,
    ], root)

    const content = readFileSync(notes, 'utf8')
    expect(content).toContain('Update dependency ([#7](https://github.com/acme/dsh-auth/pull/7))')
    expect(content).not.toContain('Thanks @dependabot[bot]')
  })
})
