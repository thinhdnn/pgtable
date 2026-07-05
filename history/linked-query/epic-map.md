# Epic Map: Linked Query

**Mode:** `standard_feature`

## Feature Outcome

When all epics finish: a user can open the "Linked Query" tab from the
TitleBar, run a SELECT against any connected `(connection, database)` as
Step 1, pick a key column from Step 1's result, write a Step 2 SELECT
against any `(connection, database)` referencing that key with
`:step1.<col>`, and see Step 2's rows in a grid — with SQL injection
blocked by parameterised placeholders, DML rejected, empty keysets
handled without a database round-trip, and Step 2 rows capped at
LIMIT 1000 by default. No persistence, no cross-DB join engine, no
native deps.

## Architecture / Reality Basis

- Electron main-only executor talks to `pg` via existing pool-manager;
  renderer never imports `pg`.
- Two new IPC channels: `linked:step-run` (Step 1) and `linked:final-run`
  (Step 2, carries key-column name + key values).
- Discriminated `TabId` union gains a third variant `kind: 'linked-query'`.
- No new native dep; `vitest` added as dev dep for pure-function proofs
  (subject to VQ1 approval).

## Epics

| Epic | Capability / Risk Area | Why It Exists | Stories | Proof Needed |
| --- | --- | --- | --- | --- |
| **E-A: Types & IPC Contract** | Shape the wire contract before backend so both sides can develop against it. | Prevents "invent types under time pressure" that ai-sql-generation review flagged. | S-A1 (`TabId` + tab helpers); S-A2 (payload/result types + IPC channels) | Typecheck passes; no runtime yet. |
| **E-B: Main-side Executor & Handlers** | Security surface: placeholder rewriter, SELECT/WITH whitelist, IN-list bounds, auto-LIMIT, empty-keyset guard, IPC handlers wired to pool-manager. | This is where SQL injection is prevented. Ship pure functions unit-testable. | S-B1 (executor pure functions); S-B2 (linked-query-handlers + register in `main/index.ts`); S-B3 (vitest suite for executor, gated on VQ1) | `npm run test` green (if VQ1 = yes); typecheck + build green; manual smoke via devtools IPC call. |
| **E-C: Tab UI** | The user-visible surface: two-step card layout, source pickers, key-column dropdown gated by D1, `ResultGrid` reuse. | This is where D1 iterative flow becomes real. | S-C1 (`LinkedQueryTab.tsx` skeleton + Step 1 card); S-C2 (Step 2 card + key dropdown + run + `ResultGrid`); S-C3 (error/empty/limit messaging per CONTEXT.md D4) | Manual UAT: full happy path + empty keyset + oversize keyset + rejected DML. |
| **E-D: Entry Point & Docs** | Makes the feature reachable + documented. | Without this, ship is invisible. | S-D1 (TitleBar button + `openLinkedQueryTab()` in store + App tab switch); S-D2 (`docs/product/linked-query.md`) | Visual smoke: button clicks open tab; grep confirms product doc exists. |

## Story Queue

| Story | Epic | Outcome | Depends On | Feasibility Status |
| --- | --- | --- | --- | --- |
| S-A1 | E-A | `LinkedQueryTab` variant + `tabKey` handles it; existing tabs unaffected | — | needs validating (LOW) |
| S-A2 | E-A | `LINKED_STEP_RUN` / `LINKED_FINAL_RUN` channels + payload/result types compile | S-A1 | needs validating (LOW) |
| S-B1 | E-B | `src/main/linked-query/executor.ts` with `stripCommentsAndStrings`, `isReadOnlyStatement`, `applyAutoLimit`, `rewritePlaceholder`, `checkKeyBounds` — all exported | S-A2 | needs validating (**MEDIUM** — see risk map) |
| S-B2 | E-B | `registerLinkedQueryHandlers()` called from `main/index.ts`; both IPC channels return proper `IpcResult` envelopes | S-B1 | needs validating (LOW) |
| S-B3 | E-B | `executor.test.ts` covers every risk-map "Proof needed" row; `npm run test` runs green | S-B1, VQ1 approval | **BLOCKED on VQ1** |
| S-C1 | E-C | Empty tab with Step 1 card: source picker (connection + database), CodeMirror SQL editor, Run button | S-A1 | needs validating (LOW) |
| S-C2 | E-C | Step 2 card appears after Step 1 preview arrives (D1); key-column dropdown populated from Step 1 result fields; Step 2 Run wired to `LINKED_FINAL_RUN`; result rendered via `ResultGrid` | S-C1, S-B2 | needs validating (LOW) |
| S-C3 | E-C | User-facing messages: rejected DML, oversize keyset, empty keyset (D4), unknown `:step1.<col>` placeholder | S-C2 | needs validating (LOW) |
| S-D1 | E-D | New TitleBar button opens a Linked Query tab; unlimited tabs (per VQ2 default) | S-A1, S-C1 | needs validating (LOW) |
| S-D2 | E-D | `docs/product/linked-query.md` created; not linked from overview.md | — | needs validating (LOW) |

## Current Story To Prepare

**S-B1 — Executor pure functions.**

- **Why now:** highest-risk work (SQL injection defense). Every other
  story depends on this contract shape. Pure functions can be validated
  before any wiring.
- **Testable exit:** file `src/main/linked-query/executor.ts` exists;
  every function exported; `tsc --noEmit` passes; if VQ1 = yes, matching
  `executor.test.ts` runs green under `npm run test`.

Beads for all other stories wait until `khuym:validating` accepts
feasibility for S-B1.

## Approval Summary

- **Current epic:** E-B (Main-side Executor & Handlers), starting with S-B1.
- **Picture after E-B:** wire contract locked, security-relevant pure
  functions proven, IPC channels callable end-to-end from devtools.
- **Deferred to future features:** persistence, N-step chains,
  composite keys, client-side Step 1 ⨝ Step 2 merge, cross-DB
  analytical joins requiring DuckDB.

## Handoff

Planning has chosen the smallest work shape. Approve the epic map, the
current story pick (S-B1), and the answers to VQ1–VQ5 in
`approach.md` before current-story prep and bead creation. Tough work
uses an epic map; beads wait until feasibility passes.

Next skill: `khuym:validating`.
