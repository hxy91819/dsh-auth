import { pathToFileURL } from 'node:url'

/** @typedef {{ id: number, name: string, created_at: string, workflow_run?: { id?: number } }} Artifact */
/** @typedef {{ status: string, head_repository?: { id: number } | null, head_branch?: string | null }} WorkflowRun */
/** @typedef {{ key: string, kept: number, stale: number[] }} RetentionDecision */

const artifactName = 'packed-tarball'

/**
 * @param {Artifact[]} artifacts
 * @param {Map<number, WorkflowRun>} runs
 * @returns {RetentionDecision[]}
 */
export function selectPackedArtifactRetention(artifacts, runs) {
  /** @type {Map<string, Artifact[]>} */
  const completedByBranch = new Map()

  for (const artifact of artifacts) {
    if (artifact.name !== artifactName) continue

    const run = runs.get(artifact.workflow_run?.id ?? -1)
    if (run?.status !== 'completed' || !run.head_repository || !run.head_branch) continue

    const key = `${run.head_repository.id}:${run.head_branch}`
    const branchArtifacts = completedByBranch.get(key) ?? []
    branchArtifacts.push(artifact)
    completedByBranch.set(key, branchArtifacts)
  }

  return [...completedByBranch].map(([key, branchArtifacts]) => {
    branchArtifacts.sort((left, right) =>
      right.created_at.localeCompare(left.created_at) || right.id - left.id,
    )
    const [kept, ...stale] = branchArtifacts
    if (!kept) throw new Error(`retention group ${key} has no artifact`)
    return { key, kept: kept.id, stale: stale.map(artifact => artifact.id) }
  })
}

/** @param {string} name */
function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

/**
 * @param {string} token
 * @param {string} path
 * @param {RequestInit} [options]
 */
async function githubRequest(token, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'dsh-auth-packed-artifact-retention',
      'x-github-api-version': '2022-11-28',
    },
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`GitHub API ${options.method ?? 'GET'} ${path} failed: ${response.status} ${detail}`)
  }
  return response
}

/**
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 */
async function listPackedArtifacts(token, owner, repo) {
  /** @type {Artifact[]} */
  const artifacts = []
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ name: artifactName, per_page: '100', page: String(page) })
    const response = await githubRequest(token, `/repos/${owner}/${repo}/actions/artifacts?${query}`)
    const data = /** @type {{ artifacts: Artifact[] }} */ (await response.json())
    artifacts.push(...data.artifacts)
    if (data.artifacts.length < 100) return artifacts
  }
}

async function main() {
  const token = requiredEnvironment('GITHUB_TOKEN')
  const repository = requiredEnvironment('GITHUB_REPOSITORY')
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(repository)
  if (!match) throw new Error('GITHUB_REPOSITORY must be an owner/repository pair')
  const [, owner, repo] = match
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY must include owner and repository')

  const artifacts = await listPackedArtifacts(token, owner, repo)
  /** @type {Map<number, WorkflowRun>} */
  const runs = new Map()
  for (const artifact of artifacts) {
    const runId = artifact.workflow_run?.id
    if (!runId || runs.has(runId)) continue
    const response = await githubRequest(token, `/repos/${owner}/${repo}/actions/runs/${runId}`)
    runs.set(runId, /** @type {WorkflowRun} */ (await response.json()))
  }

  const decisions = selectPackedArtifactRetention(artifacts, runs)
  for (const decision of decisions) {
    process.stdout.write(`Keeping ${decision.key} artifact ${decision.kept}; deleting ${decision.stale.length} older artifact(s)\n`)
    for (const artifactId of decision.stale) {
      await githubRequest(token, `/repos/${owner}/${repo}/actions/artifacts/${artifactId}`, { method: 'DELETE' })
    }
  }
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) await main()
