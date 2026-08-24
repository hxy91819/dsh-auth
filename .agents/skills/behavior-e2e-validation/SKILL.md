---
name: behavior-e2e-validation
description: Design and run real end-to-end regression tests for dsh-auth behavior that users observe through the Caddy edge, DSH Web, or a browser. Use for authentication policy, login/logout, CSRF, password reset, session persistence, edge routing, packaging, installer, and lifecycle changes; do not use as a substitute for focused owner tests.
---

# Behavior E2E Validation

Lock the product contract at the public boundary. Focused tests remain necessary, but they do not replace a feasible real DSH/Caddy/browser or installer reproduction.

## Landing gate

For applicable changes, load and use this skill before review and land. A PR is E2E-complete only when the relevant public-boundary command passes on its exact HEAD; focused tests and `pnpm run check` alone do not satisfy the gate. If no public-boundary run is feasible, record the concrete blocker and the closest owner-level coverage in the PR description.

## Workflow

1. State the observable contract before editing:
   - Identify the operator flow and public boundary.
   - Specify status codes, redirects, cookies, rendered text, protected resources, and safety behavior that distinguish success from failure.
   - Treat auth state, secret files, Caddy configuration, and DSH profiles as fixture setup, not as the assertion surface.
2. Choose the narrowest real runner:
   - Authentication, edge, session, packaging, and browser behavior: `corepack pnpm run test:e2e`, backed by `scripts/real-integration.mjs`.
   - Outer TLS proxy behavior: `corepack pnpm run test:e2e:behind-tls-proxy`.
   - Packed artifact and installer behavior: `node scripts/pack-smoke.mjs PATH.tgz` and `node scripts/installer-e2e.mjs PATH.tgz`.
   - Managed installer/lifecycle behavior: `corepack pnpm run test:e2e:lifecycle` or the matching installer E2E script.
   - Caddy-only route/header behavior: `corepack pnpm run test:e2e:caddy`.
   - Latest Harness compatibility: `corepack pnpm run test:e2e:latest-dsh`, optionally with `-- PATH.tgz` for a packed artifact.
   - Release validation: follow the packed E2E matrix in [`docs/releasing.md`](../../../docs/releasing.md); an unpacked workspace run is not a substitute for the packed artifact jobs.
   - If the behavior cannot cross a public boundary in this repository, document the concrete blocker and add the closest owner-level test instead.
3. Add a regression assertion before or alongside the implementation:
   - For a bug fix, prove the affected base revision fails for the product-level reason when practical; setup, compilation, or missing-tool failures do not count.
   - For an intentional contract change, update conflicting assertions and prove the new contract on the fixed build.
4. Keep the environment disposable:
   - `scripts/real-integration.mjs` must own its temporary DSH profile, auth state, secret files, TLS material, ports, Caddy processes, and headless Chrome session.
   - Never reuse a deployed service, operator credentials, ambient browser profile, or persistent Harness state.
   - Keep passwords and session secrets generated at runtime; do not put them in source, command arguments, logs, or failure messages.
5. Assert behavior, not implementation:
   - Assert public HTTP status, safe redirects, cookie attributes, HTML/UI text, browser navigation, and protected route outcomes.
   - For browser flows, use the CDP helper in `scripts/real-integration.mjs`; assert the visible result and response status, not DOM internals unrelated to the contract.
   - Include negative behavior: denied cross-origin or stale-CSRF requests must remain denied, submitted passwords must not be replayed, and revoked sessions must not reach Harness.
6. For CSRF and browser-auth changes:
   - Read the CSRF and browser-protection contract in `SECURITY.md` before editing.
   - Assert each applicable contract at the public boundary, including stale-page recovery, multi-tab submission, and session-secret revocation; keep the product contract in `SECURITY.md` rather than duplicating it here.
7. Run proportionate proof and report:
   - Run the new E2E scenario, focused owner tests, `corepack pnpm run check`, `corepack pnpm run check:caddy`, and `git diff --check` before handoff.
   - Report the public contract, exact command(s), disposable topology, base failure when available, fixed pass, and any prerequisite that prevented a real run.

Do not call a user-observable bug fixed when a feasible public-boundary E2E regression test is still missing.
