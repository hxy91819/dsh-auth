# AGENTS.md

`dsh-auth` is an installable Cordis bundle that adds authentication to DeepSeek Harness without modifying Harness. Keep the public README (`README.md` and `README.zh-CN.md`) focused on what the package is and how operators install it; keep contributor workflow here. Update both languages together when operator-facing install behavior changes.

## Before editing

- Read `README.md`, `SECURITY.md`, and the files touched by the requested behavior.
- Check `git status --short`, the current branch, and `git worktree list`. Preserve unrelated work and stay on the current branch unless the user directs otherwise.
- Treat any DeepSeek Harness checkout as read-only compatibility evidence. Confirm extension points and routes from its installed/source version instead of guessing APIs.

## Architecture

- The managed Caddy is the only authentication edge allowed to reach loopback-bound Harness. It normally terminates public TLS; `--behind-tls-proxy` instead keeps it on loopback HTTP behind an operator-owned TLS proxy while preserving `forward_auth`, security headers, and authenticated HTTP, download, SSE, and WebSocket proxying.
- Do not move `forward_auth` into an operator Caddy, Nginx, ingress, or load balancer merely because it already terminates TLS. A user-managed authentication edge is outside the supported product boundary unless it is separately designed, approved, and verified.
- The Cordis plugin owns `/auth/*`, the bilingual login page, signed CSRF values, Argon2id verification, persistent revocable sessions, and the Settings password-reset and sign-out rows.
- Protect the SPA, `/api/*`, `/plugins/*`, `/api/session.export`, `/api/events.mux`, `/api/events.host`, and `/plugins/events`. Public access to the upstream `/auth/verify` route must resolve as not found.
- Integrate through Harness WebServer, Settings, index-tap, client-module, locale, and sidebar-slot extension points. Extend those seams instead of forking Harness, rewriting its assets, probing the DOM, or using Nginx `sub_filter`.
- `cordis.patch.yml` is the normal bundle layer. `cordis.overlay.yml` is only for deployments that resolve the package outside `dsh.profile.bundles`; one deployment uses one of them.
- `src/` is the source of truth. `lib/` is the published build output. Deployment templates live under `deploy/`; observable behavior belongs in `tests/`.
- Read `docs/installer.md` before changing setup/plan/doctor/uninstall, bundled Caddy verification, systemd integration, managed paths, JSON/exit-code behavior, or installer release checks.

## Security invariants

