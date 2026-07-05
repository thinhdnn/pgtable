# Linked Query — Validation

**Feature slug:** linked-query
**Skill:** khuym:validating
**Date:** 2026-07-01
**Approved shape:** epic map (4 epics, 10 stories) — approved by user.
**Approved VQ1–VQ5 answers:** all defaults from `approach.md` accepted.
**Current work under validation:** S-B1 — executor pure functions.

## Reality Gate

```
REALITY GATE REPORT
Mode: standard_feature
Current work: Implement src/main/linked-query/executor.ts (pure functions
  for :step1.<col> rewriter, SELECT/WITH whitelist, IN-list bounds,
  auto-LIMIT, empty-keyset guard) and cover it with vitest tests.

MODE FIT:       PASS
  - >3 files (executor + tests + package.json + vitest.config +
    subsequent stories) → not small_change
  - No hard-to-reverse effects, no external secret, no schema change
    → not high_risk_feature

REPO FIT:       PASS
  - src/main/pg/pool-manager.ts::getOrCreatePool → verified, supports
    connectionId::database keying
  - src/main/pg/query-runner.ts::query(pool, sql, params) → verified,
    accepts parameterised SQL
  - src/renderer/src/components/query/QueryEditor.tsx →
    stripCommentsAndStrings, isReadOnlyStatement, applyAutoLimit
    all exist and are copy-ready
  - src/main/index.ts → registerAiHandlers() call site is the model
    for registerLinkedQueryHandlers()
  - electron.vite.config.ts → externalizeDepsPlugin() already
    externalises Node deps; no config change needed for vitest
    (vitest is a dev-time-only tool, runs on Node not in the bundle)
  - No native dep introduced by vitest — pure npm package

ASSUMPTIONS:    PASS
  - VQ1 approved: vitest can be added as devDependency; proven
    approach (vitest works standalone against .ts sources without
    modifying electron.vite.config.ts because tests run under vitest,
    not electron-vite)
  - VQ2 approved: unlimited Linked Query tabs (parity with query tabs)
  - VQ3 approved: register stories US-013..US-016 in a new epic
    E04-linked-query
  - VQ4 approved: drop nulls silently in key values; if the
    resulting keyset is empty, follow D4 path
  - VQ5 approved: TitleBar button always enabled

SMALLER PATH:   PASS
  - Cannot collapse to small_change (>3 files ship together)
  - Cannot collapse to direct_task (multiple stories, security-relevant
    pure functions warrant unit tests)
  - Cannot collapse epic map to fewer epics without merging
    orthogonal concerns; E-A/E-B/E-C/E-D each own a distinct area

PROOF SURFACE:  PASS
  - `npm run typecheck` (baseline verified green today)
  - `npm run build` (electron-vite build)
  - `npm run test` (WILL EXIST after S-B3 lands vitest)
  - Manual UAT for UI stories (S-C1..S-C3, S-D1)
  - Grep for docs/product/linked-query.md (S-D2)
  - DO NOT include `npm run lint` (eslint not installed — F2 finding
    from ai-sql-generation critical-patterns)

Decision: proceed
Evidence: see file paths above; typecheck baseline green
```

## Feasibility Matrix

| # | Assumption | Risk | Proof Required | Evidence | Result |
|---|---|---|---|---|---|
| 1 | `getOrCreatePool` supports arbitrary `(connectionId, database)` pairs so Step 1 and Step 2 can hit different pools | LOW | Read pool-manager.ts | `src/main/pg/pool-manager.ts` L37–44: `key = database ? \`${conn.id}::${database}\` : conn.id`. Pools cached by that key. | READY |
| 2 | Parameterised `IN ($1, $2, ..., $n)` executes correctly on Postgres via `pg` node driver | LOW | pg driver docs + existing usage | `query(pool, sql, params)` is used across `db-handlers.ts` and `ai-handlers.ts` with `$1, $2` placeholders. Postgres natively supports `IN ($1, $2, ...)`. | READY |
| 3 | Statement classifier `isReadOnlyStatement` correctly rejects DML/DDL when copied to main | LOW | Function is pure; already in production use for D6 warning in QueryEditor | `QueryEditor.tsx` L127–130: strips comments/strings first, then regex on `^(SELECT|WITH|TABLE|VALUES)`. **Constraint**: linked-query wants only SELECT/WITH (not TABLE/VALUES for Step 1 preview safety) — must narrow the regex when copying. | READY WITH CONSTRAINT |
| 4 | `applyAutoLimit` correctly caps Step 2 result rows at 1000 without breaking user-provided LIMIT | LOW | Function is pure; already used in QueryEditor with 500 cap | `QueryEditor.tsx` L108–120: appends `LIMIT n` only when no `LIMIT` / `FETCH FIRST/NEXT` present. Copy-and-parameterise the cap. | READY |
| 5 | `:step1.<col>` token matching does not fire inside string literals or comments | MEDIUM | Reuse `stripCommentsAndStrings` before scanning tokens; unit test for tokens inside `'foo :step1.x bar'` and `-- :step1.x` | Same sanitiser used by autoLimit is proven for literal/comment safety. Rewriter must run token detection on the *sanitised* copy but perform the replacement on the *original* text preserving offsets — this is the one non-trivial pattern. | READY WITH CONSTRAINT |
| 6 | Rewriter can safely substitute a variable-length IN-list at the token site | MEDIUM | Unit test for `where uid = :step1.uuid`, `where uid IN :step1.uuid`, multiple occurrences, unknown prefix `:stepX.uuid` | Straightforward string splice once tokens are found by index; tests will lock behaviour. | READY |
| 7 | Null values in key set behave correctly under Postgres `IN` semantics (VQ4 answer: drop) | LOW | Postgres reference: `x IN (NULL)` yields NULL not TRUE, so dropping nulls is semantically identical to including them; only observable side effect is smaller `$n` count | Well-known Postgres semantics. Unit test: `[1, null, 2]` → params `[1, 2]`. If result is `[]` after drop → follow D4 empty-keyset path. | READY |
| 8 | 5001 keys triggers the CONTEXT.md rejection message | LOW | Boundary constant; unit test at 5000 (accept) and 5001 (reject) | New logic; will be added in S-B1. | READY |
| 9 | Empty keyset guard runs BEFORE the rewriter so rewriter never sees a 0-length substitution | LOW | Order-of-operations rule; unit test invokes handler-level `runFinal({keyValues: [], sql: '...'} )` and asserts no rewriter throw, correct empty-result shape | Handler orchestration; enforced in S-B2. | READY |
| 10 | `vitest` can be installed as devDep and run in this repo without touching electron-vite config | LOW | Vitest is a standalone Node-side test runner; ships own vite instance; does not require electron. Similar projects use both electron-vite and vitest side-by-side. Proof: install + one trivial passing test | Will be executed as part of S-B3. If install fails, degrade proof bar (see repair note below). | READY WITH FALLBACK |
| 11 | New `TabId` variant `{ kind: 'linked-query' }` compiles cleanly with existing switch arms | LOW | TypeScript's exhaustiveness check will fail typecheck at every switch — this is the desired guardrail; we fix each site | `tabKey()` in `src/shared/types.ts`, TitleBar's `active.kind === 'query'` check, App.tsx's tab-content switch. All three sites will surface as typecheck errors when the union is extended — safe. | READY |
| 12 | No `.beads/` infra means we cannot use `br create` for worker tasks | KNOWN | Repo confirmed: no `.beads/`, no `br`, no `bv` on PATH | Same constraint that forced Reviewing-Lite for ai-sql-generation. Degrade to `current-story-pack.md` as the executable unit; swarming/executing will treat the pack as its bead list. | READY WITH CONSTRAINT |

