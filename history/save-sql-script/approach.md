# Save SQL Script - Approach

**Feature slug:** save-sql-script
**Date:** 2026-07-03
**Mode:** standard (feasibility already proven — direct mirror of connection CRUD)
**Lane (intake):** normal — data model + public-contract flags, no hard gate.

## Path (smallest believable slice)

One vertical slice from `electron-store` → IPC → QueryEditor UI, mirroring the
existing connection feature end-to-end. No new libraries, no filesystem, no
preload allowlist changes (preload exposes a generic `invoke(channel, payload)`
over the `IpcChannel` union — a new channel is allowed the moment it is added to
the `IPC` map).

### Files touched

| File | Change |
| --- | --- |
| `src/shared/types.ts` | Add `SavedScript` + `SavedScriptInput` types (id, name, sql, optional connectionId tag, created_at/updated_at). |
| `src/shared/ipc-channels.ts` | Add `SCRIPT_LIST: 'script:list'`, `SCRIPT_SAVE: 'script:save'`, `SCRIPT_DELETE: 'script:delete'`. |
| `src/main/db/script-store.ts` (new) | `electron-store`-backed CRUD, mirroring `connection-store.ts`. `listScripts / saveScript / deleteScript`. Save enforces unique name (D3): overwrite when caller confirms, else create. Pure `upsertScripts(scripts, input, mode)` helper extracted for unit test. |
| `src/main/ipc/script-handlers.ts` (new) | `registerScriptHandlers()` mirroring `connection-handlers.ts`. `script:list` returns full records (incl. sql → Open is renderer-only, D6). `script:save` takes `{name, sql, connectionId?, overwrite?}`; on name collision without `overwrite` returns `{ error: 'NAME_EXISTS' }` so the renderer can prompt (D3). `script:delete` takes `{ id }`. |
| `src/main/index.ts` | Import + call `registerScriptHandlers()` alongside the other five. |
| `src/renderer/src/components/query/QueryEditor.tsx` | Toolbar **Save** button + a **Scripts** button opening an antd list/drawer with a search box (D4). Save prompts for a name; on `NAME_EXISTS` shows overwrite/rename choice (D3). Open sets `sqlText`. Delete from the list. All antd primitives already imported in this file. |

## Data model (D2/D3 realised)

```
SavedScript = {
  id: string            // uuid
  name: string          // required, unique (D3)
  sql: string
  connectionId?: string // optional non-filtering tag (D2)
  created_at: string
  updated_at: string
}
```
Stored in its **own** `electron-store` file `name: 'pgtable-scripts'` (validating
evidence: `settings-store.ts` uses `name: 'pgtable-settings'`, a separate file
from connection-store's `'pgtable'` — separate-file-per-store is the established
coexistence pattern, not shared keys). Global list, no per-connection filtering (D2).

**Resolved open questions (validating):**
- Q1 → connection tag stores `connectionId` (stable id), not a human label.
  Labels change; `connectionId` is how connections are keyed everywhere else and
  the renderer can resolve id→name for display. Within CONTEXT Agent's Discretion.
- Q2 → `script:list` returns full records incl. `sql`, so Open is renderer-only
  and no `script:get` channel is needed (D6). Acceptable for a local dev tool's
  script volume.

## Risks and how each is retired

| Risk | Severity | Retirement |
| --- | --- | --- |
| Name-uniqueness / overwrite-vs-create logic wrong (D3) | med | Pure `upsertScripts` helper with vitest unit tests (mirrors `linked-query/executor.ts` pure-function + `executor.test.ts` pattern). |
| Open clobbers unsaved editor text | low | Renderer UX detail — confirm-on-dirty or replace; decided in prep, within QueryEditor only. |
| Store-file shape collision with connections/settings | low | Separate typed `Store<{ scripts }>` instance, distinct key — same coexistence pattern connection-store/settings-store already use. |
| IPC contract drift | low | Additive channels only; no existing channel changes; typed via `IpcChannel` union. |

No spike required — every step is a line-for-line mirror of shipped code
(`connection-store` + `connection-handlers` + antd UI in this same file).

## Proof bar (only commands the repo can actually run)

- `npm run typecheck` — GREEN
- `npm run test` (vitest) — GREEN, including new `script-store` upsert tests
- `npm run build` — GREEN

(No `lint` in the bar — eslint is not installed; per critical pattern
[20260701] "Proof Bar Must Match Actually-Installed Tooling".)

## Questions for validating

- Confirm the store record shape above satisfies D2's "optional connection tag"
  (connectionId vs human label). Approach assumes `connectionId`.
- Confirm `script:list` returning full `sql` (so Open needs no `script:get`) is
  acceptable for expected script volume. Approach assumes yes (D6).

## Work shape

Single story, no epic map, no forced phases — one bounded capability with no
separable risk areas.

- **S-1: Save / Open / Delete SQL scripts in QueryEditor**
  End-to-end: store + IPC + QueryEditor UI. Acceptance:
  1. User saves current editor SQL under a unique name; it appears in the list.
  2. Saving a colliding name prompts Overwrite or Rename (D3).
  3. User opens a saved script → its SQL loads into the editor (D6).
  4. User deletes a saved script → it leaves the list (D6).
  5. Scripts persist across app restart and are visible under every connection (D2).
  6. Proof bar GREEN.
