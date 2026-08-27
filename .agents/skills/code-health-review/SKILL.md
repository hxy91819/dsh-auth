---
name: code-health-review
description: Analyze dsh-auth code-health evidence (a CI Code Health artifact or a locally generated report) against the current branch or PR diff and return a pass / fix-recommended decision with proportionate actions, without editing code.
disable-model-invocation: true
---

# Code Health Review

Return a decision, not a score. Treat existing debt as context and isolate the regressions the analyzed change introduces.

## 1. Resolve the evidence

1. Read [docs/code-health/README.md](../../../docs/code-health/README.md) completely: it owns the tools, thresholds, architecture boundaries, and suppression style. Run `git status --short` and preserve all parallel work.
2. Prefer evidence that matches the revision under review:
   - For a GitHub PR, download the CI `Code Health` job artifact. It contains `.tmp/code-health/production/eslint.json`, `.tmp/code-health/production/jscpd.json`, and the matching `report/` outputs for tests and scripts.
   - For local branches, generate fresh reports with `corepack pnpm run report:code-health` and state that dirty working-tree changes are included.
   - To prove growth, generate the same report at the merge-base revision (for example in a second throwaway worktree) and diff the two result sets. Do not invent base/head flags; the report script analyzes the current tree only.
3. Stop and report an operational error when an analyzer crashes or the config fails to load. Green output can still carry findings; read the JSON verdicts, never the exit code alone.

## 2. Separate change from debt

Classify each finding into exactly one bucket:

- **Regression from this change** — the symbol or clone group is new or grew versus the base evidence. This is what the review decides about.
- **Existing debt** — present at base and unchanged. Record it as observation only.
- **Report-only** — everything under `tests/` and `scripts/`; health rules there warn without blocking, so keep them out of merge decisions unless they reveal real duplication of production semantics.

Watch for fragmentation and metric gaming alongside raw numbers: many tiny helpers that just relocate complexity, split files that still require simultaneous context, or a clone group whose fragments drifted apart in meaning.

## 3. Form recommendations

Apply the repository's ownership rule: the commit introducing a finding owns the response.

- Correctness lint errors, dependency-cruiser violations (cycles, unresolvable imports, undeclared dependencies, architecture boundaries), knip entry errors, and publint failures are hard gates. Recommend fixing them; do not propose suppressions.
- Size, statement-count, cognitive-complexity, cyclomatic-complexity, and duplicate-code findings in `src/` decide between the smallest structural fix (reduce nesting, separate parsing from I/O, share only genuinely stable invariants inside a clone group) and accepting the current shape with a precise per-rule, per-symbol suppression comment carrying the reason in the same commit.
- Whole-file disables, threshold changes, and config edits in lieu of code decisions are out of scope; recommend against them.

Label every item `fix before merge`, `consider`, or `accept with suppression reason`. Do not edit code, thresholds, or configs unless the user explicitly asks for that separately.

## 4. Report

Return these sections:

1. **Decision** — `pass`, `fix recommended`, or `analysis failed`, with the base and analyzed revisions.
2. **Regressions** — metric, symbol or path, base → head values, and why the change matters.
3. **Recommendations** — one ordered action per regression, each naming its evidence.
4. **Observations** — remaining hotspots, test-side advisories, and any gaming signals.
5. **Next action** — the concrete request the author should implement.

Finish only after every violation is classified and every recommendation names its evidence.
