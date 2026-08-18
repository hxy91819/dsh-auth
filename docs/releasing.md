# Release maintenance

Stable npm and GitHub publishing is an explicit GitHub Actions dispatch. One `dsh-auth` npm package and one GitHub Release carry the same self-contained tarball. The release workflow accepts one existing `vX.Y.Z` tag, checks that the package version and generated changelog match, checks that the tag commit is reachable from `origin/main`, builds and tests the package in a fresh Ubuntu runner, uploads one hashed tarball, publishes that exact tarball with npm Trusted Publishing, and creates the GitHub Release only after registry verification succeeds. There are no separate Caddy npm packages or Caddy GitHub Releases.

The release tarball must contain the official Caddy `v2.11.4` binaries for Linux x64 and ARM64, their manifest and checksum, Caddy's license, and third-party notices. Preflight may prepare those files from fixed official archives in isolated staging. Install hooks and `dsh-auth setup` must never download them. The larger tarball is intentional: one copied artifact must be enough for private mirrors and offline installation.

`dsh-auth@0.1.14` does not meet this contract and cannot be overwritten. The correction must use a new version and tag. Do not move `v0.1.14`, create companion packages for it, or treat its historical pack checks as release evidence.

## Short answer

A tag alone does not publish. Creating and pushing the tag selects the immutable source; one explicit dispatch of the **Release** workflow authorizes publication. After the release commit and tag exist on GitHub, the shortest supported command is:

```sh
gh workflow run release.yml --ref main -f tag=vX.Y.Z
```

Replace `vX.Y.Z` with the exact new stable tag, for example `v0.1.15`. The workflow has no tag, branch-push, or pull-request publication trigger by design.

The workflow is [`release.yml`](../.github/workflows/release.yml). It has no `push` or `pull_request` trigger, never changes `package.json`, `CHANGELOG.md`, Git refs, or tags, and never uses a long-lived npm credential. Preflight has only `contents: read`; the npm publish job adds only `id-token: write` and is protected by the `npm-release` environment; a final independent job receives `contents: write` only to create and verify the GitHub Release. Release automation supports only the exact npm 12 version pinned in the workflow, and release builds deliberately do not use the setup-node package cache.

## One-time npm configuration

In npmjs.com, open the `dsh-auth` package settings and add a Trusted Publisher with these exact values:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `hxy91819` |
| Repository | `dsh-auth` |
| Workflow filename | `release.yml` |
| Environment | `npm-release` |

The file is stored at `.github/workflows/release.yml`; npm's workflow filename field is the basename `release.yml`. Keep the package public and keep the workflow's registry fixed at `https://registry.npmjs.org/`.

For the first migration run, keep any existing npm publishing access setting needed to preserve the current operational path, but do not put a token in the workflow. After the first OIDC publish succeeds, set npm **Publishing access** to **Require 2FA and disallow tokens**, revoke any temporary migration token, and remove persistent npm credentials from the server's user configuration. The GitHub workflow must continue to rely only on the OIDC exchange.

## One-time GitHub configuration

Create the GitHub Environment named exactly `npm-release`. Restrict the environment to the selected branch `main`; the dispatch runs the current workflow from `main`, while both jobs check out and validate the exact tag input before publishing. Do not allow other branches or tags to deploy the environment. A single-maintainer project may omit required reviewers. TODO: when the project gains another maintainer, require approval from at least one trusted maintainer or release-review team and prevent release authors from approving their own deployments.

Protect `main` with pull requests, the normal CI checks, no force-push, and no deletion. Add a tag ruleset for `v*.*.*` that restricts tag creation, updates, and deletion to maintainers or the release automation owners. The release workflow still validates the exact stable SemVer form and main ancestry, so the ruleset is defense in depth rather than a replacement for those checks.

If **Actions permissions** is restricted to selected actions, allow these exact action repositories (using the versions in the workflow):

- `actions/checkout@*`
- `actions/setup-node@*`
- `actions/upload-artifact@*`
- `actions/download-artifact@*`
- `pnpm/action-setup@*`
- `gitleaks/gitleaks-action@*`

The npm publish job does not need write permissions for repository contents, packages, or security events. Its publish permission is the GitHub OIDC `id-token: write` permission only. The final GitHub Release job has `contents: write` but no OIDC permission and runs only after npm publication and registry smoke succeed.

## Release procedure

1. Choose a new stable version that does not exist on npm. Update `package.json`, update version-pinned documentation, and update the lockfile only when its dependency data changes.
2. Run the local checks in `AGENTS.md` and commit the release preparation on `main`.
3. Generate the version section with `node scripts/release-changelog.mjs prepend --tag vX.Y.Z --target HEAD --output CHANGELOG.md`, review it, and commit only `CHANGELOG.md`. The generator uses first-parent history since the previous stable tag, resolves merged pull-request titles and original authors through GitHub, and excludes this changelog-only commit from its own output.
4. Create an annotated tag on that exact changelog commit, then atomically push `main` and the tag. Its `vX.Y.Z` value must equal the `package.json` version. Do not use a prerelease or move an existing tag.
5. Dispatch **Release** from the `main` workflow ref with the exact tag input. If reviewer protection is enabled after the project gains another maintainer, have an eligible maintainer approve the `npm-release` deployment.
6. Inspect the preflight, publish, and GitHub Release jobs. The manifest records the tag, commit SHA, package version, tarball filename, tarball SHA-256, and both Caddy inputs; every downstream job rechecks the same tarball and hash before using it.
7. Confirm that the official-registry version, `latest` dist-tag, single-tarball offline install, fresh install/bin smoke, and final GitHub Release all pass. The GitHub Release permanently retains the exact npm tarball and manifest; it must not add a second installable package.

For the command-line path, use explicit values and publish the release commit and tag atomically:

```sh
git tag -a vX.Y.Z -m "dsh-auth vX.Y.Z"
git push --atomic origin main refs/tags/vX.Y.Z
gh workflow run release.yml --ref main -f tag=vX.Y.Z
gh run list --workflow release.yml --event workflow_dispatch --limit 1
```

In the GitHub UI, open **Actions → Release → Run workflow**, keep **Use workflow from** set to `main`, enter the exact existing tag in **tag**, and run the workflow. Do not select the tag as the workflow ref: the `npm-release` Environment permits `main`, while the jobs themselves check out and validate the tag.

## Failure handling

Before rerunning a failed release, check whether the **Publish the exact tarball** step succeeded. If it did not and `dsh-auth@X.Y.Z` is still absent from the official registry, the same immutable tag may be dispatched again after fixing the workflow or external configuration. If publication succeeded, do not retry it as a new publication and do not move the tag; npm versions are immutable. Confirm the published version and `latest` directly, then fix forward with a new version if package contents are wrong. Failures after npm publication or GitHub Release creation are diagnostic because neither publication is rolled back automatically. A failed final GitHub Release job can be rerun without republishing npm when the publish job already succeeded.

Preflight runs `check`, `check:caddy`, the npm pack dry-run and tarball file-list check, dual-architecture Caddy integrity checks, single-tarball offline smoke, the real PTY interactive and non-interactive installer E2E, tracked-file privacy checks, and gitleaks. It uses disposable files and does not touch a deployed Harness, public ports, or host Caddy/Nginx configuration.
