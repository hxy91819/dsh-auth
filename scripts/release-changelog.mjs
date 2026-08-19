// @ts-check

/**
 * Generate, prepend, or verify one stable release section from first-parent Git history.
 *
 * Parameters:
 *   A command (`notes`, `prepend`, or `check`), an exact stable `--tag`, a
 *   `--target` Git ref, and an output/changelog path. `--repository` defaults
 *   to origin; `--pr-data` supplies deterministic PR metadata for offline tests.
 *
 * Outputs:
 *   `notes` writes one release section, `prepend` atomically updates the
 *   cumulative changelog, and `check` fails on drift and optionally writes the
 *   verified section to `--notes`. Every expected failure exits nonzero.
 *
 * Examples:
 *   node scripts/release-changelog.mjs prepend --tag v0.1.14 --target HEAD --output CHANGELOG.md
 *   node scripts/release-changelog.mjs check --tag v0.1.14 --target v0.1.14 --output CHANGELOG.md --notes release/release-notes.md
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStableTag, ReleaseValidationError } from './release-validation.mjs'

const MERGE_PR_PATTERN = /^Merge pull request #(\d+)\b/u
const SQUASH_PR_PATTERN = /\(#(\d+)\)$/u
const BREAKING_CHANGE_PATTERN = /^[a-z][a-z0-9-]*(?:\([^)]*\))?!:/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

/** @typedef {{title: string, reference: string, credit: string, contributor: string}} Change */
/** @typedef {{number: number, title: string, author: string, isBot: boolean, url: string}} PullRequest */

/** @param {string} command @param {string[]} args @param {{cwd?: string}} [options] @returns {string} */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error !== undefined) throw new Error(`${command} could not be started`)
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new ReleaseValidationError(`${command} failed${detail === '' ? '' : `: ${detail}`}`)
  }
  return result.stdout.trim()
}

/** @param {unknown} value @param {string} field @returns {string} */
function cleanText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new ReleaseValidationError(`missing ${field}`)
  return value.trim().split(/\s+/u).join(' ')
}

/** @param {string} repositoryRoot @returns {string} */
export function repositoryFromOrigin(repositoryRoot) {
  const origin = run('git', ['config', '--get', 'remote.origin.url'], { cwd: repositoryRoot })
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(origin)
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new ReleaseValidationError('cannot infer GitHub repository; pass --repository owner/name')
  }
  return `${match[1]}/${match[2]}`
}

/** @param {string} repositoryRoot @param {string} tag @param {string} target @returns {string | undefined} */
export function previousStableTag(repositoryRoot, tag, target) {
  parseStableTag(tag)
  run('git', ['rev-parse', '--verify', '--end-of-options', `${target}^{commit}`], { cwd: repositoryRoot })
  const tags = run('git', ['tag', '--sort=-v:refname', '--merged', target], { cwd: repositoryRoot }).split('\n')
  return tags.find(candidate => {
    if (candidate === '' || candidate === tag) return false
    try {
      parseStableTag(candidate)
      return true
    } catch {
      return false
    }
  })
}

/** @param {string} subject @returns {number | undefined} */
export function pullRequestNumber(subject) {
  for (const pattern of [MERGE_PR_PATTERN, SQUASH_PR_PATTERN]) {
    const value = pattern.exec(subject)?.[1]
    if (value !== undefined) return Number.parseInt(value, 10)
  }
  return undefined
}

/** @param {string} repositoryRoot @param {string} commit @returns {boolean} */
function isChangelogOnlyCommit(repositoryRoot, commit) {
  const paths = run('git', [
    'diff-tree', '--first-parent', '-m', '--no-commit-id', '--name-only', '-r', commit,
  ], { cwd: repositoryRoot }).split('\n').filter(Boolean)
  return paths.length > 0 && paths.every(path => path === 'CHANGELOG.md')
}

/** @param {string | undefined} path @returns {Map<number, PullRequest> | undefined} */
function loadPullRequests(path) {
  if (path === undefined) return undefined
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new ReleaseValidationError(`cannot read valid JSON from --pr-data ${path}`)
  }
  if (!Array.isArray(value)) throw new ReleaseValidationError('--pr-data must contain a JSON array')
  const records = new Map()
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ReleaseValidationError('--pr-data contains an invalid record')
    }
    const record = /** @type {Record<string, unknown>} */ (item)
    if (!Number.isInteger(record.number)) throw new ReleaseValidationError('--pr-data record number must be an integer')
    const number = /** @type {number} */ (record.number)
    records.set(number, {
      number,
      title: cleanText(record.title, `title for PR #${number}`),
      author: cleanText(record.author, `author for PR #${number}`),
      isBot: record.isBot === true,
      url: cleanText(record.url, `URL for PR #${number}`),
    })
  }
  return records
}

