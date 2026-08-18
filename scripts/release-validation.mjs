// @ts-check

/**
 * Validate the stable npm release source, package artifact, registry state, and
 * post-publish install without changing Git refs, package versions, or tags.
 *
 * The command accepts only explicit, validated stable tags and paths. It prints
 * summaries without command output that could contain credentials; failures
 * are nonzero and never reinterpret a registry/network error as a missing
 * version.
 *
 * Usage:
 *   node scripts/release-validation.mjs source --tag v0.1.13
 *   node scripts/release-validation.mjs pack --tag v0.1.13 --directory release
 *   node scripts/release-validation.mjs artifact-verify --tag v0.1.13 --directory release --manifest release/manifest.json
 *   node scripts/release-validation.mjs registry-absent --tag v0.1.13
 *   node scripts/release-validation.mjs registry-published --tag v0.1.13
 *   node scripts/release-validation.mjs registry-smoke --tag v0.1.13
 *   node scripts/release-validation.mjs github-release --tag v0.1.13 --metadata release-metadata.json
 *   node scripts/release-validation.mjs privacy
 *
 * Outputs:
 *   `pack` writes one .tgz and a JSON manifest containing the tag, commit,
 *   version, filename, and SHA-256. Other commands print a short success
 *   summary and exit nonzero on validation, registry, or smoke failures.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-auth'
const REGISTRY_URL = 'https://registry.npmjs.org/'
const STABLE_TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const POST_PUBLISH_ATTEMPTS = 6
const POST_PUBLISH_DELAY_MS = 5_000
export const REQUIRED_PACKAGE_FILES = Object.freeze([
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'LICENSE',
  'lib/index.js',
  'lib/cli.js',
  'cordis.patch.yml',
  'deploy/caddy/dsh-auth.Caddyfile.template',
  'docs/installer.md',
  'vendor/caddy/manifest.json',
  'vendor/caddy/manifest.sha256',
  'vendor/caddy/LICENSE',
  'vendor/caddy/THIRD_PARTY.md',
  'vendor/caddy/linux-x64/caddy',
  'vendor/caddy/linux-arm64/caddy',
])

/** @typedef {{tag: string, version: string, commit: string, filename: string, sha256: string}} ReleaseManifest */
/** @typedef {{tag: string, version: string, commit: string, filename: string}} ReleaseIdentity */
/** @typedef {{filename: string, files: string[]}} PackSummary */
/** @typedef {{status: number, body: unknown}} RegistryResponse */
/** @typedef {{cwd?: string, input?: string}} CommandOptions */
/** @typedef {{attempts?: number, delayMs?: number, fetchJson?: (url: string) => Promise<RegistryResponse>, wait?: (delayMs: number) => Promise<void>}} RegistryPublishedOptions */

/**
 * Error raised for a user-controlled release input or an invalid release state.
 */
export class ReleaseValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'ReleaseValidationError'
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse the only supported release ref form.
 *
 * @param {string} tag
 * @returns {string}
 */
export function parseStableTag(tag) {
  if (!STABLE_TAG_PATTERN.test(tag)) {
    throw new ReleaseValidationError('release tag must be an exact stable vX.Y.Z tag without prerelease or build metadata')
  }
  return tag.slice(1)
}

/** @param {string} version @returns {string} */
export function expectedTarballFilename(version) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new ReleaseValidationError('package version must be a stable three-part SemVer')
  }
  return `${PACKAGE_NAME}-${version}.tgz`
}

/**
 * Check the package identity represented by package.json and a release tag.
 *
 * @param {unknown} packageJson
 * @param {string} tag
 * @returns {string}
 */
export function validatePackageVersion(packageJson, tag) {
  const version = parseStableTag(tag)
  if (!isRecord(packageJson) || packageJson.name !== PACKAGE_NAME || packageJson.version !== version) {
    throw new ReleaseValidationError(`package.json must be ${PACKAGE_NAME}@${version}`)
  }
  return version
}

