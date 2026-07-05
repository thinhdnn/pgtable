# AI SQL Generation - Context

**Feature slug:** ai-sql-generation
**Date:** 2026-07-01
**Exploring session:** complete
**Scope:** Standard
**Domain types:** SEE, CALL, ORGANIZE

## Feature Boundary

Add an assistant to the existing pgtable desktop app that turns a natural-language
request into a PostgreSQL query. The AI reads the current schema's tables, columns,
and foreign keys and uses the FK relationships to automatically join related tables.
The generated SQL is shown to the user for review; the user runs it themselves in
the existing query editor. Nothing more — this is a SQL authoring aid, not an
autonomous agent that touches the database on its own.

## Locked Decisions

These are fixed. Planning must implement them exactly.

- **D1:** The AI only *generates and displays* SQL. It never executes the query
  itself. The generated SQL lands in the existing query editor where the user
  reviews, edits, and runs it manually.

- **D2:** SQL generation uses the Claude API (Anthropic). Default to the latest
  capable Claude model; exact model id (Opus/Sonnet/Haiku) is deferred to planning
  as a cost/latency tuning choice.

- **D3:** The pgtable MVP is already fully built (Electron + React + pg, with
  connection management, DB/schema/table explorer, table viewer, and a working
  query editor with `QUERY_RUN`). This feature builds on top of it. NOTE: on
  2026-07-01 `.khuym/state.json` was stale (it still claimed "no app code exists");
  the running app code under `src/` is the ground truth.

- **D4:** The schema context sent to Claude is scoped to the **currently selected
  schema** — its tables, columns, and foreign keys only. Not the whole database,
  not other schemas. Table/column/FK names for that one schema leave the machine
  and are sent to the Anthropic API; this is the accepted privacy boundary.

- **D5:** The Claude API key is entered by the user in a new **Settings** screen
  and stored locally. Plaintext storage is acceptable for now, consistent with
  D3-era handling of connection passwords (encryption deferred, same posture as
  pgtable-mvp D3).

- **D6:** The AI may generate any statement type (SELECT, INSERT, UPDATE, DELETE,
  DDL) when the user's request calls for it. If the generated statement is **not a
  read-only SELECT**, the UI must show a clear warning before the user runs it, so
  a destructive statement is never run unknowingly.

### Agent's Discretion

- Exact Claude model id and token/context budget (D2) — planning picks, records in
  `docs/decisions/`.
- Where the natural-language input UI lives relative to the query editor (side
  panel, modal, or inline header) — the generated SQL must end up in the existing
  `QueryEditor`.
- Exact prompt/system-prompt wording sent to Claude.
- How the FK graph is serialized into the prompt (DDL-like text vs structured list).
- Settings screen layout and where the key is persisted (electron-store vs the
  existing SQLite store) — record the choice in `docs/decisions/`.
- Error-message copy for missing API key, API errors, and rate limits.
- How the non-SELECT warning is surfaced (banner, confirm dialog, badge).

## Specific Ideas And References

- FK introspection does not exist yet and is the core new capability. Model it on
  the existing pg_catalog introspection in `src/main/ipc/db-handlers.ts`
  (`SCHEMA_INTROSPECT`, `OBJECT_LIST`, `PRIMARY_KEYS`). FK relationships come from
  `pg_constraint` (contype = 'f') joined to `pg_class`/`pg_attribute`, filtered to
  the selected schema.
- `SCHEMA_INTROSPECT` (`schema:introspect`) already returns every table+columns for
  a database; the AI schema context can extend/reuse this shape, scoped to one
  schema per D4, plus FK edges.
- `QUERY_RUN` (`query:run`) already executes arbitrary SQL from the editor — the
  generated SQL flows into this existing path when the user runs it.
- Claude API integration must live in the **main process** (not the renderer) so
  the API key never sits in renderer memory and CORS/secret handling stays server-
  side. A new IPC channel (e.g. `ai:generate-sql`) bridges renderer -> main.

## Existing Code Context

