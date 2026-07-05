# Linked Query — Discovery

**Feature slug:** linked-query
**Phase:** planning
**Date:** 2026-07-01

Only the facts needed for the plan. Full behavioural contract lives in
`CONTEXT.md`.

## Architecture Snapshot

- **Runtime:** Electron 33.2, React 18, TypeScript 5.7, electron-vite 5.0.
- **Layering:** `src/main` (Node + `pg` + IPC) → `src/preload` (context bridge)
  → `src/renderer` (React UI). All `pg` calls in main only (decision 0007).
- **Multi-DB pools:** `src/main/pg/pool-manager.ts` keys pools by
  `connectionId::database`; `getOrCreatePool(conn, db)` returns the right pool
  regardless of whether Step 1 and Step 2 share a connection. No pool changes
  needed.
- **IPC contract:** channels centralised in `src/shared/ipc-channels.ts`,
  handler registration in `src/main/index.ts`, renderer bridge in
  `src/renderer/src/api.ts` (`invoke(IPC.X, payload)`).
- **UI shell:** `src/renderer/src/App.tsx` renders `<TitleBar>` + sidebar +
  `<Tabs>` (AntD editable-card). Tab kind discriminated via
  `TabId.kind` in `src/shared/types.ts`; `tabKey()` builds a stable id.
- **Persistence:** `electron-store` for settings/connections. **No SQLite,
  despite decision 0004** — the `.beads/` scripts assume SQLite but they are
  not installed either. Linked Query stores nothing (v0), so this doesn't
  matter.

## Constraints

- **No new native dependency** (rules out DuckDB, better-sqlite3). Locked in
  CONTEXT.md and reinforced by decision 0007.
- **No persistence** (v0). All state is per-tab in renderer memory.
- **SELECT/WITH whitelist** for both Step SQL bodies. Reject DML/DDL up front.
- **Parameterised IN-list**: never string-interpolate user values.
- **Hard limits:** 5000 keys from Step 1, default LIMIT 1000 on Step 2 (uses
  the same `applyAutoLimit` pattern already in `QueryEditor.tsx`).
- **Product doc:** create `docs/product/linked-query.md`. Do not modify
  `docs/product/overview.md` Phase 1 scope.

## Reusable Assets (verified)

| Asset | Location | Reuse |
| --- | --- | --- |
| `getOrCreatePool(conn, db)` | `src/main/pg/pool-manager.ts` | Both Step 1 and Step 2 |
| `query(pool, sql, params)` | `src/main/pg/query-runner.ts` | Runs parameterised SQL as-is |
| `stripCommentsAndStrings`, `isReadOnlyStatement`, `applyAutoLimit` | `src/renderer/src/components/query/QueryEditor.tsx` | Copy to main-process executor for whitelist + auto-LIMIT |
| `ResultGrid` (internal to QueryEditor) | `src/renderer/src/components/query/QueryEditor.tsx` | Render Step 2 rows |
| `openTab` / `tabKey` | `src/renderer/src/store/active-connection.tsx` + `src/shared/types.ts` | Extend for `kind: 'linked-query'` |
| IPC pattern | `src/main/ipc/ai-handlers.ts` | Model shape for `linked:*` handlers |
| Settings-style button | `src/renderer/src/components/TitleBar.tsx` | Same button pattern for Linked Query entry |
| CONNECTION_LIST + DB_LIST + SCHEMA_INTROSPECT | existing IPC | Populate Step source pickers |

## Established Patterns (must follow)

- IPC handler shape: `ipcMain.handle(IPC.X, async (_e, p) => { try {...} catch (err) { return { error: String(err) } } })`.
- IPC channel naming: `domain:verb`. New: `linked:step-run`, `linked:final-run`.
- Handler registration: new `registerLinkedQueryHandlers()` called from
  `src/main/index.ts` next to `registerAiHandlers()`.
- Pure functions in main go under a domain folder: `src/main/linked-query/`.
- Renderer talks to main via `invoke(IPC.X, payload)` from `api.ts`; never
  imports `pg` directly.
- `IpcResult<T>` envelope: `{ ok: true, ...data }` or `{ error: string }`.
- Cite decision IDs (D1–D5 from CONTEXT.md) in code comments (promoted
  critical pattern from ai-sql-generation compounding).

## Missing Or New

- `src/main/linked-query/` folder (new).
- Placeholder rewriter + statement whitelist as **pure functions**, main-side
  (no equivalent exists — QueryEditor's copies live in renderer).
- Tab kind `'linked-query'` not present in `TabId` union.
- No sidebar entry for Linked Query — TitleBar-only entry point (D5).
- No test runner installed (see `docs/HARNESS_AUDIT.md` if applicable).
  Package.json declares `npm run lint` but eslint is absent (F2 finding from
  ai-sql-generation review). Introducing `vitest` for the pure functions is
  a scoped, one-time cost.

## Learnings Applied

From `history/learnings/critical-patterns.md`:

1. **Provider SDK in Electron main via `externalizeDepsPlugin`** — structural
   analogue: cross-DB executor sits in main. No SDK involved but the "narrow
   IPC channel, no renderer-side data access" rule applies directly.
2. **Never Return Raw Secrets Over IPC** — n/a here, no secrets involved.
3. **Proof Bar Must Match Actually-Installed Tooling** — the validating gate
   for this feature must NOT promise `npm run lint`. If we add vitest, we
   must actually install it and prove `npm run test` runs green before the
   proof bar mentions it.

From `history/learnings/20260701-ai-sql-generation.md`:

- Reuse `externalizeDepsPlugin()` posture — do not touch
  `electron.vite.config.ts`.
- Handler pattern of `registerAiHandlers()` is the template.

## Harness Snapshot

- `scripts/bin/harness-cli query matrix` shows US-001 through US-012 (the
  MVP + AI SQL feature) as `in_progress`/`planned`. Linked Query is a **new
  story area** — planning proposes adding stories under a new epic
  `E04-linked-query`, or as an extension. Intake lane is Normal (see
  Assessment).

## Summary

- **Exists:** every backend pattern this feature needs (pools, query runner,
  IPC shape, auto-LIMIT, statement classifier, tab store, TitleBar button
  pattern, ResultGrid).
- **Missing:** placeholder rewriter (pure), main-side whitelist, tab kind,
  entry button, product doc. All small, all isolated.
- **Warning:** no test runner in repo. If planning wants to prove the
  rewriter/whitelist via unit tests it must land vitest in the same feature
  or downgrade the proof bar.
