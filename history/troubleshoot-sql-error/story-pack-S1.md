# Current Story Pack: S1 — Troubleshoot a failed query in QueryEditor

**Epic:** E1 (the troubleshoot contract) · **Harness story:** US-020
**Lane:** high-risk · **Canonical artifacts:**
`docs/stories/epics/E05-ai/US-020-troubleshoot-sql-error/`
(`overview.md`, `design.md`, `execplan.md`, `validation.md`)

This pack is the Khuym-side index. The story folder is the source of detail; it
is not duplicated here.

## Entry State

- `QueryEditor` renders a run error in an `Alert` (`QueryEditor.tsx:981-996`)
  with a `deriveSqlHint()` line that only fires for reserved-word table traps.
- The only AI path to SQL correctness is `ai:check-sql` — a **pre-run** review
  with no error message in its payload (`types.ts:261-266`).
- `isReadOnlyStatement` exists **twice under one name, with different accept
  surfaces**: `QueryEditor.tsx:148` (private, untested, `SELECT|WITH|TABLE|VALUES`
  — a *warning classifier*) and `executor.ts:92` (tested, `SELECT|WITH` — a
  narrow *execution guard* per C1, imported by `duck-runner.ts`).
  `executor.test.ts` pins `isReadOnlyStatement('TABLE t') === false`.
- `parseCheckResponse()` (`client.ts:78-125`) already returns
  `{ok, summary, issues[], fixedSql?}` with `fixedSql` optional, but is
  **module-private** — no `export` keyword, and `client.ts` has no test file.

## Exit State

- `ai:troubleshoot-sql` exists, discriminated on `kind`, with `kind: 'query'`
  implemented. It returns `AiTroubleshootResult | { error: string }`, reusing
  `resolveTarget()` and `parseCheckResponse()` unchanged.
- The `QueryEditor` error `Alert` carries a troubleshoot icon, shown for **every**
  error (D4). Clicking it renders `<TroubleshootPanel>`: a diagnosis, an issue
  list, and an `Apply suggested fix` button **only when `fixedSql` is present**.
- Apply writes the corrected SQL to the editor and raises the existing
  non-`SELECT` warning when appropriate. **It never runs the statement** (D2).
- `src/shared/sql-statement.ts` holds `stripCommentsAndStrings` and a new
  `isNonMutatingStatement` (the broad warning classifier). The narrow C1 guard
  `isReadOnlyStatement` **stays** in `executor.ts`; `duck-runner.ts` guards
  exactly as before. A mutation-checked test pins the two apart.
- `parseCheckResponse` is exported so its reuse can be unit-tested.
- `docs/decisions/0012-ai-troubleshoot-sql-channel.md` records the new channel
  and the fact that user-typed SQL literals leave the machine.

## Files Likely Touched

| # | File | Why |
|---|---|---|
| 1 | `src/shared/sql-statement.ts` *(new)* | `stripCommentsAndStrings` + `isNonMutatingStatement` |
| 2 | `src/shared/sql-statement.test.ts` *(new)* | classifier tests + divergence guard |
| 3 | `src/main/linked-query/executor.ts` | import the stripper from `@shared`; **keep** `isReadOnlyStatement` |
| 4 | `src/renderer/src/components/query/QueryEditor.tsx` | drop private copies; icon + panel wiring |
| 5 | `src/shared/types.ts` | `AiTroubleshootPayload` / `AiTroubleshootResult` |
| 6 | `src/shared/ipc-channels.ts` | `AI_TROUBLESHOOT_SQL` + comment block |
| 7 | `src/main/ai/prompt.ts` | `TROUBLESHOOT_SYSTEM_PROMPT`, `buildTroubleshootUserMessage()` |
| 8 | `src/main/ai/client.ts` | `troubleshootSql()`; **export** `parseCheckResponse` |
| 9 | `src/main/ai/client.test.ts` *(new)* | the A1 reuse test, impossible until #8 |
| 10 | `src/main/ipc/ai-handlers.ts` | handler |
| 11 | `src/renderer/src/components/common/TroubleshootPanel.tsx` *(new)* | shared with S2/S3 |
| 12 | `docs/decisions/0012-*.md` *(new)* | after validating passes |

Order is fixed by `execplan.md`: the shared extraction (1-4) lands **before** the
Apply button, because no surface may offer an AI-authored statement it cannot
warn about.

## Feasibility Assumptions

| # | Assumption | Risk | Proof needed |
|---|---|---|---|
| A1 | `parseCheckResponse()` is reusable verbatim; `fixedSql` optional already satisfies D4 | LOW | **PROVEN, with a constraint**: logic read end-to-end; but it is module-private, so the planned unit test needs an `export` first |
| A2 | A live provider returns **parseable JSON** when the user message contains a raw multi-line Postgres error (`ERROR: ... LINE 1: ... HINT: ...`) | **MEDIUM** | **V1 — live call, blocking.** No existing prompt takes an error string. Record under `.spikes/` |
| A3 | A non-SQL failure (`Not connected`) yields a response with **no** `fixedSql` | **MEDIUM** | **V2 — live call.** If the model invents a `fixedSql` anyway, D4's "no Apply button" collapses |
| A4 | Moving `isReadOnlyStatement` does not perturb `duck-runner.ts`'s read-only guard | ~~LOW~~ | **REFUTED as written.** The two copies are not equivalent (`SELECT\|WITH` vs `SELECT\|WITH\|TABLE\|VALUES`). Unifying them widens the guard. Design corrected: two distinct names, guard stays put |
| A5 | `resolveTarget()` / `NO_API_KEY` routing needs no change | LOW | **PROVEN** by inspection (`ai-handlers.ts:156-160`); nothing in this story touches it |

A2 and A3 are why beads do not exist yet. `khuym:validating` must clear them
first — a MEDIUM unknown gets proof or a spike before execution beads.

## Verification

```bash
npm run typecheck
npm run test
npm run build
```

Plus `.spikes/troubleshoot-sql-live-call.md` (V1, V2) and the seven-step manual
UAT in `validation.md`.

**Not `npm run lint`.** Declared in `package.json`, but `eslint` is not
installed. See `history/learnings/critical-patterns.md`.

## Out Of Scope

Federated (S2 / US-023), Linked (S3 / US-024), `fetchDatabaseSchema()`, auto-run
after apply, multi-turn troubleshooting, capping the schema context sent to the
provider, table-grid and row-edit errors.

## Bead Mapping

**None.** Beads are created only after `khuym:validating` accepts A2 and A3.