- Keep Harness unreachable from external interfaces and `/auth/verify` reachable only through Caddy's internal `forward_auth` subrequest.
- Keep production cookies `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and `__Host-` prefixed. Plain HTTP remains an explicit evaluation mode.
- Passwords stay out of configuration, arguments, logs, fixtures, and the repository. Accept Argon2id hashes and session secrets only through validated environment values or absolute secret-file paths.
- Preserve server-side revocation, rolling renewal, safe return paths, exact Origin/Referer checks, trusted-proxy allowlisting, no-store authentication responses, and log redaction.
- Keep login-token issue capacity at 32 unexpired files across processes; check and publish under one exclusive directory lock.
- Keep token-bridge HTML on `same-origin` referrer-policy so Chrome form POSTs send a real Origin. `no-referrer` makes Chrome send `Origin: null`.
- Validate root-executed deployment inputs before using them in paths, Caddy configuration, or service-manager commands.

## Change map

When one fix or review spans several surfaces below — routes and sessions, edge template, installer/lifecycle, client UI, packaging — use `$cross-surface-pr-review` to classify the shared mechanism before closing the change.

- HTTP routes, login/logout, password change, CSRF, proxy trust: `src/application.ts`, `src/admin-password.ts`, `src/http.ts`, `tests/auth-http.spec.ts`, and `tests/admin-password.spec.ts`.
- Session persistence, expiry, renewal, revocation: `src/session.ts`, `src/cookies.ts`, and `tests/session-persistence.spec.ts`.
- Password hashing and CLI generation: `src/password.ts`, `src/cli.ts`, and `tests/password.spec.ts`.
- Harness UI, locale, theme, and Settings password-reset and sign-out: `src/client.tsx`, `src/preferences.ts`, and `tests/client.spec.tsx`.
- Cordis registration and configuration: `src/index.ts`, `src/config.ts`, `cordis.patch.yml`, and `tests/plugin.spec.ts`.
- Edge routing and WebSocket/download behavior: `deploy/caddy/dsh-auth.Caddyfile.template` and `scripts/check-caddy.mjs`.
- Installer discovery, typed plans, execution, recovery, doctor, and uninstall: `src/installer/`, `src/cli.ts`, and `tests/installer-*.spec.ts`.
- Login-token origin, bootstrap, and capacity: `src/application.ts`, `src/token-bootstrap.ts`, `src/login-token-store.ts`, and `tests/login-token-*.spec.ts`.

Tests assert observable behavior. Add decision-oriented comments only when code cannot express the reason for a security or compatibility choice.

## Verification

Run the narrowest focused test while iterating. Before commit, complete:

```sh
corepack pnpm run check
corepack pnpm run check:caddy
git diff --check
```

`pnpm run check` is code health plus functional checks, not Caddy or E2E. Each commit owns the size, complexity, and duplication findings it introduces. Treat those reports as advice: judge whether a split is worth it; if the current shape should stay, add a precise per-rule suppression comment with the reason in the same commit. Use `$code-health-review` when interpreting a Code Health report or judging a PR's findings.

Run `corepack pnpm run test:e2e` for changes to authentication policy, edge routing, browser integration, session persistence, packaging, or release behavior. For those changes, load and use `.agents/skills/behavior-e2e-validation/SKILL.md` before choosing the runner; it owns the isolation, assertions, and completion evidence. The command owns a disposable DSH profile, secrets, processes, and ports; it requires Caddy (or a verified test binary), OpenSSL, `ss`, and Chrome or Chromium and leaves existing services untouched.

Before a public push, scan files and Git metadata for credentials, local paths, private service names, logs, and non-public email addresses. Use the repository-approved personal open-source identity, inspect the packed artifact with `npm pack --dry-run`, and verify the remote commit after pushing.

## Land

When the user asks to land, merge, or 合入 a PR, identify that PR and its HEAD SHA. Merge only after all gates succeed on that exact SHA.

1. Behavior E2E. For changes to authentication policy, edge routing, browser integration, session persistence, packaging, installer, or release behavior, load and use `.agents/skills/behavior-e2e-validation/SKILL.md` and follow its Landing gate and completion evidence requirements.
2. Autoreview. Auto Review is a mandatory landing gate whenever an `autoreview` skill is available. Search the project skill roots (`.agents/skills/autoreview`, `.claude/skills/autoreview`), global roots (`~/.agents` / `~/.claude`), and any skill root mounted or exposed by Agent Session Manager (including `/data/code/openclaw/agent-skills/skills/autoreview` in the shared development environment). Read the discovered `SKILL.md` and run it against the PR branch with `--mode branch --base origin/<pr-base>`. Skip this gate only after verifying that all applicable roots are absent, and say so. A clean helper exit with no accepted/actionable findings is required. Remaining findings stop the land. If review requires code changes, stop, report them, and wait for a new HEAD plus a fresh CI run.
3. Review comments. Inventory every GitHub review, review thread, and review comment on the PR. Each one must be adopted (fixed on this HEAD) or rejected with a brief public reason on that thread. Unaddressed comments and unanswered `CHANGES_REQUESTED` reviews block land. If an accepted comment requires code changes, stop, report them, and wait for a new HEAD plus a fresh CI run.
4. CI. Every check run on the PR HEAD must be `completed` and `success`. Query `gh pr checks` and the commit check-runs API for that SHA. Duplicate `push` and `pull_request` jobs both count. Pending, queued, failed, cancelled, or timed-out checks block land. Combined Status API `pending` with an empty status list is not evidence of failure when check-runs are green.

Draft, conflicted, or non-mergeable PRs stay unmerged. Use `gh pr merge` with the repository default method after all gates pass.

Packed installer, browser, and lifecycle jobs are separate check-runs. A failed job may be rerun from the packed tarball artifact without repeating jobs that already succeeded. The aggregator job named `check` succeeds only when every packed job succeeds; all of those check-runs still count for land.

## Release

Protected `main` accepts release commits only through a pull request. Follow `docs/releasing.md`. When the user has already authorized publication, put the version bump and changelog on the last feature branch instead of opening a second release-only PR. Run Autoreview in parallel with CI. Local verification before the release commit is `check`, `check:caddy`, and `git diff --check`; do not locally re-run packed E2E, `npm pack --dry-run`, or lifecycle beside an existing managed install. After merge, tag the changelog commit and dispatch Release from `main`.
