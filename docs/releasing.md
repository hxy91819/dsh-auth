# npm release maintenance

Stable npm publishing is an explicit GitHub Actions dispatch. The release workflow accepts one existing `vX.Y.Z` tag, checks that the package version matches, checks that the tag commit is reachable from `origin/main`, builds and tests the package in a fresh Ubuntu runner, uploads one hashed tarball, and publishes that exact tarball with npm Trusted Publishing.

The workflow is [`release.yml`](../.github/workflows/release.yml). It has no `push` or `pull_request` trigger, never changes `package.json`, never creates or pushes a tag, and never uses a long-lived npm credential. Preflight has only `contents: read`; the publish job adds only `id-token: write` and is protected by the `npm-release` environment. Release builds deliberately do not use the setup-node package cache.

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

Create the GitHub Environment named exactly `npm-release`. Require approval from at least one trusted maintainer or release-review team, and enable the environment option that prevents the same person from approving their own deployment when a second reviewer is available. Restrict the environment to selected tags matching `v*.*.*`; do not allow arbitrary branches to deploy it.

Protect `main` with pull requests, the normal CI checks, no force-push, and no deletion. Add a tag ruleset for `v*.*.*` that restricts tag creation, updates, and deletion to maintainers or the release automation owners. The release workflow still validates the exact stable SemVer form and main ancestry, so the ruleset is defense in depth rather than a replacement for those checks.

If **Actions permissions** is restricted to selected actions, allow these exact action repositories (using the versions in the workflow):

- `actions/checkout`
- `actions/setup-node`
- `actions/upload-artifact`
- `actions/download-artifact`
- `pnpm/action-setup`
- `gitleaks/gitleaks-action`

The workflow does not need write permissions for repository contents, packages, or security events. Its publish permission is the GitHub OIDC `id-token: write` permission only.

## Release procedure

1. Update `package.json` and the lockfile when the dependency graph changes, run the local checks in `AGENTS.md`, and commit the change on `main`.
2. Create and push an annotated stable tag whose version exactly matches `package.json`, for example `v0.1.13`. Do not create a prerelease tag for this workflow.
3. In GitHub Actions, dispatch **Release** and enter that exact tag. Approve the `npm-release` environment when requested.
4. Inspect the preflight logs and uploaded manifest. It records the tag, commit SHA, package version, tarball filename, and SHA-256. The publish job rechecks all five values before the version-absent check and OIDC publish.
5. Confirm the official registry version, `latest` dist-tag, and fresh registry install/bin smoke. A failure in these post-publish checks is diagnostic only: npm publication cannot be rolled back automatically, so fix forward with a new version.

Preflight runs `check`, `check:nginx`, the npm pack dry-run and tarball file-list check, offline packed-bin smoke, the real PTY interactive and non-interactive installer E2E, tracked-file privacy checks, and gitleaks. It uses disposable files and does not touch a deployed Harness, port 3080, or host Nginx configuration.
