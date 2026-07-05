# Current Story Pack: S-B1 — Executor pure functions

**Feature:** linked-query
**Epic:** E-B (Main-side Executor & Handlers)
**Story:** S-B1
**Mode:** `standard_feature`, degraded to pack-as-beads (no `.beads/` in repo)
**Approved:** validation gate PASS with constraints C1–C4
**Date:** 2026-07-01

## Entry State

- Repo state after last commit / current working tree.
- `src/main/linked-query/` does not exist.
- No test runner installed.
- `npm run typecheck` green.
- `npm run build` green (verified pre-baseline).

## Exit State

- File `src/main/linked-query/executor.ts` exists and exports:
  - `stripCommentsAndStrings(sql: string): string`
  - `isReadOnlyStatement(sql: string): boolean` — narrowed to
    `^(SELECT|WITH)\b` per **C1**.
  - `applyAutoLimit(sql: string, limit: number): { sql: string; appended: boolean }`
    — copied verbatim from `QueryEditor.tsx` (uses the local
    `stripCommentsAndStrings`).
  - `checkKeyBounds(keyValues: unknown[], max: number): { ok: true } | { ok: false; message: string }`
  - `rewritePlaceholder(sql: string, keyValues: unknown[]): { sql: string; params: unknown[]; usedColumn: string | null }`
    — parses `:step1.<col>` tokens on the sanitised copy (per **C2**),
    splices `IN ($1, $2, ..., $n)` into the original, drops null
    values from `keyValues` (VQ4), throws a typed `LinkedRewriteError`
    on unknown `:stepN.<col>` prefix (`N ≠ 1`) or on `:step1.<col>`
    where `<col>` is not the caller-supplied key column.
- `npm run typecheck` remains green.
- If `vitest` install succeeds (see task 4 below), the executor test
  file passes; otherwise proof bar degrades to task 5's manual log.

## Files Likely Touched

- **New:** `src/main/linked-query/executor.ts`
- **New (conditional):** `src/main/linked-query/executor.test.ts`
- **New (conditional):** `vitest.config.ts` at repo root
- **Modified (conditional):** `package.json` — add `vitest` +
  `@types/node` if not already present + `"test": "vitest run"` script
- **Unchanged:** everything under `src/renderer/**`, `src/main/pg/**`,
  `src/main/ipc/**`, `src/shared/**`.

## Task List (bead-equivalents)

Each task is worker-sized. Task 4 and 5 are mutually exclusive — task 5
only runs if task 4 (install) fails.

### T-1 — Create `src/main/linked-query/executor.ts`

- Create the folder.
- Port `stripCommentsAndStrings`, `isReadOnlyStatement` (narrowed per
  C1), and `applyAutoLimit` from `QueryEditor.tsx`, adjusted for
  main-process style (no React imports).
- Implement `checkKeyBounds(keyValues, max)`.
- Implement `rewritePlaceholder(sql, keyValues)`:
  - Sanitised scan finds every `:stepN.<identifier>` token; validates
    `N === 1` and `<identifier>` matches the caller-supplied key
    column; throws `LinkedRewriteError` with actionable message on
    mismatch.
  - Drop nulls from `keyValues` (VQ4). If the result is empty, do
    NOT rewrite — return `{ sql, params: [], usedColumn }` so the
    handler layer can short-circuit per D4.
  - Build `IN ($1, $2, ..., $n)` and splice into the original SQL
    at the token offsets recorded from the sanitised scan
    (per **C2**).
  - Return `{ sql, params, usedColumn }`.
- Export a typed `LinkedRewriteError extends Error` with a machine
  code discriminator (`'UNKNOWN_STEP'` / `'UNKNOWN_COL'`).
- Add a top-of-file comment citing CONTEXT decisions D2, D4 and
  constraints C1, C2 (per critical pattern "cite decision IDs").
- Run `npm run typecheck`. Must be green.

**Done when:** file compiles, all functions exported, typecheck green.

### T-2 — Handler API contract sketch (no wiring yet)

- In the same file (bottom), export the payload/result type aliases
  used by `linked:step-run` and `linked:final-run` so S-A2 can import
  them without further churn:
  - `type LinkedStepRunPayload = { connectionId: string; database: string; sql: string }`
  - `type LinkedStepRunResult = { rows: Record<string, unknown>[]; fields: string[]; rowCount: number; durationMs: number }`
  - `type LinkedFinalRunPayload = { connectionId: string; database: string; sql: string; keyColumn: string; keyValues: unknown[] }`
  - `type LinkedFinalRunResult = LinkedStepRunResult | { skipped: true; reason: 'EMPTY_KEYSET' }`