/** @param {string} command @param {string[]} args @param {string} cwd @param {CommandOptions} [options] */
function runRaw(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error !== undefined) throw new Error(`${command} could not be started`)
  return result
}

/** @param {string} command @param {string[]} args @param {string} cwd @param {CommandOptions} [options] */
function runRequired(command, args, cwd, options = {}) {
  const result = runRaw(command, args, cwd, options)
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${String(result.status)}`)
  }
  return result
}

/** @param {string[]} args @param {string} cwd @returns {string} */
function gitOutput(args, cwd) {
  return runRequired('git', args, cwd).stdout.trim()
}

/** @param {string} filePath @returns {unknown} */
function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    throw new ReleaseValidationError(`invalid JSON file: ${filePath}`)
  }
}

/** @param {string} filePath @param {unknown} value */
function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * Validate the exact tag checkout and its relationship to origin/main.
 *
 * @param {string} repositoryRoot
 * @param {string} tag
 * @returns {ReleaseIdentity}
 */
export function validateReleaseSource(repositoryRoot, tag) {
  const version = parseStableTag(tag)
  const packageJson = readJson(join(repositoryRoot, 'package.json'))
  validatePackageVersion(packageJson, tag)

  const tagCommit = gitOutput([
    'rev-parse', '--verify', '--end-of-options', `refs/tags/${tag}^{commit}`,
  ], repositoryRoot)
  const headCommit = gitOutput(['rev-parse', '--verify', 'HEAD'], repositoryRoot)
  if (!SHA_PATTERN.test(tagCommit) || headCommit !== tagCommit) {
    throw new ReleaseValidationError(`HEAD is not the exact commit referenced by ${tag}`)
  }

  const mainCommit = gitOutput(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], repositoryRoot)
  const ancestry = runRaw('git', ['merge-base', '--is-ancestor', tagCommit, mainCommit], repositoryRoot)
  if (ancestry.status !== 0) {
    throw new ReleaseValidationError(`${tag} is not reachable from origin/main`)
  }

  return {
    tag,
    version,
    commit: tagCommit,
    filename: expectedTarballFilename(version),
  }
}

/** @param {unknown} value @param {ReleaseIdentity} expected @returns {ReleaseManifest} */
export function validateReleaseManifest(value, expected) {
  if (!isRecord(value)) throw new ReleaseValidationError('release manifest must be a JSON object')
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'commit,filename,sha256,tag,version') {
    throw new ReleaseValidationError('release manifest has unexpected fields')
  }
  if (value.tag !== expected.tag || value.version !== expected.version || value.commit !== expected.commit || value.filename !== expected.filename) {
    throw new ReleaseValidationError('release manifest does not match the checked-out tag and package')
  }
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw new ReleaseValidationError('release manifest SHA-256 is invalid')
  }
  return {
    tag: value.tag,
    version: value.version,
    commit: value.commit,
    filename: value.filename,
    sha256: value.sha256,
  }
}

/**
 * Require a final GitHub Release with exactly the verified npm tarball and manifest.
 *
 * @param {unknown} value
 * @param {string} tag
 * @param {string} expectedNotes
 * @returns {string[]}
 */
export function validateGitHubReleaseMetadata(value, tag, expectedNotes) {
  const version = parseStableTag(tag)
  if (!isRecord(value) || value.tagName !== tag || value.name !== tag || value.isDraft !== false || value.isPrerelease !== false || typeof value.body !== 'string' || value.body.trimEnd() !== expectedNotes.trimEnd()) {
    throw new ReleaseValidationError('GitHub Release metadata does not describe the exact final stable tag')
  }
  if (!Array.isArray(value.assets)) throw new ReleaseValidationError('GitHub Release assets must be an array')
  const names = value.assets.map(asset => {
    if (!isRecord(asset) || typeof asset.name !== 'string' || typeof asset.size !== 'number' || asset.size <= 0 || asset.state !== 'uploaded') {
      throw new ReleaseValidationError('GitHub Release contains an incomplete asset')
    }
    return asset.name
  }).sort()
  const expected = [expectedTarballFilename(version), 'manifest.json'].sort()
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new ReleaseValidationError('GitHub Release asset set differs from the verified npm artifact and manifest')
  }
  return names
}

/** @param {string} pathValue @returns {string} */
function normalizePackagePath(pathValue) {
  if (pathValue.includes('\\') || pathValue.includes('\0') || pathValue.startsWith('/')) {
    throw new ReleaseValidationError('package contains an unsafe path')
  }
  const normalized = pathValue.startsWith('package/') ? pathValue.slice('package/'.length) : pathValue
  const parts = normalized.split('/')
  if (normalized.length === 0 || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new ReleaseValidationError('package contains an unsafe path')
  }
  return normalized
}

/** @param {string[]} paths @param {string} version @returns {string[]} */
export function validatePackageFilePaths(paths, version) {
  expectedTarballFilename(version)
  const normalized = paths.map(normalizePackagePath)
  const unique = new Set(normalized)
  if (unique.size !== normalized.length) throw new ReleaseValidationError('package file list contains duplicates')

  for (const path of normalized) {
    if (
      path.startsWith('.github/') || path.startsWith('node_modules/') || path.startsWith('src/') || path.startsWith('tests/') ||
      path.endsWith('.tgz') || /(?:^|\/)(?:\.env(?:\.|$)|password-hash|session-secret)(?:$|\/)/iu.test(path) ||
      /\.(?:crt|key|pem|p12|pfx)$/iu.test(path)
    ) {
      throw new ReleaseValidationError(`package contains a forbidden path: ${path}`)
    }
  }

  const required = new Set(REQUIRED_PACKAGE_FILES)
  for (const path of required) {
    if (!unique.has(path)) throw new ReleaseValidationError(`package is missing required file: ${path}`)
  }
  if (!unique.has('lib/index.js')) {
    throw new ReleaseValidationError('package file list does not match the release package')
  }
  return normalized
}

/** @param {unknown} report @param {string} version @returns {PackSummary} */
export function validatePackReport(report, version) {
  if (!isRecord(report) || Object.keys(report).length !== 1 || !isRecord(report[PACKAGE_NAME])) {
    throw new ReleaseValidationError('npm 12 pack --dry-run must report exactly one keyed package')
  }
  const entry = report[PACKAGE_NAME]
  if (entry.name !== PACKAGE_NAME || entry.filename !== expectedTarballFilename(version) || entry.version !== version || !Array.isArray(entry.files)) {
    throw new ReleaseValidationError('npm pack --dry-run does not match the release version')
  }
  const paths = entry.files.map(file => {
    if (!isRecord(file) || typeof file.path !== 'string') throw new ReleaseValidationError('npm pack reported an invalid file entry')
    return file.path
  })
  return {
    filename: entry.filename,
    files: validatePackageFilePaths(paths, version),
  }
}

/** @param {string} tarball @returns {string[]} */
function readArchivePaths(tarball) {
  const output = runRequired('tar', ['-tzf', tarball], dirname(tarball)).stdout
  return output.split('\n').map(path => path.trim()).filter(path => path !== '')
}

/** @param {string[]} archivePaths @param {string} version @param {readonly string[] | undefined} [expectedPaths] */
export function validateArchivePaths(archivePaths, version, expectedPaths) {
  if (archivePaths.some(path => path !== 'package/' && !path.startsWith('package/'))) {
    throw new ReleaseValidationError('tarball contains a path outside package/')
  }
  const files = archivePaths.filter(path => {
    if (path === 'package/') return false
    const packagePath = path.slice('package/'.length)
    normalizePackagePath(packagePath.endsWith('/') ? packagePath.slice(0, -1) : packagePath)
    return !path.endsWith('/')
  })
    .map(path => path)
  const actual = validatePackageFilePaths(files, version)
  if (expectedPaths === undefined) return actual
  const expected = new Set(expectedPaths)
  const actualSet = new Set(actual)
  if (expected.size !== actualSet.size || [...expected].some(path => !actualSet.has(path))) {
    throw new ReleaseValidationError('tarball file list differs from npm pack --dry-run')
  }
  return actual
}

/** @param {string} filePath @returns {string} */
function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/** @param {string} directory @param {string} version @returns {string} */
function findTarball(directory, version) {
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.tgz'))
    .map(entry => entry.name)
  if (candidates.length !== 1 || candidates[0] !== expectedTarballFilename(version)) {
    throw new ReleaseValidationError('release directory must contain exactly the expected .tgz')
  }
  const tarball = join(directory, candidates[0])
  if (!lstatSync(tarball).isFile()) throw new ReleaseValidationError('release tarball must be a regular file')
  return tarball
}

/**
 * Build exactly one final tarball after validating npm's dry-run file list.
 *
 * @param {string} repositoryRoot
 * @param {string} tag
 * @param {string} directory
 * @param {string | undefined} reportPath
 * @param {string | undefined} manifestPath
 */
export function createReleaseArtifact(repositoryRoot, tag, directory, reportPath, manifestPath) {
  const identity = validateReleaseSource(repositoryRoot, tag)
  mkdirSync(directory, { recursive: true })
  const existingTarballs = readdirSync(directory).filter(name => name.endsWith('.tgz'))
  if (existingTarballs.length !== 0) throw new ReleaseValidationError('release directory already contains a tarball')

  const dryRun = runRequired('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], repositoryRoot)
  const packSummary = validatePackReport(JSON.parse(dryRun.stdout), identity.version)
  if (reportPath !== undefined) writeJson(reportPath, JSON.parse(dryRun.stdout))

  runRequired('pnpm', ['--config.ignore-scripts=true', 'pack', '--pack-destination', directory], repositoryRoot)
  const tarball = findTarball(directory, identity.version)
  validateArchivePaths(readArchivePaths(tarball), identity.version, packSummary.files)
  const manifest = {
    ...identity,
    sha256: sha256File(tarball),
  }
  writeJson(manifestPath ?? join(directory, 'manifest.json'), manifest)
  return { tarball, manifest }
}

/**
 * Revalidate the downloaded artifact against the current exact tag checkout.
 *
 * @param {string} repositoryRoot
 * @param {string} tag
 * @param {string} directory
 * @param {string} manifestPath
 */
export function verifyReleaseArtifact(repositoryRoot, tag, directory, manifestPath) {
  const identity = validateReleaseSource(repositoryRoot, tag)
  const tarball = findTarball(directory, identity.version)
  const manifest = validateReleaseManifest(readJson(manifestPath), identity)
  const digest = sha256File(tarball)
  if (digest !== manifest.sha256) throw new ReleaseValidationError('downloaded tarball SHA-256 differs from the manifest')
  const archivePaths = readArchivePaths(tarball)
  validateArchivePaths(archivePaths, identity.version)
  return { tarball, manifest }
}

/** @param {number} status @returns {'absent' | 'present' | 'error'} */
export function classifyRegistryStatus(status) {
  if (status === 404) return 'absent'
  if (status >= 200 && status < 300) return 'present'
  return 'error'
}

/** @param {string} version @returns {string} */
function registryVersionUrl(version) {
  return new URL(`${PACKAGE_NAME}/${encodeURIComponent(version)}`, REGISTRY_URL).toString()
}

/** @returns {string} */
function registryPackageUrl() {
  return new URL(PACKAGE_NAME, REGISTRY_URL).toString()
}

/** @param {string} url @returns {Promise<RegistryResponse>} */
async function fetchRegistryJson(url) {
  let response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new Error('official npm registry request failed; network and redirect errors are not treated as 404')
  }
  const text = await response.text()
  let body = undefined
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
  }
  return { status: response.status, body }
}

/** @param {string} tag */
export async function assertRegistryVersionAbsent(tag) {
  const version = parseStableTag(tag)
  const response = await fetchRegistryJson(registryVersionUrl(version))
  const state = classifyRegistryStatus(response.status)
  if (state === 'absent') {
    process.stdout.write(`Official registry has no ${PACKAGE_NAME}@${version}; publishing may proceed.\n`)
    return
  }
  if (state === 'present') throw new ReleaseValidationError(`${PACKAGE_NAME}@${version} already exists; refusing to publish`)
  throw new Error(`official npm registry returned HTTP ${String(response.status)}; refusing to assume 404`)
}

/** @param {number} delayMs @returns {Promise<void>} */
function wait(delayMs) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, delayMs))
}

/**
 * Check whether the version endpoint and package metadata both expose the release.
 *
 * @param {RegistryResponse} versionResponse
 * @param {RegistryResponse} packageResponse
 * @param {string} version
 * @returns {boolean}
 */
export function isPublishedRegistryState(versionResponse, packageResponse, version) {
  if (classifyRegistryStatus(versionResponse.status) !== 'present' || !isRecord(versionResponse.body) || versionResponse.body.version !== version) return false
  if (packageResponse.status !== 200 || !isRecord(packageResponse.body)) return false
  const distTags = packageResponse.body['dist-tags']
  const versions = packageResponse.body.versions
  return isRecord(distTags) && distTags.latest === version && isRecord(versions) && isRecord(versions[version])
}

/** @param {string} tag @param {RegistryPublishedOptions} [options] */
export async function assertRegistryVersionPublished(tag, options = {}) {
  const version = parseStableTag(tag)
  const attempts = options.attempts ?? POST_PUBLISH_ATTEMPTS
  const delayMs = options.delayMs ?? POST_PUBLISH_DELAY_MS
  const fetchJson = options.fetchJson ?? fetchRegistryJson
  const waitForRetry = options.wait ?? wait
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const versionResponse = await fetchJson(registryVersionUrl(version))
      const packageResponse = await fetchJson(registryPackageUrl())
      if (isPublishedRegistryState(versionResponse, packageResponse, version)) {
        process.stdout.write(`Official registry reports ${PACKAGE_NAME}@${version} and dist-tags.latest=${version}.\n`)
        return
      }
    } catch {
      // Post-publish network failures are retried but never converted into success.
    }
    if (attempt < attempts) await waitForRetry(delayMs)
  }
  throw new Error(`post-publish registry verification failed for ${PACKAGE_NAME}@${version} and latest after bounded retries; publication already happened and cannot be rolled back automatically`)
}

/** @param {string} tag */
export function registryInstallSmoke(tag) {
  const version = parseStableTag(tag)
  const root = mkdtempSync(join(tmpdir(), 'dsh-auth-registry-smoke-'))
  const cache = join(root, 'npm-cache')
  const userConfig = join(root, 'npmrc')
  mkdirSync(cache)
  writeFileSync(userConfig, `registry=${REGISTRY_URL}\n`, { encoding: 'utf8', mode: 0o600 })
  writeJson(join(root, 'package.json'), { name: 'dsh-auth-registry-smoke', private: true })
  try {
    runRequired('npm', [
      'install', '--userconfig', userConfig, '--cache', cache, '--registry', REGISTRY_URL,
      '--prefer-online', '--force', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
      `${PACKAGE_NAME}@${version}`,
    ], root)
    const installedPackage = readJson(join(root, 'node_modules', PACKAGE_NAME, 'package.json'))
    validatePackageVersion(installedPackage, tag)
    const bin = join(root, 'node_modules', '.bin', PACKAGE_NAME)
    if (!existsSync(bin)) throw new ReleaseValidationError('fresh registry install did not create the public bin')
    const help = runRequired(bin, ['--help'], root).stdout
    if (!help.includes('dsh-auth setup') || !help.includes('dsh-auth reset-password')) {
      throw new ReleaseValidationError('fresh registry bin help is missing a public command')
    }
    process.stdout.write(`Fresh official-registry install and ${PACKAGE_NAME} bin smoke passed for ${version}.\n`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const SENSITIVE_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /sk-[A-Za-z0-9_-]{20,}/u,
  /Bearer [A-Za-z0-9._-]{20,}/u,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/u,
]

/**
 * Scan tracked text and paths for release-blocking private material without
 * printing the matching content.
 *
 * @param {string} repositoryRoot
 */
export function runPrivacyGate(repositoryRoot) {
  const tracked = runRequired('git', ['ls-files', '-z'], repositoryRoot).stdout.split('\0').filter(Boolean)
  for (const relativePath of tracked) {
    if (/(?:^|\/)(?:\.env(?:\.|$)|[^/]+\.(?:pem|key|p12|pfx))$/iu.test(relativePath)) {
      throw new ReleaseValidationError(`tracked private credential file: ${relativePath}`)
    }
    const content = readFileSync(join(repositoryRoot, relativePath))
    if (content.includes(0)) continue
    const text = content.toString('utf8')
    if (SENSITIVE_PATTERNS.some(pattern => pattern.test(text))) {
      throw new ReleaseValidationError(`tracked file contains a sensitive credential pattern: ${relativePath}`)
    }
  }
  runRequired('git', ['diff', '--check'], repositoryRoot)
  process.stdout.write('Tracked-file privacy and whitespace gates passed.\n')
}

const HELP = `Usage:
  node scripts/release-validation.mjs <command> [options]

Description:
  Validate one existing stable vX.Y.Z tag, create or recheck its npm artifact,
  fail closed on registry state, and smoke-test the exact published version.

Commands:
  source             Verify package version, exact tag checkout, and origin/main ancestry.
  pack               Run npm pack --dry-run, create one final tarball, and write its manifest.
  artifact-verify    Recheck a downloaded tarball and manifest against the exact tag checkout.
  registry-absent    Require an exact version response of HTTP 404 from the official registry.
  registry-published Require the exact version and latest dist-tag on the official registry.
  registry-smoke     Install the exact version into a fresh temporary npm home and run its bin.
  github-release     Verify final stable release metadata and its exact two-asset set.
  privacy            Scan tracked files and run git diff --check without printing matches.

Options:
  --tag <vX.Y.Z>       Required stable release tag for all commands except privacy.
  --directory <path>   Artifact directory for pack and artifact-verify.
  --manifest <path>    Manifest path for artifact-verify; pack defaults to directory/manifest.json.
  --report <path>      Optional npm pack --dry-run JSON report output for pack.
  --metadata <path>    GitHub Release JSON from gh release view.
  --notes <path>       Expected generated GitHub Release body.
  -h, --help           Show this help.

Outputs:
  pack creates exactly one dsh-auth-X.Y.Z.tgz and a manifest with tag, commit,
  version, filename, and SHA-256. All other successful commands print one
  concise summary; invalid input or any ambiguous registry response exits nonzero.

Examples:
  node scripts/release-validation.mjs source --tag v0.1.13
  node scripts/release-validation.mjs pack --tag v0.1.13 --directory release --report release/pack-report.json
  node scripts/release-validation.mjs artifact-verify --tag v0.1.13 --directory release --manifest release/manifest.json
  node scripts/release-validation.mjs registry-published --tag v0.1.13
`

/** @param {string[]} argv @returns {Map<string, string>} */
function parseOptions(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '-h' || argument === '--help') {
      options.set('help', 'true')
      continue
    }
    if (argument === undefined || !argument.startsWith('--')) throw new ReleaseValidationError('options must use --name value')
    const name = argument.slice(2)
    if (name === '' || options.has(name)) throw new ReleaseValidationError(`duplicate or empty option: ${argument}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new ReleaseValidationError(`missing value for ${argument}`)
    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) throw new ReleaseValidationError(`unsafe value for ${argument}`)
    options.set(name, value)
    index += 1
  }
  return options
}

