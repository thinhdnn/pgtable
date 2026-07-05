# Linked Query — Approach

**Feature slug:** linked-query
**Mode:** `standard_feature`
**Date:** 2026-07-01

## Why This Mode

- >3 files touched (executor + handlers + types + IPC + tab + TitleBar +
  store + App + product doc) → not `small_change`.
- Single ordered user capability, no hard-to-reverse effects (no schema
  change, no external secret, no persistence, no cross-platform surface) →
  not `high_risk_feature`.
- Every dependency and every code pattern is already proven in the repo →
  no `spike` required.

## Recommended Approach

Build the feature as **one vertical slice** with four capability epics
executed in dependency order (no phases — every epic must land together for
the feature to ship; the epic map exists to bound worker beads, not to
gate demos).

- **Contract-first:** land the pure functions and IPC contract before the
  UI. The rewriter and whitelist are the security surface; they must be
  unit-testable and reviewed in isolation.
- **Reuse aggressively:** `ResultGrid`, `applyAutoLimit`, statement
  classifier, `getOrCreatePool`. No new grid, no new pool code, no new SQL
  parser.
- **Renderer holds Step 1 result set** for v0 (no main-side cache). The
  Step 2 handler receives `keyValues: unknown[]` on the wire — renderer is
  responsible for extracting them from the cached Step 1 rows using the
  user-selected column. Simpler, no eviction problem, matches "no
  persistence" constraint.
- **Two IPC channels, not one:** `linked:step-run` (executes a single
  read-only SELECT, returns rows + fields) and `linked:final-run` (accepts
  Step 2 SQL + key-column name + key values, applies rewriter + whitelist
  + auto-LIMIT, executes). Distinct payload shapes and distinct error
  surfaces (Step 1 has no rewriter path) — collapsing them adds a
  discriminator and blurs the contract.
- **Introduce `vitest`** in this feature for the pure functions
  (rewriter, whitelist, IN-list bounds check). Scoped, no runtime cost,
  closes the F1 finding. If validating rejects the scope creep, downgrade
  the proof bar to "run the rewriter test file with `node --test`" or
  drop tests entirely and prove via manual scenario walkthrough — but
  that weakens the security-relevant checks.

## Rejected Alternatives

- **In-repo DuckDB / cross-DB join engine.** Rejected: violates "no native
  dep" and the pushdown chain already covers the stated use case.
- **Sidebar entry with persistence.** Rejected: v0 scope is single-tab,
  no save/list. Deferred to post-v0.
- **Composite key support.** Rejected: v0, single-column key only (D2).
  Future: add a distinct `:step1.(a,b)` syntax without breaking existing
  `:step1.<col>`.
- **Main-process cache of Step 1 rows.** Rejected: adds state ownership,
  eviction, multi-tab identity to solve nothing the renderer can't hold.
- **One combined IPC channel with `phase: 'step1' | 'final'` discriminator.**
  Rejected: fewer types, more branching; Step 1 doesn't need the rewriter
  or the whitelist to know about `keyValues`. Two clean channels beat one
  fat one.
- **Client-side merge of Step 1 columns into Step 2 grid.** Rejected: D3.

## Risk Map

| Component | Risk | Reason | Proof needed |
| --- | --- | --- | --- |
| `:step1.<col>` rewriter | **MEDIUM** | SQL-injection surface if not parameterised, edge cases (JSONB values, nulls, empty strings, unicode). | Unit tests: parametrisation, `IN ($1,...,$n)` shape, null → NULL param, empty keyset guard, unknown column, unknown `:stepN.` prefix, tokens inside string literals/comments must NOT rewrite. |
| SELECT/WITH whitelist | **MEDIUM** | Rejecting DML/DDL is a safety promise. False positives (rejecting valid SELECT) or false negatives (accepting `DELETE` after a comment). | Unit tests: SELECT, WITH, TABLE, VALUES accepted; INSERT/UPDATE/DELETE/DROP/ALTER rejected; keyword hidden inside literal/comment does not fool the classifier. |
| Empty keyset guard (D4) | LOW | Simple branch, but must run BEFORE the rewriter. | Unit test: 0-length `keyValues` short-circuits with the empty-keyset result shape. |
| IN-list upper bound (5000) | LOW | Arbitrary limit, but rejection message must be actionable. | Unit test: 5001 keys → reject with the CONTEXT-specified message. |
| Auto-LIMIT 1000 on Step 2 | LOW | `applyAutoLimit` already proven in QueryEditor. | Reuse-in-place; unit test that Step 2 without LIMIT gets one, with LIMIT stays as-is. |
| Cross-DB pool reuse | LOW | `getOrCreatePool` handles it. | Manual: run Step 1 on DB A and Step 2 on DB B in same tab — both pools open. |
| TitleBar button + tab kind | LOW | Additive to `TabId` union; TypeScript catches missed switch arms. | Typecheck + build; visual smoke. |
| App bundling / vite config | LOW | `pg` is already externalised. No new native dep. | Build passes. |
| Vitest introduction | LOW | New dev dep, no runtime impact. | `npm run test` returns green. |