**Decision:** **READY WITH CONSTRAINTS**

Constraints locked:

- **C1:** Executor's `isReadOnlyStatement` narrows to `^(SELECT|WITH)\b`
  only (not TABLE/VALUES) so Step SQL is unambiguously a proper SELECT.
- **C2:** Token detection must run on the sanitised copy but rewrite on
  the original — implement as `[{ start, end, colName }, ...]` offsets
  from sanitised scan, then splice into original.
- **C3:** No `.beads/`; feature ships with `current-story-pack.md`
  under `history/linked-query/` as the executable unit. Swarming will
  read the pack; executing will treat each S-Bn task as a bead
  equivalent. This is degraded-mode Khuym per ai-sql-generation
  precedent.
- **C4:** Proof bar for S-B3 explicitly requires vitest install to
  succeed before locking `npm run test` as a gate. If install fails,
  drop S-B3 and cover executor via a manual test walkthrough recorded
  in `history/linked-query/manual-test-log.md`.

## Spike / Probe

**None required.**

Every risk-map item has evidence from existing repo code or well-known
runtime semantics. No YES/NO question can invalidate the shape.

## Integration Readiness

- IPC bridge: `src/renderer/src/api.ts::invoke` (existing) + new
  handlers registered in `src/main/index.ts` next to
  `registerAiHandlers()`. Both channels return `IpcResult<...>`
  envelopes matching existing pattern. **PASS.**
- Tab UI: `App.tsx` has an editable-card `<Tabs>` that switches on
  `tab.kind`; extending the switch is additive. `TitleBar.tsx` already
  hosts a right-aligned actions cluster (Settings). **PASS.**
- No cross-cutting refactor. No new architecture layer. No new native
  dep. No config change beyond adding vitest as devDep and a
  `vitest.config.ts`. **PASS.**

## Current-Story Readiness (S-B1)

- **Entry state:** no `src/main/linked-query/` directory; executor
  functions do not exist in main.
- **Exit state:** `src/main/linked-query/executor.ts` exists and
  exports `stripCommentsAndStrings`, `isReadOnlyStatement`,
  `applyAutoLimit`, `rewritePlaceholder(sql, keyValues) → { sql,
  params }`, `checkKeyBounds(keyValues, max) → { ok, message? }`.
  `npm run typecheck` remains green.
- **Verification:** typecheck + (once S-B3 lands) `npm run test`.
- **Scope:** file creation and function export only. No handler
  wiring in S-B1 — that is S-B2.
- **Assumptions proven:** matrix rows 3, 4, 5, 6, 7, 8.

Written as `history/linked-query/current-story-pack.md` (see file).

## Bead Handoff

`.beads/` unavailable → beads replaced by tasks in
`current-story-pack.md`. Swarming/executing will treat each task as
a bead-equivalent (same pattern as ai-sql-generation Reviewing-Lite).

## Fresh-Eyes Review

- No CRITICAL flags.
- MINOR: rewriter constraint C2 (splice-on-original) is the one place
  someone could introduce a subtle bug. Locked into S-B1 tests.
- MINOR: vitest install path assumes standalone runner works; C4
  fallback documented.

## Approval Gate

```
VALIDATION COMPLETE - APPROVAL REQUIRED BEFORE EXECUTION
Mode:                    standard_feature
Work:                    epic map E-A → E-B → E-C → E-D
Current story:           S-B1 (executor pure functions)
Reality gate:            PASS
Feasibility:             READY WITH CONSTRAINTS (C1..C4)
Structure:               PASS after 1 iteration
Spikes:                  none (all assumptions have existing evidence)
Integration readiness:   PASS
Bead review:             not needed (no .beads/); pack replaces beads
Current story readiness: PASS
Unresolved concerns:     none
Approve execution for this work? (yes/no)
```
