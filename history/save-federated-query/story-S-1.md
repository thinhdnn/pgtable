# Story S-1 — Save/Open/Delete federated queries

**Feature:** save-federated-query · **Mode:** standard_feature, single inline story
**Source of truth:** `CONTEXT.md` (D1-D5) · **Approach:** `approach.md`

## Outcome

From the Federated Query tab, a user can Save the current tab (attachments + SQL
+ autoLimit) under a unique name, reopen it back into the tab, and delete it.
Saves persist across app restarts in a dedicated `electron-store` file.

## Tasks (one vertical slice, executed inline)

- **T-1 Types** — `src/shared/types.ts`: `SavedFederatedQuery`
  `{id, name, attachments: SavedFederatedAttachment[], sql, autoLimit, created_at, updated_at}`;
  `SavedFederatedAttachment` `{connectionId, database, schema}` (no alias — derived);
  `SavedFederatedQueryInput` `{name, attachments, sql, autoLimit, overwrite?}`.
- **T-2 Channels** — `src/shared/ipc-channels.ts`:
  `FEDERATED_SCRIPT_LIST/SAVE/DELETE` = `federated-script:list|save|delete`.
- **T-3 Store** — `src/main/db/federated-script-store.ts`: lazy
  `electron-store('pgtable-federated-scripts')` (D1) + pure
  `upsertFederatedQueries(items, input, now)` cloned from `upsertScripts`
  (unique name; overwrite replaces in place keeping id+created_at; else collision).
  Exports `listFederatedQueries/saveFederatedQuery/deleteFederatedQuery`.
- **T-4 Store tests** — `src/main/db/federated-script-store.test.ts`: append,
  overwrite (keeps id/created_at), collision-without-overwrite, name trim,
  delete-by-id, list round-trip.
- **T-5 Handlers** — `src/main/ipc/federated-script-handlers.ts`:
  `registerFederatedScriptHandlers()`; SAVE returns `{error:'NAME_EXISTS'}` on
  collision, else `{ok, id}`. Register in `src/main/index.ts`.
- **T-6 Renderer** — `FederatedQueryTab.tsx`: Save button + Save modal (name →
  `NAME_EXISTS` → Overwrite/Rename confirm, mirror `doSave`); Saved drawer
  (search list, Open/Delete). Open = confirm-if-dirty, then rebuild `AttachRow[]`
  (fresh `key` per row) from stored attachments, `setSql`, `setAutoLimit`; flag
  rows whose `connectionId` no longer resolves ("missing") and rows whose
  connection is not currently connected (connect prompt) per D3.

## Acceptance (maps to decisions)

- **A1 (D2):** Saving then reopening restores identical attachments (same derived
  aliases via row order), SQL, and autoLimit; the reopened tab can Run.
- **A2 (D1):** Persistence survives an app restart; data lives in a store file
  separate from `pgtable-scripts`.
- **A3 (D4):** Saving a duplicate name prompts Overwrite/Rename; Overwrite keeps
  the original id + created_at and updates updated_at.
- **A4 (D3):** Opening a save that references a deleted connection loads
  best-effort with that row flagged "missing"; a not-connected connection row
  prompts to connect; Open is never blocked.
- **A5 (D5):** Open overwrites the current tab in place and confirms first when
  the tab holds meaningful content (a configured attachment OR sql ≠ STARTER_SQL).

## Proof Bar

`npm run typecheck` · `npm run test` (incl. T-4) · `npm run build` · runtime UAT
(reviewing). No lint/eslint (not installed — [20260701] lesson).

## Notes

No bead fan-out: T-1..T-6 are tightly coupled (types→channels→store→handler→
renderer), mirroring how save-sql-script S-1 was executed inline. Feasibility is
carried by the proven sibling; validating confirms repo reality + proof-bar
commands run clean before execution.