/** @param {number} number @param {string} repository @param {Map<number, PullRequest> | undefined} fixture @returns {PullRequest} */
function pullRequest(number, repository, fixture) {
  if (fixture !== undefined) {
    const record = fixture.get(number)
    if (record === undefined) throw new ReleaseValidationError(`--pr-data is missing PR #${number}`)
    return record
  }
  const value = JSON.parse(run('gh', ['api', `repos/${repository}/pulls/${number}`]))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReleaseValidationError(`GitHub returned invalid metadata for PR #${number}`)
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  const user = typeof record.user === 'object' && record.user !== null && !Array.isArray(record.user)
    ? /** @type {Record<string, unknown>} */ (record.user)
    : {}
  const author = cleanText(user.login, `author for PR #${number}`)
  return {
    number,
    title: cleanText(record.title, `title for PR #${number}`),
    author,
    isBot: user.type === 'Bot' || author.toLowerCase().endsWith('[bot]'),
    url: cleanText(record.html_url ?? `https://github.com/${repository}/pull/${number}`, `URL for PR #${number}`),
  }
}

/** @param {string} repositoryRoot @param {string} target @param {string | undefined} base @param {string} repository @param {string | undefined} fixturePath @returns {Change[]} */
export function collectChanges(repositoryRoot, target, base, repository, fixturePath) {
  if (!REPOSITORY_PATTERN.test(repository)) throw new ReleaseValidationError('--repository must be owner/name')
  const revision = base === undefined ? target : `${base}..${target}`
  const output = run('git', ['log', '--first-parent', '--format=%H%x00%h%x00%an%x00%s%x00', revision], { cwd: repositoryRoot })
  const fields = output === '' ? [] : output.split('\0').filter((field, index, values) => !(index === values.length - 1 && field === ''))
  if (fields.length % 4 !== 0) throw new ReleaseValidationError('git log returned an invalid release history')
  const fixture = loadPullRequests(fixturePath)
  const seenPullRequests = new Set()
  /** @type {Change[]} */
  const changes = []
  for (let index = 0; index < fields.length; index += 4) {
    const commit = fields[index]?.trim()
    const shortCommit = fields[index + 1]
    const authorName = fields[index + 2]
    const subject = fields[index + 3]
    if (commit === undefined || shortCommit === undefined || authorName === undefined || subject === undefined) {
      throw new ReleaseValidationError('git log omitted a release field')
    }
    if (isChangelogOnlyCommit(repositoryRoot, commit)) continue
    const number = pullRequestNumber(subject)
    if (number === undefined) {
      const author = cleanText(authorName, `author for commit ${shortCommit}`)
      const bot = author.toLowerCase().endsWith('[bot]')
      changes.push({
        title: cleanText(subject, `subject for commit ${shortCommit}`),
        reference: `\`${shortCommit}\``,
        credit: bot ? '' : ` Thanks ${author}.`,
        contributor: bot ? '' : author,
      })
      continue
    }
    if (seenPullRequests.has(number)) continue
    seenPullRequests.add(number)
    const metadata = pullRequest(number, repository, fixture)
    changes.push({
      title: metadata.title,
      reference: `[#${number}](${metadata.url})`,
      credit: metadata.isBot ? '' : ` Thanks @${metadata.author}.`,
      contributor: metadata.isBot ? '' : `@${metadata.author}`,
    })
  }
  return changes
}

