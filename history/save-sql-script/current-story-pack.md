# Current Story Pack - S-1: Save / Open / Delete SQL scripts

**Feature:** save-sql-script
**Mode:** standard (feasibility proven)
**Validated:** 2026-07-03
**Status:** READY (pending execution approval)

## Feasibility Matrix (concrete evidence)

| Assumption | Evidence | Verdict |
| --- | --- | --- |
| `electron-store` CRUD pattern reusable | `src/main/db/connection-store.ts` read — list/add/update/delete over a typed `Store`. Direct template. | PROVEN |
| Multiple stores coexist by separate file name | `settings-store.ts` uses `name: 'pgtable-settings'` vs connection-store `'pgtable'`. Script store will use `'pgtable-scripts'`. | PROVEN |
| Deps present (no install needed) | `package.json`: `electron-store ^8.2.0`, `uuid ^11.0.0`. | PROVEN |
| IPC handler + registration pattern | `connection-handlers.ts` + `index.ts` register 5 handler modules; add a 6th `registerScriptHandlers()`. | PROVEN |
| New channel needs no preload edit | `preload` exposes generic `invoke(channel: IpcChannel)`; `IpcChannel` is derived from the `IPC` map. Adding keys auto-allows. | PROVEN |
| QueryEditor can host Save/list UI | `QueryEditor.tsx` already imports antd Button/Input/Select/Tag/Space/message/Modal-capable set and holds `sqlText`/`setSqlText`. | PROVEN |
| Pure logic is unit-testable | `linked-query/executor.ts` + `executor.test.ts` = shipped pure-fn + vitest precedent for `upsertScripts`. | PROVEN |
| Proof bar runs clean on baseline | `npm run typecheck` GREEN; `npm run test` 35/35 GREEN; `npm run build` GREEN (ran 2026-07-03). | PROVEN |

No unproven assumption can invalidate the story → no spike required.

## Tasks

- **T-1** `src/shared/types.ts`: add `SavedScript` (`id, name, sql, connectionId?, created_at, updated_at`) + `SavedScriptInput`.
- **T-2** `src/shared/ipc-channels.ts`: add `SCRIPT_LIST`/`SCRIPT_SAVE`/`SCRIPT_DELETE`.
- **T-3** `src/main/db/script-store.ts` (new): `Store<{scripts:SavedScript[]}>({name:'pgtable-scripts',defaults:{scripts:[]}})`; export `listScripts`, `saveScript`, `deleteScript`, and pure `upsertScripts(scripts, input, {overwrite})` returning `{scripts}` or a name-collision signal.
- **T-4** `src/main/db/script-store.test.ts` (new): vitest over `upsertScripts` — create, unique-name collision→needs-overwrite, overwrite path, delete.
- **T-5** `src/main/ipc/script-handlers.ts` (new): `registerScriptHandlers()`; `script:list`→full records; `script:save`→`{name,sql,connectionId?,overwrite?}`, collision w/o overwrite → `{error:'NAME_EXISTS'}`; `script:delete`→`{id}`.
- **T-6** `src/main/index.ts`: import + call `registerScriptHandlers()`.
- **T-7** `src/renderer/src/components/query/QueryEditor.tsx`: toolbar **Save** button (prompt name; on `NAME_EXISTS` offer Overwrite/Rename via antd Modal) + **Scripts** drawer/list with search box, Open (setSqlText), Delete.

## Acceptance (maps to CONTEXT D-IDs)

1. Save current editor SQL under a unique name → appears in the Scripts list. (D1)
2. Save a colliding name → Overwrite-or-Rename prompt. (D3)
3. Open a saved script → its SQL loads into the editor. (D6)
4. Delete a saved script → it leaves the list. (D6)
5. Scripts persist across restart and show under every connection. (D2)
6. Flat searchable list. (D4); QueryEditor only. (D5)
7. Proof bar GREEN.

## Proof Bar

- `npm run typecheck` — GREEN
- `npm run test` — GREEN incl. new `script-store.test.ts`
- `npm run build` — GREEN

(No `lint`: eslint script exists but binary not installed — critical pattern [20260701].)
