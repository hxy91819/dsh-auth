---
name: cross-surface-pr-review
description: Review a dsh-auth PR for protection-invariant bug classes shared across surfaces — auth HTTP/session/token behavior, the managed Caddy edge template, installer and lifecycle, client UI integration, packaging — then define contributor scope and maintainer follow-up.
disable-model-invocation: true
---

# Cross-Surface PR Review

Review the mechanism, not only the surface named in the change. Establish whether the same failure mode exists on the sibling surfaces that share the invariant, and make the remaining work explicit instead of leaving it implicit.

## Workflow

1. Verify the reported problem and the proposed root cause on the surface named by the change. `SECURITY.md` owns the cross-cutting contracts; read the applicable trust-boundary section before classifying anything.
2. Name the underlying bug class, for example:
   - protected-route drift between the Caddy template catch-all and what `/auth/*` plus Harness actually expose;
   - security-header ownership: which layer sets, overwrites, or appends a header;
   - cookie attribute drift between the application writers and the edge expectations;
   - Origin/Referer exact-match variants across state-changing routes and WebSocket handshakes;
   - login-token issue capacity or directory locking racing across processes;
   - installer-managed mode, ownership, or service wiring disagreeing with `doctor` checks;
   - token-bridge referrer policy changing which browser requests carry an Origin.
3. Inventory every surface that shares that mechanism. Use the AGENTS.md change map as the index and read each candidate's real implementation path before classifying it:
   - HTTP auth, session, token bridge (`src/application.ts`, `src/http.ts`, `src/session.ts`, `src/cookies.ts`, `src/admin-password.ts`, `src/password.ts`);
   - Caddy edge (`deploy/caddy/dsh-auth.Caddyfile.template`, verified by `scripts/check-caddy.mjs`);
   - client UI integration (`src/client.tsx`, `src/preferences.ts`);
   - installer and lifecycle (`src/installer/`, `src/cli.ts`), including upgrade and doctor;
   - packaging and release surface (`package.json` file list, vendored Caddy manifests).
4. Classify each sibling surface as **affected** (code path or reproduction evidence), **not affected** (different mechanism — name it), or **unknown** (missing evidence). Distinguish sharing a primitive from having a reachable equivalent trigger: the same route-protection primitive is not affected while its trigger cannot reach that layer. A similarity of file names is not evidence.
5. Require public-boundary proof shaped by `.agents/skills/behavior-e2e-validation/SKILL.md`: first lock the failure and fix at the named boundary, then add the smallest sibling matrix whose surfaces share the reachable trigger. Do not force tests onto surfaces whose mechanism cannot exhibit the bug.
6. Evaluate scope: keep the submitted change correct, tested, and accurately scoped; require broader edits only when they introduce an unsafe shared abstraction or leave the named surface incompletely fixed. For confirmed sibling gaps, produce a maintainer follow-up plan with concrete files, E2E coverage, owner, and target branch.
7. Update conflicting review claims about other surfaces only from evidence gathered in step 4.

## Review Output

Return four sections:

1. **Current change correctness** — whether the named defect is reproduced and fixed at its public boundary.
2. **Cross-surface assessment** — surface-by-surface affected / not-affected / unknown matrix with implementation path, shared primitive, trigger reachability, impact, and evidence.
3. **Contributor action** — only changes reasonably required inside this change.
4. **Maintainer follow-up** — concrete remaining scope, tests, owners, and sequencing.

Treat any confirmed bypass of the authentication edge, session revocation gap, or secret exposure as immediate maintainer follow-up even when it does not block the current change.
