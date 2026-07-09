# Overview

**Story:** US-020 — Troubleshoot a failed query in the SQL editor
**Epic:** E05-ai · **Epic map story id:** S1
**Lane:** high-risk
**Feature context:** `history/troubleshoot-sql-error/CONTEXT.md` (D1-D4 locked)

## Current Behavior

When a statement run from `QueryEditor` fails, the tab renders an error `Alert`
(`QueryEditor.tsx:981-996`) containing the raw Postgres message and, for one
narrow class of failure, a locally derived hint from `deriveSqlHint()`. That hint
only fires for `column ... does not exist` caused by a reserved-word table trap.

For every other failure — a misspelled column, a wrong join, a type mismatch, a
missing table — the user is left with the raw error and no assistance. The AI is
reachable only *before* running, via `ai:check-sql`, which reviews the statement
statically and has no error message to reason about.

## Target Behavior

The error `Alert` gains a troubleshoot action. Clicking it sends the failing SQL,
the raw error message, and the selected schema's tables/columns/FK edges to the
active AI provider, then renders a diagnosis and — when the failure is a SQL
authoring problem — a corrected statement.

`Apply suggested fix` writes the corrected statement into the editor and **does
not run it**. If the corrected statement is not a read-only `SELECT`, the
existing non-`SELECT` warning is raised before the user can run it.

When the failure is not a SQL authoring problem (`Not connected`,
`ECONNREFUSED`, a pool timeout), the panel shows the diagnosis with **no Apply
button** — a direct consequence of `fixedSql` being optional, not a special case
in the UI.

This story also gives the non-`SELECT` warning classifier a shared, unit-tested
home. Today `QueryEditor.tsx:148` holds a private, untested copy named
`isReadOnlyStatement` whose regex accepts `TABLE`/`VALUES`, while
`executor.ts:92` holds a same-named but **deliberately narrower** execution guard
that rejects them per linked-query constraint C1. The two are not
interchangeable. The classifier moves to `src/shared/sql-statement.ts` as
`isNonMutatingStatement`; the execution guard stays where it is. See `design.md`.

## Affected Users

- Anyone writing ad-hoc SQL in the Query tab — the primary surface of the app.

## Affected Product Docs

- `docs/decisions/0008-anthropic-sql-generation.md` — establishes that the AI
  never executes SQL. This story upholds it.
- `docs/decisions/0010-pluggable-ai-providers.md` — the provider abstraction this
  new call goes through unchanged.
- `docs/decisions/0012-ai-troubleshoot-sql-channel.md` — **new**, written by this
  story.

## Non-Goals

- The Federated tab (S2) and the Linked Query tab (S3). This story establishes
  the contract they will reuse; it does not touch them.
- Re-running the query automatically after applying a fix. Rejected in D2.
- Multi-turn troubleshooting (apply, fail again, feed the new error back).
- Capping the schema context sent to the provider. Already unbounded on shipped
  code paths; see `history/troubleshoot-sql-error/discovery.md` Q3.
- Table data grid and row-editing errors. Excluded by D1.