/** @param {string[]} contributors @returns {string} */
function joinContributors(contributors) {
  const values = [...new Set(contributors.filter(Boolean))]
  if (values.length < 2) return values[0] ?? ''
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

/** @param {string} tag @param {string | undefined} base @param {string} repository @param {Change[]} changes @returns {string} */
export function renderSection(tag, base, repository, changes) {
  parseStableTag(tag)
  const lines = [`## ${tag}`, '']
  if (base === undefined) lines.push('Initial release.', '')
  else lines.push(`Changes since [${base}](https://github.com/${repository}/compare/${base}...${tag}).`, '')
  const breakingChanges = changes.filter(change => BREAKING_CHANGE_PATTERN.test(change.title))
  const regularChanges = changes.filter(change => !BREAKING_CHANGE_PATTERN.test(change.title))
  if (breakingChanges.length > 0) {
    lines.push('### Breaking changes', '')
    for (const change of breakingChanges) lines.push(`- ${change.title} (${change.reference}).${change.credit}`)
    lines.push('')
  }
  lines.push('### Changes', '')
  if (regularChanges.length === 0) lines.push('- No additional user-visible changes.')
  else for (const change of regularChanges) lines.push(`- ${change.title} (${change.reference}).${change.credit}`)
  const contributors = joinContributors(changes.map(change => change.contributor))
  if (contributors !== '') lines.push('', '### Contributors', '', `Thanks ${contributors} for this release.`)
  return `${lines.join('\n').trimEnd()}\n`
}

/** @param {string} path @param {string} content */
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

/** @param {string} content @param {string} tag @returns {string | undefined} */
export function extractSection(content, tag) {
  parseStableTag(tag)
  const marker = `## ${tag}\n`
  const start = content.indexOf(marker)
  if (start < 0 || (start > 0 && content[start - 1] !== '\n')) return undefined
  const next = content.indexOf('\n## ', start + marker.length)
  return `${content.slice(start, next < 0 ? content.length : next + 1).trimEnd()}\n`
}

/** @param {string} path @param {string} tag @param {string} section */
function prependSection(path, tag, section) {
  let remainder = ''
  try {
    const content = readFileSync(path, 'utf8')
    if (!content.startsWith('# Changelog\n')) throw new ReleaseValidationError(`${path} must start with '# Changelog'`)
    const existing = extractSection(content, tag)
    const withoutExisting = existing === undefined ? content : content.replace(existing, '')
    remainder = withoutExisting.slice('# Changelog\n'.length).trim()
  } catch (error) {
    if (error instanceof ReleaseValidationError) throw error
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  atomicWrite(path, `# Changelog\n\n${section.trim()}\n${remainder === '' ? '' : `\n${remainder}\n`}`)
}

const HELP = `Usage:
  node scripts/release-changelog.mjs <notes|prepend|check> --tag <vX.Y.Z> --target <ref> --output <path> [options]

Description:
  Generate one stable release section from first-parent Git history, preserve
  original pull-request authors, or verify a committed CHANGELOG.md section.

Options:
  --tag <vX.Y.Z>          Exact stable release tag.
  --target <ref>          Git ref containing the release; defaults to HEAD.
  --output <path>         Notes output, or CHANGELOG.md for prepend/check.
  --notes <path>          In check mode, write the verified section here.
  --repository <owner/repo> GitHub repository; defaults to origin.
  --pr-data <path>        Offline JSON pull-request metadata for tests.
  -h, --help              Show this help.

Outputs:
  notes writes one Markdown section; prepend atomically adds or replaces the
  section below '# Changelog'; check exits nonzero on drift and may write notes.

Examples:
  node scripts/release-changelog.mjs prepend --tag v0.1.14 --target HEAD --output CHANGELOG.md
  node scripts/release-changelog.mjs check --tag v0.1.14 --target v0.1.14 --output CHANGELOG.md --notes release/release-notes.md
`

/** @param {string[]} argv @returns {Map<string, string>} */
function parseOptions(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (name === undefined || !name.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new ReleaseValidationError('options must use --name value')
    }
    const key = name.slice(2)
    if (key === '' || options.has(key)) throw new ReleaseValidationError(`duplicate or empty option: ${name}`)
    if (/\0|\r|\n/u.test(value)) throw new ReleaseValidationError(`unsafe value for ${name}`)
    options.set(key, value)
  }
  return options
}

/** @param {Map<string, string>} options @param {string} name @returns {string} */
function requiredOption(options, name) {
  const value = options.get(name)
  if (value === undefined || value === '') throw new ReleaseValidationError(`missing required --${name}`)
  return value
}

/** @param {string[]} argv @param {string} repositoryRoot */
export function main(argv, repositoryRoot = process.cwd()) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP)
    return
  }
  const command = argv[0]
  if (!['notes', 'prepend', 'check'].includes(command ?? '')) throw new ReleaseValidationError(`unknown command: ${command ?? ''}`)
  const options = parseOptions(argv.slice(1))
  const allowed = new Set(['tag', 'target', 'output', 'notes', 'repository', 'pr-data'])
  for (const key of options.keys()) if (!allowed.has(key)) throw new ReleaseValidationError(`unknown option: --${key}`)
  if (command !== 'check' && options.has('notes')) throw new ReleaseValidationError('--notes is valid only for check')

  const tag = requiredOption(options, 'tag')
  parseStableTag(tag)
  const target = options.get('target') ?? 'HEAD'
  const output = resolve(requiredOption(options, 'output'))
  const repository = options.get('repository') ?? repositoryFromOrigin(repositoryRoot)
  const base = previousStableTag(repositoryRoot, tag, target)
  const changes = collectChanges(repositoryRoot, target, base, repository, options.get('pr-data'))
  const section = renderSection(tag, base, repository, changes)

  if (command === 'notes') atomicWrite(output, section)
  else if (command === 'prepend') prependSection(output, tag, section)
  else {
    let actual
    try {
      const content = readFileSync(output, 'utf8')
      if (!content.startsWith('# Changelog\n')) throw new ReleaseValidationError(`${output} must start with '# Changelog'`)
      actual = extractSection(content, tag)
    } catch (error) {
      if (error instanceof ReleaseValidationError) throw error
      throw new ReleaseValidationError(`cannot read changelog: ${output}`)
    }
    if (actual !== section) {
      throw new ReleaseValidationError(`${output} section ${tag} differs from generated release history; rerun prepend before tagging`)
    }
    const notes = options.get('notes')
    if (notes !== undefined) atomicWrite(resolve(notes), section)
  }
  process.stdout.write(`Changelog ${command} passed: ${tag}, base=${base ?? 'none'}, changes=${String(changes.length)}.\n`)
}

const isMainModule = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMainModule) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'changelog command failed'
    process.stderr.write(`ERROR: ${message}\n`)
    process.exitCode = 1
  }
}
