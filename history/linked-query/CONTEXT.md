# Linked Query - Context

**Feature slug:** linked-query
**Date:** 2026-07-01
**Exploring session:** complete
**Scope:** Standard
**Domain types:** SEE, CALL, ORGANIZE

## Feature Boundary

Add a "Linked Query" surface to pgtable: a new top-level tab that runs a chained
2-step Postgres query pipeline. Step 1 executes against a chosen
(connection, database); its result rows expose their columns as selectable keys;
the user picks one key column and writes Step 2 against a chosen (connection,
database) — possibly *different* from Step 1. At Step 2 runtime, the key values
collected from Step 1 are pushed down into `WHERE <col> IN ($1, $2, ...)` using
parameterised placeholders. The final grid shows only Step 2's rows. No cross-DB
JOIN engine, no new native dependency, no persistence.

This is the smallest useful shape of what the user calls a "virtual table" — a
virtual table that lets a user look up rows in database B keyed by a set of ids
that only live in database A.

## Locked Decisions

These are fixed. Planning must implement them exactly.

- **D1:** The user selects Step 1's key column from a **dropdown that populates
  AFTER Step 1 has been executed**. The Linked Query flow is therefore
  iterative: (1) config Step 1 (source + SQL), (2) Run Step 1 → preview rows,
  (3) key-column dropdown becomes enabled, user picks the key + writes Step 2
  SQL, (4) Run Step 2 (which reuses the cached Step 1 result set — no re-run of
  Step 1 unless the user changes Step 1 SQL). Step 2 is not runnable until D1
  has been satisfied.

- **D2:** Single-column key only for v0. Placeholder syntax in Step 2 SQL:
  `:step1.<colName>`. At runtime this is rewritten to
  `IN ($1, $2, ..., $n)` with parameterised values — no string concatenation.
  Composite keys are explicitly deferred to v1; a future release may add a new
  syntax alongside `:step1.<col>` without breaking existing v0 definitions.

- **D3:** The final grid renders exactly the rows returned by Step 2 SQL.
  No client-side merge/join with Step 1 columns. The user reuses the existing
  `DataGrid` component; no new grid is written. If a user wants Step 1
  columns visible alongside Step 2, they select them explicitly in Step 2 SQL
  from a table in Step 2's database, or use a normal same-DB query editor.

- **D4:** When Step 1 returns 0 rows, Step 2 is **not executed against the
  database**. The runtime detects the empty keyset, skips the pg call, and shows
  the empty grid with the message `"0 rows — Step 1 returned no keys"`. This
  avoids the Postgres `IN ()` syntax error and saves a round-trip.

- **D5:** The Linked Query tab is opened from a **new button on the TitleBar**,
  placed next to the existing Settings gear. The tab has NO sidebar entry
  (no persistence, nothing to list). Each Step inside the tab has its own
  (connection, database) selector — the tab itself is not tied to any single
  connection or database.

- **D6 (2026-07-02):** The two-step pipeline generalises to an **N-step linear
  chain**. Step K runs once every earlier step has a result; a step may
  reference any earlier step via the unchanged `:stepN.<col>` syntax (multiple
  steps/columns per statement). The key-column dropdown is removed in favour of
  free-form placeholders over each earlier step's full result set; IPC collapses
  to a single `LINKED_STEP_RUN` channel (`stepIndex` + `upstream`), and
  `LINKED_FINAL_RUN` is removed. Add/remove act on the tail so `:stepN`
  numbering stays stable. Supersedes the D1–D5 two-step shape. See
  `docs/decisions/0009-linked-query-n-step-chain.md`.

### Agent's Discretion (planning may choose these)

- Placement details of the new TitleBar button (exact icon, order relative to
  Settings, tooltip copy).
- Where the linked-query executor module lives in `src/main/` — a new folder
  `src/main/linked-query/` vs. adding to `src/main/pg/`. Record the choice.
- Exact shape of the Linked Query tab UI: single-column vertical stack of two
  Step cards vs. a resizable split. Constrained by D1 flow (Step 2 blocked
  until Step 1 has been run).
- Whether Step 1's cached result set lives in renderer state, main-process
  memory, or both.
- Message copy for reject cases: DML/DDL Step SQL, keyset > 5000, unknown
  `:stepN.col` placeholder, `:step1.<col>` referencing a column not present in
  Step 1's result set.
- Whether the Step 2 result grid supports the same "Copy Cell / Row" actions
  that `QueryEditor.tsx`'s `ResultGrid` already does — recommended yes for UX
  consistency but planning can defer.

## Specific Ideas And References