/** @param {Map<string, string>} options @param {string} name @returns {string} */
function requiredOption(options, name) {
  const value = options.get(name)
  if (value === undefined) throw new ReleaseValidationError(`missing required --${name}`)
  return value
}

/** @param {string} value @returns {string} */
function pathOption(value) {
  if (value.length === 0) throw new ReleaseValidationError('path options must not be empty')
  return resolve(value)
}

/** @param {Map<string, string>} options @param {readonly string[]} allowed */
function validateOptionNames(options, allowed) {
  const accepted = new Set(allowed)
  for (const name of options.keys()) {
    if (!accepted.has(name)) throw new ReleaseValidationError(`option is not valid for this command: --${name}`)
  }
}

/** @param {string[]} argv @param {string} repositoryRoot */
export async function main(argv, repositoryRoot = process.cwd()) {
  const command = argv[0]
  if (command === undefined || command === '-h' || command === '--help') {
    process.stdout.write(HELP)
    return
  }
  const options = parseOptions(argv.slice(1))
  if (options.has('help')) {
    process.stdout.write(HELP)
    return
  }

  switch (command) {
    case 'source': {
      validateOptionNames(options, ['tag'])
      const identity = validateReleaseSource(repositoryRoot, requiredOption(options, 'tag'))
      process.stdout.write(`Release source validated: ${identity.tag} ${identity.commit} ${identity.version}.\n`)
      return
    }
    case 'pack': {
      validateOptionNames(options, ['tag', 'directory', 'manifest', 'report'])
      const result = createReleaseArtifact(
        repositoryRoot,
        requiredOption(options, 'tag'),
        pathOption(requiredOption(options, 'directory')),
        options.get('report') === undefined ? undefined : pathOption(options.get('report') ?? ''),
        options.get('manifest') === undefined ? undefined : pathOption(options.get('manifest') ?? ''),
      )
      process.stdout.write(`Release artifact created: ${basename(result.tarball)} and manifest.\n`)
      return
    }
    case 'artifact-verify': {
      validateOptionNames(options, ['tag', 'directory', 'manifest'])
      const result = verifyReleaseArtifact(
        repositoryRoot,
        requiredOption(options, 'tag'),
        pathOption(requiredOption(options, 'directory')),
        pathOption(requiredOption(options, 'manifest')),
      )
      process.stdout.write(`Release artifact verified: ${basename(result.tarball)} ${result.manifest.sha256}.\n`)
      return
    }
    case 'registry-absent':
      validateOptionNames(options, ['tag'])
      await assertRegistryVersionAbsent(requiredOption(options, 'tag'))
      return
    case 'registry-published':
      validateOptionNames(options, ['tag'])
      await assertRegistryVersionPublished(requiredOption(options, 'tag'))
      return
    case 'registry-smoke':
      validateOptionNames(options, ['tag'])
      registryInstallSmoke(requiredOption(options, 'tag'))
      return
    case 'github-release': {
      validateOptionNames(options, ['tag', 'metadata', 'notes'])
      const tag = requiredOption(options, 'tag')
      const notes = readFileSync(pathOption(requiredOption(options, 'notes')), 'utf8')
      const assets = validateGitHubReleaseMetadata(readJson(pathOption(requiredOption(options, 'metadata'))), tag, notes)
      process.stdout.write(`Final GitHub Release verified: ${tag}, assets=${assets.join(',')}.\n`)
      return
    }
    case 'privacy':
      validateOptionNames(options, [])
      runPrivacyGate(repositoryRoot)
      return
    default:
      throw new ReleaseValidationError(`unknown command: ${command}`)
  }
}

const isMainModule = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMainModule) {
  void main(process.argv.slice(2)).catch(error => {
    const message = error instanceof Error ? error.message : 'release validation failed'
    process.stderr.write(`ERROR: ${message}\n`)
    process.exitCode = 1
  })
}