## Likely File / Order Boundaries

Ordered by dependency:

1. `src/shared/types.ts` — add `LinkedQueryTab`, step payload/result
   types, extend `TabId`, update `tabKey()`.
2. `src/shared/ipc-channels.ts` — add `LINKED_STEP_RUN`,
   `LINKED_FINAL_RUN`.
3. `src/main/linked-query/executor.ts` (new file) — pure functions:
   `stripCommentsAndStrings`, `isReadOnlyStatement`, `applyAutoLimit`
   (copy from QueryEditor), plus `rewritePlaceholder`,
   `checkKeyBounds`. All exported for unit testing.
4. `src/main/ipc/linked-query-handlers.ts` (new file) —
   `registerLinkedQueryHandlers()` for both channels.
5. `src/main/index.ts` — call `registerLinkedQueryHandlers()`.
6. `src/renderer/src/store/active-connection.tsx` — add
   `openLinkedQueryTab()`.
7. `src/renderer/src/components/linked-query/LinkedQueryTab.tsx` (new
   file) — the two-step UI (source picker per step, CodeMirror editor,
   run button, key-column dropdown, `ResultGrid` for Step 2).
8. `src/renderer/src/components/TitleBar.tsx` — add the new button
   next to Settings.
9. `src/renderer/src/App.tsx` — extend the tab-content switch.
10. `docs/product/linked-query.md` — product doc.
11. Optional: `package.json` + `vitest.config.ts` if vitest lands here.

Tests (if vitest lands): `src/main/linked-query/executor.test.ts` covering
every row in the risk-map "Proof needed" column.

## Relevant Learnings

- Critical pattern: **Provider SDK in Electron main via
  `externalizeDepsPlugin`** — this feature is not an SDK integration but
  the "narrow IPC channel, no renderer-side data access" rule applies
  directly to the executor placement.
- Critical pattern: **Proof Bar Must Match Actually-Installed Tooling** —
  do NOT list `npm run lint` in this feature's proof bar. If we add
  vitest, prove `npm run test` runs green before locking the bar.
- ai-sql-generation feature: model the executor + handlers registration
  after `registerAiHandlers()`.
- ai-sql-generation feature: reuse `qid()` pattern for identifier quoting
  if we validate `:step1.<col>` refers to a real Step 1 column
  server-side; simpler is renderer-side check (Step 1 result set is in
  renderer anyway).

## Validating Questions

Planning defers these to `khuym:validating`:

- **VQ1:** Is `vitest` acceptable as an in-feature dev dep, or should we
  ship without tests and rely on manual scenario walkthrough for the
  security-relevant pure functions? (If yes → validating writes the
  proof bar with `npm run test`. If no → validating tightens manual
  walkthrough scope.)
- **VQ2:** Renderer-side `openLinkedQueryTab()` opens at most one Linked
  Query tab (singleton) or unlimited (each button click opens a new tab
  with a unique id, matching `openQueryTab()`)? CONTEXT.md is silent;
  planning proposes **unlimited** for parity with query tabs.
- **VQ3:** Where do we send the `linked-query` route in the intake
  matrix? Proposed: new story block `US-013…US-016` under a new epic
  `E04-linked-query`, registered via
  `scripts/bin/harness-cli story add`. Validating confirms lane =
  Normal (2 flags: touches existing behavior + weak proof around a new
  SQL surface).
- **VQ4:** Placeholder-rewriter policy on `NULL` keys — do we
  short-circuit `IN ($1,…)` to `IN (…) OR <col> IS NULL` when a null is
  present, or drop nulls silently, or reject with an error? Planning
  proposes **drop nulls silently** (matches Postgres `IN (…)` semantics
  where `NULL` never matches anyway) with a fallback rule "if the
  keyset becomes empty after null-dropping, treat as D4 empty
  keyset".
- **VQ5:** Do we open Linked Query tabs regardless of whether any
  connection is connected? CONTEXT.md D5 says the tab is not tied to a
  connection. Planning proposes **yes** — the source picker inside
  each Step is where connection selection happens; the button is
  always enabled.

## Handoff Note

CONTEXT.md remains the source of truth. This approach honours D1–D5
verbatim. Planning stops here for approval of the epic map and the
current-story choice below.
