# Validation Report: S1 / US-020 — Troubleshoot SQL Error

**Date:** 2026-07-09
**Scope of this pass:** non-live evidence only. A2 and A3 require live provider
calls and were deferred by the user. Beads are **not** created.

## Reality Gate Report

```text
Mode: high_risk_feature
Current work: S1 — troubleshoot action on the QueryEditor error alert (US-020)
MODE FIT:      PASS
REPO FIT:      PASS
ASSUMPTIONS:   FAIL -> repaired  (A4 refuted; design corrected in place)
SMALLER PATH:  PASS
PROOF SURFACE: PASS
Decision: run spike first (A2, A3)
```

**Baseline, measured this session, before any edit:**

```text
npm run typecheck  -> exit 0
npm run test       -> 11 files, 114 tests, all passing
```

- **MODE FIT.** Five intake flags plus the external-provider hard gate. The
  high-risk story folder exists and is filled. `US-018` is the precedent.
- **REPO FIT.** Every symbol the plan leans on exists: `resolveTarget`
  (`ai-handlers.ts:156`), `fetchSchemaTables`, `fetchForeignKeys`, `callModel`,
  `parseCheckResponse` (`client.ts:79`), `stripCommentsAndStrings`
  (`executor.ts:39`). `@shared/*` resolves at build **and** under vitest
  (`vitest.config.ts` aliases it), and six main-process modules already import
  runtime values from it — so a new pure `@shared` module is a proven pattern,
  not a hope.
- **SMALLER PATH.** Challenged and rejected. `small_change` caps at 3 files;
  this touches 12. Collapsing to a single channel shared with `ai:check-sql`
  was rejected in planning on payload grounds and nothing here changes that.
- **PROOF SURFACE.** `typecheck` + `test` + `build` all run. `npm run lint` does
  **not** — re-verified: `node_modules/.bin` contains no `eslint`. It stays out
  of the proof bar.

## Feasibility Matrix

| Assumption | Risk | Proof required | Evidence | Result |
|---|---|---|---|---|
| **A1** `parseCheckResponse()` reusable verbatim; optional `fixedSql` satisfies D4 | LOW | code inspection + a unit test | Logic read end-to-end (`client.ts:78-125`): coerces `severity`, drops malformed issues, strips fences from `fixedSql`, degrades to `{ok:false, summary:<raw>}` on unparseable text. **But it has no `export` keyword and `client.ts` has no test file.** `providers.test.ts` passes 12/12 while importing the module that pulls in both provider SDKs, so a `client.test.ts` is viable once the function is exported. | **READY WITH CONSTRAINTS** — the export is a prerequisite of the test, not an optional tidy-up |
| **A2** A live provider returns parseable JSON when the user message carries a raw multi-line Postgres error | MEDIUM | live call, `.spikes/` | none yet — **deferred by user** | **NOT PROVEN** |
| **A3** A connection error yields a response with **no** `fixedSql` | MEDIUM | live call, `.spikes/` | none yet — **deferred by user** | **NOT PROVEN** |
| **A4** Extracting `isReadOnlyStatement` is behaviour-preserving | LOW (claimed) | inspection + existing tests | **Refuted.** `executor.ts:92` is `^(SELECT\|WITH)\b`; `QueryEditor.tsx:148` is `^(SELECT\|WITH\|TABLE\|VALUES)\b`. `executor.test.ts:39-40` pins `isReadOnlyStatement('TABLE t') === false` with the comment *"narrowed per C1"*. `stripCommentsAndStrings` also has two further callers inside `executor.ts` (`applyAutoLimit`, `rewritePlaceholders`) and is imported by `executor.test.ts`. | **REFUTED → REPAIRED** |
| **A5** `resolveTarget()` / `NO_API_KEY` routing unchanged | LOW | inspection | `ai-handlers.ts:156-160`, four lines, no call site in this story modifies it | **PROVEN** |

## CRITICAL Finding — A4

The plan said: *extract `isReadOnlyStatement` to `src/shared/`, delete both
copies.* Doing that as written would have shipped a silent safety regression.

