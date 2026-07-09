# Troubleshoot SQL Error - Context

**Feature slug:** troubleshoot-sql-error
**Date:** 2026-07-09
**Exploring session:** complete
**Scope:** Standard
**Domain types:** SEE, CALL

## Feature Boundary

When a SQL statement the user wrote **fails at execution time**, the error alert
gains a **troubleshoot action**. Clicking it sends the failing SQL, the raw
error message, and that surface's schema context to the active AI provider, and
renders back a diagnosis plus — when the failure is fixable by rewriting the
SQL — a corrected statement the user can apply to the editor with one click.

The feature covers the three surfaces where a user authors and runs SQL:
`QueryEditor`, `FederatedQueryTab`, and each step of `LinkedQueryTab`.

It ends at **producing and applying corrected SQL text**. It never executes SQL,
never re-runs the query automatically, never sends row values, and does not
touch the table data grid, row editing, or connection management.

This is distinct from the existing `ai:check-sql`, which reviews SQL
**statically before it runs** and has no error message to reason about. This
feature is reactive: it only exists once an execution has actually failed.

## Locked Decisions

These are fixed. Planning must implement them exactly.

- **D1:** The troubleshoot action appears on **all three SQL execution
  surfaces**: `QueryEditor` (Postgres via `query:run`), `FederatedQueryTab`
  (DuckDB via `federated:run`), and **each individual step** of
  `LinkedQueryTab` (Postgres via `linked:step-run`). Each surface already owns
  its own error state and renders its own `Alert` — the action attaches to that
  existing error `Alert`, it is not a new global surface.

- **D2:** The result renders as an **inline panel with an explicit Apply
  button**, and **never auto-runs**. The panel shows the AI's diagnosis of why
  the statement failed and, when present, the corrected SQL. `Apply suggested
  fix` overwrites the editor content for that surface; the user then presses Run
  themselves.
  - Rationale: this is exactly the shape `ai:check-sql` already ships
    (`QueryEditor.tsx:726-784` — `Alert` + issue list + `Apply suggested fix`
    calling `applyFix()`), so the surface stays consistent. It also preserves
    the repo-wide rule that **the AI never executes anything** (D1 of
    `history/ai-sql-generation/CONTEXT.md`), which matters here because a
    "corrected" statement could be an `UPDATE` or `DELETE`.

- **D3:** The payload sent to the provider is **the failing SQL + the raw error
  message + that surface's schema context**, and **no row values**.
  - `QueryEditor`: tables/columns + FK edges of the selected schema, the same
    context `ai:check-sql` gathers today.
  - `FederatedQueryTab`: one context block **per attachment**, each carrying its
    **`alias`, `database`, `schema`**, plus that attachment's tables/columns and
    FK edges. The alias and database are required because federated SQL
    references tables as `alias.schema.table`, so without them the model cannot
    name a table correctly. `FederatedAttachment` (`src/shared/types.ts:393`)
    already carries all four fields, so the tab passes its existing
    `attachments` array straight through.
  - `LinkedQueryTab`: the schema context of that step's own
    `(connectionId, database)`, plus **the column names of the earlier steps**,
    so the model can reason about `:stepN.<col>` placeholders rather than
    treating them as syntax errors.
  - Row values never leave the machine. Sending actual data is reserved for
    `ai:ask-row`, which forces a per-send user confirmation.

- **D4:** The troubleshoot icon is **always shown whenever an error is
  displayed** — no client-side filtering of "AI-fixable" errors. When the
  failure is not a SQL authoring problem (`Not connected`, `ECONNREFUSED`, pool
  timeout), the AI returns a diagnosis with **no corrected SQL**, and the panel
  renders the diagnosis **without an Apply button**.
  - Rationale: a hardcoded list of connection-error string patterns is a
    maintenance trap and will misclassify. Making the corrected SQL optional
    mirrors `AiCheckSqlResult.fixedSql`, which is already an optional field
    (`src/shared/types.ts:285`).

### Inherited Constraints

Not new decisions — existing repo rules this feature must not break.

- Applying a fix must reuse the existing **non-`SELECT` warning**. `QueryEditor`
  already warns when AI-produced SQL is not a read-only `SELECT`
  (`QueryEditor.tsx:714-724`, D6 of `history/ai-sql-generation/CONTEXT.md`);
  a corrected statement is AI-produced SQL and gets the same treatment.
- A missing/unconfigured provider must return the existing `NO_API_KEY`
  sentinel, which the renderer routes to Settings
  (`resolveTarget()` in `src/main/ipc/ai-handlers.ts`).
