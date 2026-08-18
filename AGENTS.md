# AGENTS.md

`dsh-auth` is an installable Cordis bundle that adds authentication to DeepSeek Harness without modifying Harness. Keep the public README focused on what the package is and how operators install it; keep contributor workflow here.

## Before editing

- Read `README.md`, `SECURITY.md`, and the files touched by the requested behavior.
- Check `git status --short`, the current branch, and `git worktree list`. Preserve unrelated work and stay on the current branch unless the user directs otherwise.
- Treat any DeepSeek Harness checkout as read-only compatibility evidence. Confirm extension points and routes from its installed/source version instead of guessing APIs.

## Architecture

- Caddy is the only public listener. Harness binds loopback; Caddy performs `forward_auth`, security headers, TLS, and authenticated HTTP, download, SSE, and WebSocket proxying.
- The Cordis plugin owns `/auth/*`, the bilingual login page, signed CSRF values, Argon2id verification, persistent revocable sessions, and the native Harness sign-out contribution.
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
- Validate root-executed deployment inputs before using them in paths, Caddy configuration, or service-manager commands.

## Change map

- HTTP routes, login/logout, CSRF, proxy trust: `src/application.ts` and `tests/auth-http.spec.ts`.
- Session persistence, expiry, renewal, revocation: `src/session.ts`, `src/cookies.ts`, and `tests/session-persistence.spec.ts`.
- Password hashing and CLI generation: `src/password.ts`, `src/cli.ts`, and `tests/password.spec.ts`.
- Harness UI, locale, theme, and sign-out: `src/client.tsx`, `src/preferences.ts`, and `tests/client.spec.tsx`.
- Cordis registration and configuration: `src/index.ts`, `src/config.ts`, `cordis.patch.yml`, and `tests/plugin.spec.ts`.
- Edge routing and WebSocket/download behavior: `deploy/caddy/dsh-auth.Caddyfile.template` and `scripts/check-caddy.mjs`.
- Installer discovery, typed plans, execution, recovery, doctor, and uninstall: `src/installer/`, `src/cli.ts`, and `tests/installer-*.spec.ts`.

Tests assert observable behavior. Add decision-oriented comments only when code cannot express the reason for a security or compatibility choice.

## Verification

Run the narrowest focused test while iterating. Before commit, complete:

```sh
corepack pnpm run check
corepack pnpm run check:caddy
git diff --check
```

`pnpm run check` is code health plus functional checks, not Caddy, Nginx, or E2E. Each commit owns the size, complexity, and duplication findings it introduces. Treat those reports as advice: judge whether a split is worth it; if the current shape should stay, add a precise per-rule suppression comment with the reason in the same commit.

Run `corepack pnpm run test:e2e` for changes to authentication policy, edge routing, browser integration, session persistence, packaging, or release behavior. The command owns a disposable DSH profile, secrets, processes, and ports; it requires Caddy (or a verified test binary), OpenSSL, `ss`, and Chrome or Chromium and leaves existing services untouched.

Before a public push, scan files and Git metadata for credentials, local paths, private service names, logs, and non-public email addresses. Use the repository-approved personal open-source identity, inspect the packed artifact with `npm pack --dry-run`, and verify the remote commit after pushing.

## Land

When the user asks to land, merge, or 合入 a PR, identify that PR and its HEAD SHA. Merge only after both gates succeed on that exact SHA.

1. Autoreview. If an `autoreview` skill is available (project `.agents/skills/autoreview` or `.claude/skills/autoreview`, or global `~/.agents` / `~/.claude`), read it and run it against the PR branch with `--mode branch --base origin/<pr-base>`. Skip this gate only when the skill is absent, and say so. A clean helper exit with no accepted/actionable findings is required. Remaining findings stop the land. If review requires code changes, stop, report them, and wait for a new HEAD plus a fresh CI run.
2. CI. Every check run on the PR HEAD must be `completed` and `success`. Query `gh pr checks` and the commit check-runs API for that SHA. Duplicate `push` and `pull_request` jobs both count. Pending, queued, failed, cancelled, or timed-out checks block land. Combined Status API `pending` with an empty status list is not evidence of failure when check-runs are green.

Draft, conflicted, or non-mergeable PRs stay unmerged. Use `gh pr merge` with the repository default method after both gates pass.