The two same-named functions do **different jobs**:

| Location | Regex | `TABLE t` / `VALUES (1)` | Job |
|---|---|---|---|
| `executor.ts:92` | `^(SELECT\|WITH)\b` | rejected | **execution guard** — what the linked-query runner and `duck-runner.ts` will let run. Narrowed on purpose per constraint C1. |
| `QueryEditor.tsx:148` | `^(SELECT\|WITH\|TABLE\|VALUES)\b` | accepted | **warning classifier** — does this AI-authored statement mutate data? |

Unifying on the broad regex would let `TABLE t` and `VALUES (1)` through the
read-only execution guard that `duck-runner.ts` relies on. Unifying on the narrow
regex would make `QueryEditor` warn about statements that mutate nothing.

**Repair applied** (design docs only; no source touched):

- `src/shared/sql-statement.ts` gets `stripCommentsAndStrings` and a **new,
  distinctly named** `isNonMutatingStatement` (broad — the classifier).
- `isReadOnlyStatement` **stays** in `executor.ts` as the narrow guard, unrenamed.
  `duck-runner.ts` and `linked-query-handlers.ts` keep their exact behavior.
- A mutation-checked test must pin the divergence: `isReadOnlyStatement('TABLE t')`
  false **and** `isNonMutatingStatement('TABLE t')` true, in the same run. Anyone
  who later collapses them breaks a suite.

Files repaired: `design.md`, `overview.md`, `execplan.md`, `validation.md`,
`epic-map.md`, `story-pack-S1.md`.

## Secondary Finding — a false citation in the plan

Planning claimed `executor.ts`'s comment *"Copied from ... QueryEditor.tsx and
kept in sync"* referred to `isReadOnlyStatement`. It does not — it sits above
`applyAutoLimit` (`executor.ts:97-100`). The `applyAutoLimit` copies **are**
byte-identical; the `isReadOnlyStatement` copies are not. The misattribution
appeared in three documents and is now corrected in all of them.

Deduplicating `applyAutoLimit` is real but **unrelated scope**; it is not added
to this story.

## Integration Readiness

Believable. The new channel plugs into `registerAiHandlers()` exactly like the
four existing AI verbs; the renderer branches on `'error' in res` as every other
AI call site does; `<TroubleshootPanel>` renders the same `Alert` + optional
button shape `QueryEditor.tsx:726-784` already ships. No hidden architecture work
surfaced.

## Current Story Readiness

| Check | Status |
|---|---|
| Exit state testable | yes — seven-step UAT + proof bar |
| Blocking assumptions proven or constrained | **no — A2, A3 unproven** |
| Integration believable | yes |
| Verification concrete | yes |
| Beads worker-sized and current-work scoped | n/a — no beads exist, correctly |

## Decision

```text
NOT READY - RUN SPIKE
```

A2 and A3 are MEDIUM assumptions that can invalidate the current story, and both
need a live provider call. Per the non-negotiable gates, no source-editing
execution may begin and no beads may be created until they return **YES**.

A4 was refuted and repaired without touching source. A1 and A5 are proven, A1
with a recorded constraint.

## Spike Questions (blocking, one yes/no each)

1. **A2** — Given a user message containing a real multi-line Postgres error
   (`ERROR: column "emai" does not exist` + `LINE 1:` + `HINT:`), does the active
   provider return text from which `parseCheckResponse()` recovers a `fixedSql`?
   Record: `.spikes/troubleshoot-sql-live-call.md`.
2. **A3** — Given a `Not connected` error and the same prompt, does the provider
   return a response with **no** `fixedSql`?

A `NO` on either returns the workflow to `khuym:planning`. A2 failing means the
prompt strategy changes. A3 failing means D4's "hide the Apply button" cannot
rest on the optional field and needs a different mechanism — which is a `CONTEXT.md`
decision, not an implementation detail.

## Requirements For Live Proof

- A running Postgres with a `users` table having an `email` column.
- An AI provider configured with a valid key in Settings.
- Both spikes cost tokens. Neither may join the `npm run test` gate.
