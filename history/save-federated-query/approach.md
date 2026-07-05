# Save Federated Query - Approach

**Feature slug:** save-federated-query
**Date:** 2026-07-05
**Mode:** standard_feature — single vertical story (no epic map, no spike)
**Source of truth:** `history/save-federated-query/CONTEXT.md` (D1-D5)

## Mode Gate

- **Not high-risk / not epic-worthy:** no cross-cutting change, no hard intake
  gate (no auth/authorization/migration/audit/external-provider). Lane = normal.
- **Not a spike:** the entire mechanism is a proven clone of the already-shipped
  `save-sql-script` (store + IPC + renderer Save/drawer, proof bar GREEN). The
  only novel part is a structured payload instead of plain SQL — a data-shape
  change, not a feasibility unknown.
- **Not small_change:** touches ~7 files (>3), so it runs the full
  planning→validating gate, but as **one** vertical story. No bead fan-out —
  the files are tightly coupled (types→IPC→store→handler→renderer), mirroring
  how `save-sql-script` S-1 was executed inline.

## Repo Reality (discovery)

Direct precedent files, all confirmed to exist and follow one pattern:

- **Store:** `src/main/db/script-store.ts` — lazy `electron-store('pgtable-scripts')`,
  pure `upsertScripts(scripts, input, now)` returning `{ok, scripts, script}` or
  `{ok:false, collision:true}`; `listScripts/saveScript/deleteScript`. Unit-tested
  in `script-store.test.ts` (6 tests) without electron via the pure function.
- **Handlers:** `src/main/ipc/script-handlers.ts` — `registerScriptHandlers()`;
  `SCRIPT_SAVE` returns `{error:'NAME_EXISTS'}` on collision, else `{ok,id}`.
- **Registration:** `src/main/index.ts:74` calls `registerScriptHandlers()`
  alongside the other `register*Handlers()`.
- **Channels:** `src/shared/ipc-channels.ts:112-114` — `SCRIPT_LIST/SAVE/DELETE`.
- **Types:** `src/shared/types.ts:412-430` — `SavedScript` + `SavedScriptInput`
  (`overwrite?` flag drives Overwrite/Rename).
- **Renderer UX:** `src/renderer/src/components/query/QueryEditor.tsx` — Save
  button → Save modal; `doSave(overwrite)` re-invokes with the flag on
  `Modal.confirm` after `NAME_EXISTS`; a Drawer with search + Open/Delete list.
- **Federated target:** `src/renderer/src/components/federated/FederatedQueryTab.tsx`
  owns `rows` (attachments), `sql`, `autoLimit` in local `useState` — Save
  serializes these, Open hydrates them via `setRows/setSql/setAutoLimit`. Because
  the Save/Open UI lives inside the tab and the tab owns its state, **D5 "overwrite
  current tab" needs no change to the `FederatedTab` model** — Open is a local
  state swap with a confirm. `deriveAlias()` (`src/shared/federated.ts`) confirms
  aliases are derived, so only ordered attachments are stored (D2).

## Chosen Path (smallest believable slice)

Clone the save-sql-script vertical, swapping the payload:

1. **Types** (`src/shared/types.ts`): `SavedFederatedQuery` (id, name,
   `attachments: FederatedAttachmentSaved[]`, sql, autoLimit, created_at,
   updated_at) and `SavedFederatedQueryInput` (name, attachments, sql, autoLimit,
   overwrite?). `FederatedAttachmentSaved` = `{connectionId, database, schema}`
   (no alias — derived). Reuse existing `FederatedAttachment` shape minus alias.
2. **Channels** (`src/shared/ipc-channels.ts`): `FEDERATED_SCRIPT_LIST/SAVE/DELETE`
   = `federated-script:list|save|delete`.
3. **Store** (`src/main/db/federated-script-store.ts`): lazy
   `electron-store('pgtable-federated-scripts')` (D1 separate store) + pure
   `upsertFederatedQueries(...)` cloned from `upsertScripts` (unique name,
   overwrite → replace in place keeping id/created_at). `list/save/delete`.
4. **Store tests** (`src/main/db/federated-script-store.test.ts`): mirror the 6
   upsert cases (append / overwrite / collision-no-overwrite / trim / etc.).
5. **Handlers** (`src/main/ipc/federated-script-handlers.ts`): clone
   script-handlers; `NAME_EXISTS` on collision. Register in `index.ts`.
6. **Renderer** (`FederatedQueryTab.tsx`): Save button + Save modal
   (name → `NAME_EXISTS` → Overwrite/Rename confirm, mirror `doSave`); a Saved
   drawer (search list, Open/Delete). Open = confirm-if-dirty then
   `setRows(payload.attachments mapped to AttachRow)`, `setSql`, `setAutoLimit`;
   flag rows whose `connectionId` no longer resolves as "missing", and rows whose
   connection is not currently connected with a connect prompt (D3).

## Risks & Proof Needs

- **R1 (low):** Open must rebuild `AttachRow[]` (which carry a local `key`) from
  stored attachments — regenerate fresh keys. Proof: unit-testable mapping +
  runtime UAT.
- **R2 (low):** "meaningful content" threshold for the D5 confirm — define as
  "any configured attachment OR sql differs from STARTER_SQL". Proof: UAT.
- **R3 (low):** missing/not-connected row rendering must not crash Run gating —
  Run already requires `connectionId && database && alias && schema`
  (`FederatedQueryTab.tsx:102-113`), so a missing row simply stays non-runnable.
  Proof: UAT with a deleted connection.

No spike required — every risk is low and covered by the sibling precedent + UAT.

## Proof Bar (must match installed tooling — critical pattern [20260701])

- `npm run typecheck`
- `npm run test` (add federated-store tests; keep suite green)
- `npm run build`
- Runtime UAT (reviewing): Save a federated query → restart app → Open it →
  attachments+SQL+autoLimit restored → Run works; delete a referenced connection
  → Open flags the missing row; Delete removes it from the drawer.

(NOTE: `npm run lint`/eslint is NOT installed — excluded from the bar per the
[20260701] proof-bar lesson.)

## Validating Questions (for khuym:validating)

- Confirm `electron-store` allows a second named store file at runtime alongside
  `pgtable`, `pgtable-settings`, `pgtable-scripts` (expected yes — precedent).
- Confirm the exact 3-4 proof-bar commands run clean on the current tree before
  locking them.
- Confirm the `AttachRow` hydration mapping (stored attachment → row with fresh
  `key`, `connectionId` possibly unresolved) type-checks against the current
  `AttachRow` interface.

## Work Shape

**Single story S-1: "Save/Open/Delete federated queries"** — one vertical slice
(types → channels → store → store tests → handlers → registration → renderer UI),
executed inline (no bead fan-out; tightly coupled, mirrors save-sql-script S-1).