pgtable is an Electron app: `src/main` (Node/pg/IPC), `src/preload`, `src/renderer`
(React + Ant Design + CodeMirror). IPC channels are centralized in
`src/shared/ipc-channels.ts`; shared types in `src/shared/types.ts`.

### Reusable Assets

- `src/main/ipc/db-handlers.ts` — pg_catalog introspection patterns (schema, columns,
  PKs, object lists), the `qid()` identifier-quoting helper, and the `QUERY_RUN` path.
- `src/main/pg/query-runner.ts` — `query`/`queryOne` helpers over a pool.
- `src/main/pg/pool-manager.ts` — `requirePool`/`getOrCreatePool` per connection+db.
- `src/renderer/src/components/query/QueryEditor.tsx` — target surface for generated SQL.
- `src/shared/ipc-channels.ts` — add the new `ai:generate-sql` channel here.
- `@anthropic-ai/sdk` — NOT yet a dependency; must be added for D2.

### Established Patterns

- IPC handler shape: `ipcMain.handle(IPC.X, async (_e, args) => { try {...} catch (err) { return { error: String(err) } } })`.
- IPC channel naming: `domain:verb` (`conn:*`, `db:*`, `schema:*`, `table:*`, `query:*`).
- Renderer calls main via the preload bridge / `src/renderer/src/api.ts`.

### Integration Points

- `src/shared/ipc-channels.ts` — new channel(s) for FK introspection and AI generate.
- `src/main/ipc/db-handlers.ts` (or a new `ai-handlers.ts` + `fk` query) — backend logic.
- `src/renderer/src/components/query/QueryEditor.tsx` — where generated SQL appears.
- A new Settings surface for the API key (D5).
- `docs/stories/epics/` and `docs/decisions/` per Harness normal-lane rules.

## Canonical References

- `history/ai-sql-generation/CONTEXT.md` — this file, source of truth.
- `history/pgtable-mvp/CONTEXT.md` + `SPEC.md` — the app this builds on (D3, D5 posture).
- `docs/FEATURE_INTAKE.md` — intake classification and lane rules.
- `docs/ARCHITECTURE.md` — layering and boundary rules (main/preload/renderer).
- `docs/templates/story.md`, `docs/templates/decision.md` — packet templates.

## Epic and Story Scope

**Proposed structure (planning confirms):**

| Epic / Story area | Name |
|---|---|
| FK introspection | Read foreign-key edges for the selected schema |
| Claude integration | Main-process Claude client + `ai:generate-sql` IPC + prompt build |
| Settings / API key | Settings screen to enter and persist the Claude API key (D5) |
| Generate UI | Natural-language input -> generated SQL into QueryEditor + non-SELECT warning (D1, D6) |

## Outstanding Questions

### Resolve Before Planning

- (none — all blocking decisions locked D1–D6)

### Deferred To Planning

- [ ] Exact Claude model id and max schema/token budget (D2).
- [ ] FK graph serialization format for the prompt.
- [ ] Where the API key is persisted (electron-store vs SQLite) — record in `docs/decisions/`.
- [ ] AI input UI placement relative to the query editor.
- [ ] Risk re-check: this feature adds an External System (Anthropic API) and a
      secret (API key). Intake lane may rise from Normal toward High-Risk; planning
      confirms lane and whether a decision record is required.

## Deferred Ideas

- Auto-run generated SQL (explicitly rejected by D1).
- Sending whole-database schema as context (rejected by D4).
- API key encryption (deferred, same posture as pgtable-mvp D3).
- Multi-turn "refine this query" conversation with the AI.
- Explaining an existing query in natural language (reverse direction).
- Result-set-aware follow-ups (feeding rows back to the AI).

## Handoff Note

CONTEXT.md is the source of truth. Decision IDs D1–D6 are stable. Planning reads
locked decisions, the existing `src/` code (D3), and the deferred-to-planning
questions, then confirms the intake lane (note the External System + secret risk
flags) before proposing stories.