- The provider call lives **in the main process only**. The renderer must never
  import a provider SDK, and the API key must never cross IPC
  (`history/learnings/critical-patterns.md`, both promoted patterns).

## Existing Code Context

From the quick scout. Downstream agents read these before planning.

### Reusable Assets

- `src/main/ipc/ai-handlers.ts` — `resolveTarget()`, `fetchSchemaTables()`, and
  `fetchForeignKeys()` are exactly the context-gathering this feature needs, and
  the `AI_CHECK_SQL` handler is the closest existing analogue end to end.
- `src/main/ai/client.ts` — `checkSql()` already returns a structured
  `{ ok, summary, issues[], fixedSql? }` from a provider; the troubleshoot
  response wants the same shape plus the error message as an input.
- `src/main/ai/prompt.ts` — `SQL_CHECK_SYSTEM_PROMPT` +
  `buildCheckUserMessage()` for the Postgres dialect;
  `FEDERATED_SYSTEM_PROMPT` + `buildFederatedUserMessageParts()` already teach
  the model the DuckDB `alias.schema.table` dialect.
- `src/renderer/src/utils/sql-hints.ts` — `deriveSqlHint()` is the existing
  local, zero-cost hint layer already rendered next to all three error alerts.
  It stays; troubleshoot is the escalation when the local hint finds nothing.

### Established Patterns

- **Result envelope:** every AI IPC handler returns `Result | { error: string }`
  and the renderer branches on `'error' in res`.
- **Alert + Apply:** `QueryEditor.tsx:726-784` is the reference rendering for a
  structured AI result with an optional corrective action.
- **One narrow IPC channel per AI verb:** `ai:generate-sql`,
  `ai:generate-federated-sql`, `ai:check-sql`, `ai:ask-row`, each declared with
  a comment block in `src/shared/ipc-channels.ts`.

### Integration Points

- `src/renderer/src/components/query/QueryEditor.tsx:981-996` — the `error`
  alert, already rendering `deriveSqlHint()`.
- `src/renderer/src/components/federated/FederatedQueryTab.tsx:524-538` — same
  alert, DuckDB errors.
- `src/renderer/src/components/linked-query/LinkedQueryTab.tsx:570-585` — the
  per-step error alert.
- `src/shared/ipc-channels.ts` — new channel declaration.
- `src/shared/types.ts` — new payload/result types.

## Canonical References

- `history/ai-sql-generation/CONTEXT.md` — D1 (AI never executes), D4 (schema
  scoping), D6 (non-`SELECT` warning).
- `history/learnings/critical-patterns.md` — provider SDK stays in main; never
  return raw secrets over IPC; proof bar must match installed tooling
  (`eslint` is **not** installed — do not promise a lint gate).
- `docs/decisions/0010-pluggable-ai-providers.md` — the provider abstraction any
  new AI call must go through.

## Outstanding Questions

### Deferred To Planning

- [ ] **`LinkedQueryTab` has no `schema` field.** `StepState`
      (`LinkedQueryTab.tsx:41-52`) holds only `connectionId` + `database`, but
      `fetchSchemaTables()` requires a schema name. Planning must decide how the
      linked surface supplies one (default `public`, derive from the step's
      introspection payload, or send every schema) and confirm the choice
      against what `SCHEMA_INTROSPECT` already returns to that tab.
- [ ] **One channel or three.** Whether the three surfaces share a single
      `ai:troubleshoot-sql` channel with a discriminated dialect field, or reuse
      / extend `ai:check-sql` with an optional error message. Both satisfy D1-D4;
      the trade-off is prompt clarity per dialect versus channel proliferation.
- [ ] **Token budget for federated context.** A federated query with several
      attachments multiplies the schema context. `MAX_OUTPUT_TOKENS` is 16000
      (US-018) but the *input* size is unbounded; planning should check whether
      the existing `ai:generate-federated-sql` path already has a practical
      ceiling to copy.

## Deferred Ideas

- **Troubleshoot for table data grid / row editing errors** — explicitly
  excluded from D1. Those failures come from app-generated SQL, not from a
  statement the user wrote, so a "corrected SQL" has nowhere to be applied.
- **Auto-run after applying a fix** — rejected in D2 for the `UPDATE`/`DELETE`
  safety reason. Revisit only behind an explicit opt-in setting.
- **Multi-turn troubleshooting** (apply a fix, it fails again, feed the new
  error back with history) — the first version is single-shot. The panel shape
  chosen in D2 does not preclude adding this later.

## Handoff Note

CONTEXT.md is the source of truth. Decision IDs are stable. Planning reads locked
decisions, code context, canonical references, and deferred-to-planning questions.
Validating and reviewing use locked decisions for coverage and UAT.