- Executor lives in the **main process only** (consistent with decision 0007;
  reinforced by the just-promoted critical pattern "Provider SDK in Electron
  main via `externalizeDepsPlugin`"). Renderer only calls a single new IPC
  channel and never touches `pg` directly.
- Placeholder rewriter is a **pure function**: `(sql: string, keyValues: unknown[])
  -> { sql, params }`. It finds `:step1.<col>` tokens, replaces them with
  `IN ($1, $2, ..., $n)`, and returns the params in matching order. Uses
  parameterised placeholders — never string interpolation of user values.
  This is the SQL-injection defense.
- Statement whitelist reuses the sanitiser pattern from
  `src/renderer/src/components/query/QueryEditor.tsx`
  (`stripCommentsAndStrings` + `isReadOnlyStatement`). Move a copy into the
  main-process executor so both Step SQLs are validated to start with SELECT
  or WITH before any pg call.
- Empty keyset guard (D4) runs BEFORE the rewriter so `:step1.<col>` is never
  substituted with an empty list.
- Hard limits (from the accepted `/goal` prompt):
  - Step 1 keys used to build Step 2 IN-list: **≤ 5000**. If Step 1 returned
    more, reject with `"Step 1 returned N rows — narrow it below 5000 keys"`.
  - Step 2 result rows: **default LIMIT 1000** appended by the executor if the
    user didn't add one, following the `applyAutoLimit` pattern already in
    `QueryEditor.tsx`.

## Existing Code Context

pgtable is an Electron app: `src/main` (Node/pg/IPC), `src/preload`,
`src/renderer` (React + Ant Design + CodeMirror). IPC channels are centralised
in `src/shared/ipc-channels.ts`; shared types in `src/shared/types.ts`.

### Reusable Assets

- `src/main/pg/pool-manager.ts` — `getOrCreatePool(conn, database)` and
  `isConnected(id)`; already supports multi-database pools keyed by
  `connectionId::database`. Directly usable for both steps regardless of
  whether they share a connection.
- `src/main/pg/query-runner.ts` — `query(pool, sql, params)` accepts
  parameterised SQL; the linked-query executor uses this unchanged.
- `src/main/ipc/db-handlers.ts` — established IPC handler shape and `qid()`
  identifier-quoting helper (borrowable for validating `:step1.<col>` refers
  to a real Step 1 column).
- `src/renderer/src/store/active-connection.tsx` — the tab store with
  `openTab`, `openQueryTab`, `closeTab`, `tabs`, `activeTabKey`. Extend with
  `openLinkedQueryTab()` sibling.
- `src/shared/types.ts` — `TabId` discriminated union (`kind: 'table' | 'query'`).
  Add a new variant `kind: 'linked-query'` and update `tabKey()` to handle it.
- `src/renderer/src/components/TitleBar.tsx` — existing button pattern for
  Settings (`<Tooltip>` + `<Button type="text" size="small" icon={...} />`);
  the Linked Query button copies this shape exactly.
- `src/renderer/src/components/query/QueryEditor.tsx` — source for
  `stripCommentsAndStrings`, `isReadOnlyStatement`, `applyAutoLimit`, and the
  read-only `ResultGrid` used to render arbitrary query rows. All four are
  candidate reuse targets; the sanitiser + read-only detector should also
  live in the main-process executor.

### Established Patterns

- IPC handler shape:
  `ipcMain.handle(IPC.X, async (_e, args) => { try {...} catch (err) { return { error: String(err) } } })`.
- IPC channel naming: `domain:verb` (`conn:*`, `db:*`, `schema:*`, `table:*`,
  `query:*`, `ai:*`, `settings:*`). The new channels follow this: `linked:*`.
- Renderer → main via `invoke(IPC.X, payload)` from `src/renderer/src/api.ts`.
- Discriminated-union tabs discriminated by `kind`; `tabKey(t)` builds a stable
  identity string. Each new tab kind adds its case to `tabKey`.
- CONTEXT.md decision IDs cited in code comments (promoted critical pattern
  from the ai-sql-generation compounding run).

### Integration Points

- `src/shared/ipc-channels.ts` — add `LINKED_STEP_RUN` (`linked:step-run`) for
  Step 1 preview, and `LINKED_FINAL_RUN` (`linked:final-run`) for the Step 2
  execution that also carries the Step 1 result reference. Planning may collapse
  these into one channel with a discriminator if simpler.
- `src/shared/types.ts` — add `LinkedQueryTab`, `LinkedQueryStep`,
  `LinkedQueryDefinition`, `LinkedStepRunPayload/Result`,
  `LinkedFinalRunPayload/Result`. Update `TabId` and `tabKey()`.
- New file `src/main/linked-query/executor.ts` (or under `src/main/pg/`) — the
  placeholder rewriter + SELECT/WITH whitelist + IN-list bounds check.
- New file `src/main/ipc/linked-query-handlers.ts` — thin IPC layer over the
  executor, plus `registerLinkedQueryHandlers()` called from
  `src/main/index.ts` next to `registerAiHandlers()`.
- New folder `src/renderer/src/components/linked-query/` containing
  `LinkedQueryTab.tsx` and any small sub-components (step card, source
  picker, key dropdown). Reuse `ResultGrid` from QueryEditor for the final
  Step 2 grid.
- `src/renderer/src/components/TitleBar.tsx` — add the "Linked Query" button
  next to Settings.
- `src/renderer/src/store/active-connection.tsx` — add `openLinkedQueryTab()`
  and extend `TabId` handling.
- `src/renderer/src/App.tsx` — extend the tab-content switch to render
  `LinkedQueryTab` when `active.kind === 'linked-query'`.
- New file `docs/product/linked-query.md` — product doc for the new surface.
- **Do not modify** `docs/product/overview.md` Phase 1 scope — this feature is
  explicitly post-MVP, but does not change what MVP shipped.
- **Do not add** any native npm dep. No DuckDB, no better-sqlite3.

## Canonical References

- `history/linked-query/CONTEXT.md` — this file, source of truth.
- `history/ai-sql-generation/CONTEXT.md` — most recently shipped feature;
  its main-process/IPC/settings patterns are the reference model.
- `history/pgtable-mvp/CONTEXT.md` + `SPEC.md` — the app this builds on.
- `history/learnings/critical-patterns.md` — three promoted patterns are all
  directly applicable here: provider-SDK-in-main (structural analogue for
  cross-DB executor placement), never-return-raw-secrets (n/a here — no
  secrets), proof-bar-matches-tooling (validation must not promise
  `npm run lint`).
- `docs/FEATURE_INTAKE.md` — intake classification and lane rules.
- `docs/ARCHITECTURE.md` — layering (main/preload/renderer) and parse-first
  boundary rule for the placeholder rewriter.
- `docs/decisions/0007-pg-main-process-only.md` — reason all pg happens in
  main, applies unchanged.
- `docs/templates/story.md`, `docs/templates/decision.md` — packet templates.

## Epic and Story Scope

**Proposed structure (planning confirms):**

| Epic / Story area | Name |
|---|---|
| Types + IPC contract | Add `LinkedQueryTab`, step/definition types, new `linked:*` IPC channel(s), update `tabKey` |
| Main executor | Placeholder rewriter + SELECT/WITH whitelist + IN-list bounds + auto-LIMIT for Step 2 (pure functions, unit-testable) |
| Handlers | `registerLinkedQueryHandlers()` wired in `src/main/index.ts`; talks to pool-manager via `getOrCreatePool` |
| UI tab | `LinkedQueryTab.tsx` with two step cards, source pickers, run buttons, key dropdown; reuses `ResultGrid` |
| Entry point | TitleBar button, `openLinkedQueryTab()` in the tab store, `App.tsx` tab switch |
| Product doc | `docs/product/linked-query.md` |

## Outstanding Questions

### Resolve Before Planning

- (none — all blocking product decisions locked D1–D5)

### Deferred To Planning

- [ ] Whether to use one IPC channel with a discriminator or two channels
      (`linked:step-run` + `linked:final-run`).
- [ ] Where to cache the Step 1 result set between clicks (renderer state,
      main-process memory, or both).
- [ ] Whether Step 2's `ResultGrid` should support Copy Cell / Copy Row like
      the existing `QueryEditor` grid does.
- [ ] Whether to introduce a test runner (F1 in the ai-sql-generation review
      recommended vitest for exactly the kind of pure functions this feature
      adds — the placeholder rewriter and the SELECT/WITH whitelist). Planning
      should decide since it also affects `docs/TEST_MATRIX.md`.
- [ ] Whether validation needs a live spike (probably no — every dep and
      every DB call pattern this feature uses is already proven in the repo).

## Deferred Ideas (post-v0)

- Persistence: save named Linked Queries, list them in a sidebar entry, open
  by double-click. Adds CRUD + storage; wait until user demand is shown.
- N-step chains (Step 1 → Step 2 → Step 3 → …).
- Composite key support.
- Client-side merge/join of Step 1 + Step 2 columns into one grid (D3
  reversal).
- Cross-DB analytical joins requiring DuckDB or similar embedded engine.
- DML/DDL in Step SQL (currently rejected by the whitelist).
- Reading Step 2's result rows back as key set for a hypothetical Step 3
  (implicit in "N-step" above).

## Handoff Note

CONTEXT.md is the source of truth. Decision IDs **D1–D5** are stable and must
be honoured verbatim by planning and implementation. Planning reads the locked
decisions, the existing `src/` code cited above, the promoted critical
patterns, and the deferred-to-planning questions; then proposes stories and
the intake lane (this feature adds no external system and no secret — likely
plain Standard lane, no decision record required beyond CONTEXT.md itself).