- These are pure type declarations; no runtime cost.

**Done when:** types exported, typecheck green.

### T-3 — Unit-test skeleton (no runner yet, just the file)

- Create `src/main/linked-query/executor.test.ts` with **describe/it**
  syntax compatible with both `vitest` and `node:test`. Cover
  every risk-map "Proof needed" row:
  - `isReadOnlyStatement`: SELECT/WITH accepted; INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE rejected; keyword hidden inside literal or comment does not fool it (`-- DELETE FROM x; SELECT 1` → true).
  - `applyAutoLimit`: bare SELECT gets LIMIT; SELECT with LIMIT unchanged; SELECT with FETCH FIRST unchanged; DML unchanged.
  - `checkKeyBounds`: 5000 accepted; 5001 rejected with CONTEXT-worded message.
  - `rewritePlaceholder` — happy: `where uid = :step1.uuid` + `['a','b']` → `where uid IN ($1, $2)` + params `['a','b']`.
  - `rewritePlaceholder` — literal safety: `where x = 'not :step1.uuid'` → SQL unchanged, no params emitted.
  - `rewritePlaceholder` — null drop (VQ4): `['a', null, 'b']` → params `['a','b']`.
  - `rewritePlaceholder` — all-null drop yields empty-keyset return shape.
  - `rewritePlaceholder` — unknown step (`:step2.uuid`) throws `LinkedRewriteError.UNKNOWN_STEP`.
  - `rewritePlaceholder` — unknown column (`:step1.foo` when keyColumn = `uuid`) throws `LinkedRewriteError.UNKNOWN_COL`.
  - `rewritePlaceholder` — multiple tokens rewrite consistently.

**Done when:** file compiles under `tsc --noEmit`; runner missing is OK for now.

### T-4 — Install vitest and run T-3 (VQ1 = yes)

- `npm install --save-dev vitest`
- Create `vitest.config.ts` at repo root:
  ```ts
  import { defineConfig } from 'vitest/config'
  export default defineConfig({
    test: { include: ['src/**/*.test.ts'], environment: 'node' }
  })
  ```
- Add script to `package.json`: `"test": "vitest run"`.
- Run `npm run test`. Every test in T-3 must pass.

**Done when:** `npm run test` exits 0; test count matches T-3 assertions.

### T-5 — Fallback proof bar (only if T-4 install fails)

- Skip T-4 entirely.
- Keep `executor.test.ts` as design documentation but do not add a
  runner.
- Create `history/linked-query/manual-test-log.md` with the same 10
  test cases from T-3 executed via `node --input-type=module -e '…'`
  scripts and their observed output pasted in.
- Update `history/linked-query/validation.md` proof bar to
  "vitest install failed; manual-test-log.md is the executor proof".

**Done when:** each of the 10 cases has a pass/fail line in the log,
all passing.

## Feasibility Assumptions (proven at validation)

| Assumption | Proof | Result |
|---|---|---|
| Rewriter can splice safely | matrix rows 5, 6 | PASS |
| Null drop matches Postgres IN semantics | matrix row 7 | PASS |
| Statement classifier reject list | matrix row 3 with C1 | PASS |
| `applyAutoLimit` copyable | matrix row 4 | PASS |
| vitest install is achievable | matrix row 10 with C4 fallback | PASS-with-fallback |

## Verification

Green when:
- `npm run typecheck` exits 0.
- `npm run test` exits 0 (if T-4 landed) OR
  `history/linked-query/manual-test-log.md` shows 10 passes (T-5 path).
- No `pg`, `electron`, React, or IPC import appears in
  `executor.ts` — the file is pure.

## Out Of Scope

- No handler wiring (that is S-B2).
- No IPC channel constants (that is S-A2).
- No renderer changes (that is E-C / E-D).
- No product doc changes (that is S-D2).
- No behaviour change in existing `QueryEditor.tsx` (we copy, not
  move — QueryEditor's copies remain to avoid touching other stories).

## Bead Mapping

`.beads/` unavailable in this repo. Tasks T-1 through T-5 above are the
bead-equivalents for S-B1. Swarming will read this pack; executing will
work through T-1 → T-2 → T-3 → (T-4 XOR T-5).

## Handoff

Validation gate PASS. This pack is executable. Awaiting user approval
of the approval-gate block in `validation.md` before invoking
`khuym:swarming`.
