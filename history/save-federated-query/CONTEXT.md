# Save Federated Query - Context

**Feature slug:** save-federated-query
**Date:** 2026-07-05
**Exploring session:** complete
**Scope:** Standard
**Domain types:** SEE, ORGANIZE

## Feature Boundary

Add an in-app library of named **federated queries** to the Federated Query tab:
the user can Save the current tab (its attachments + SQL + autoLimit) under a
unique name, Open a saved federated query back into a tab, and Delete one.
Storage is local via `electron-store`, in a store **separate** from the
saved-script store (`pgtable-scripts`). The feature is the follow-on explicitly
deferred by `history/save-sql-script/CONTEXT.md` ("Save/Open in
FederatedQueryTab … need separate design"). It ends at the Federated Query tab
surface — it does not touch the ad-hoc QueryEditor, the Linked Query tab, the
filesystem, or `.sql` import/export.

## Locked Decisions

These are fixed. Planning must implement them exactly.

- **D1:** Federated saves live in their **own `electron-store` file**, separate
  from `pgtable-scripts`. Rationale: the payload shape is structured
  (multi-attachment), fundamentally different from a saved script's plain SQL +
  single connection tag; mixing the two stores would blur two record types.
  Follows the established one-store-per-concern pattern
  (`connection-store.ts`, `settings-store.ts`, `script-store.ts`).
- **D2:** A saved federated query persists the **full runnable payload**: the
  ordered list of attachments (each: `connectionId`, `database`, `schema`), the
  SQL text, and the `autoLimit` flag. Opening it reconstructs the tab so it can
  run immediately. The DuckDB **alias is NOT stored** — it is derived from the
  connection name in row order via `deriveAlias()`
  (`src/shared/federated.ts`), so persisting the ordered attachments is enough
  to regenerate identical aliases.
- **D3:** Open is **best-effort load**, never blocking. Restore the SQL,
  autoLimit, and every attachment whose `connectionId` still resolves. For a row
  whose connection was **deleted**, keep the row and show a "missing" warning.
  For a row whose connection **exists but is not connected**, keep the row and
  prompt the user to connect (mirrors the tab's existing connected-only gate at
  `FederatedQueryTab.tsx:82-85`). The Run button stays disabled until the
  attachments resolve to runnable state, as it already does today.
- **D4:** Name is **required and unique** within the federated store. On Save, a
  name collision prompts **Overwrite** or **Rename** — identical discipline to
  saved-script D3. Reuse the pure name-unique upsert logic pattern from
  `src/main/db/script-store.ts` (`upsertScripts`) adapted to the federated
  record shape; there is no separate Update/Rename op (overwrite covers it).
- **D5:** Open **overwrites the current Federated tab's** attachments + SQL +
  autoLimit in place. If the current tab holds meaningful content (non-starter
  SQL or configured attachments), **confirm before overwriting**. Open does not
  spawn a new tab.

### Operation Set

Minimal: **Save / Open / Delete**, mirroring saved-script's minimal set. No
rename op, no folders, no tags-for-organization (parallels save-sql-script D4/D6).

### Agent's Discretion

- Exact `electron-store` name and record schema (id, name, attachments[], sql,
  autoLimit, createdAt/updatedAt) — planning decides, must support D2-D4.
- IPC channel names may follow repo convention (`<domain>:<verb>`, e.g.
  `federated-script:list/save/delete`); exact constants in
  `src/shared/ipc-channels.ts` are planning's call.
- Physical placement of the Save button and the Saved-list drawer within
  FederatedQueryTab's layout, and the exact "meaningful content" threshold that
  triggers the D5 confirm — planning UX detail, do not expand scope.
- Whether `<verb>:list` returns full payloads (making Open renderer-only) or
  metadata + a `get` channel — decide by payload size; D2/D5 lean full payload.

## Existing Code Context

From the quick scout. Downstream agents read these before planning.

### Reusable Assets

- `src/main/db/script-store.ts` - lazy `electron-store` + pure `upsertScripts`
  (unique-name/overwrite). Direct template for the federated store.
- `src/main/ipc/script-handlers.ts` - handler module returning `NAME_EXISTS` on
  collision; mirror for federated handlers.
- `src/renderer/src/components/query/QueryEditor.tsx` - Save button + Save modal
  (overwrite/rename) + Scripts drawer (search list, Open/Delete). UX template
  for the federated Save/Load surface.
- `src/shared/federated.ts` - `deriveAlias()` + `FEDERATED_ROW_LIMIT`; confirms
  aliases are derived (D2 rationale).

### Established Patterns

- One narrow IPC channel per verb, `<domain>:<verb>` — see
  `src/shared/ipc-channels.ts` (`CONN_*`, `SETTINGS_*`, `AI_*`, `SCRIPT_*`).
- Main-process store in `src/main/db/` + `ipc/<domain>-handlers.ts` registered
  from `src/main/index.ts`; renderer never touches persistence directly.
- Critical pattern [20260701] "Provider SDK / IPC in Electron Main"
  (`history/learnings/critical-patterns.md`).

### Integration Points

- `src/renderer/src/components/federated/FederatedQueryTab.tsx` - host for Save
  button + Saved-list drawer; owns `rows`/`sql`/`autoLimit` state to serialize
  (Save) and hydrate (Open).
- `src/shared/types.ts` - add saved-federated record + input types; the
  `FederatedTab` model may need a way to carry an initial payload on Open.
- `src/shared/ipc-channels.ts` - add federated-save channel constants.
- `src/main/index.ts` - register new handlers.
- `src/main/ipc/` - new handler module alongside `script-handlers.ts`.

## Canonical References

- `docs/FEATURE_INTAKE.md` - preliminary lane = **normal** (data model +
  client-visible behavior; no hard gate — no auth/authorization/migration/audit/
  external-provider/validation-weakening).
- `history/save-sql-script/CONTEXT.md` - the sibling feature this extends;
  decision IDs and store/IPC/renderer shape are the direct precedent.
- `history/learnings/critical-patterns.md` - IPC/store patterns to reuse.

## Outstanding Questions

### Deferred To Planning

- [ ] Record shape + whether `list` returns full payload or metadata + `get`
      (D2/D5 lean full payload).
- [ ] Exact "meaningful content" threshold for the D5 overwrite confirm.
- [ ] How Open hydrates the tab: mutate the active tab's state in place vs. carry
      an initial payload on the `FederatedTab` model.

## Deferred Ideas

- Save/Open in `LinkedQueryTab` - out of scope; its payload (per-step
  connections) is a third distinct shape, needs its own design.
- Sharing one unified "saved queries" library across ad-hoc / federated / linked
  tabs - out of scope; D1 keeps stores separate for now.
- Filesystem `.sql`/JSON import/export of federated queries - excluded.
- Folders / tags-for-organization - excluded (mirrors save-sql-script).

## Handoff Note

CONTEXT.md is the source of truth. Decision IDs (D1-D5) are stable. Planning
reads locked decisions, code context, canonical references, and
deferred-to-planning questions. Validating and reviewing use locked decisions for
coverage and UAT. NOTE: the sibling feature `save-sql-script` is parked at
reviewing (execution-complete, review gate not yet approved) — its runtime UAT
still owes closure; do not lose that pointer.
