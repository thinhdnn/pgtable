# Save SQL Script - Context

**Feature slug:** save-sql-script
**Date:** 2026-07-03
**Exploring session:** complete
**Scope:** Standard
**Domain types:** SEE, CALL, ORGANIZE

## Feature Boundary

Add an in-app library of named SQL scripts to the main ad-hoc QueryEditor: the
user can Save the current editor text under a unique name, Open a saved script
back into the editor, and Delete one. Storage is local via `electron-store`.
The feature ends at the QueryEditor surface — it does not touch the Federated or
Linked query editors, the filesystem, or any `.sql` file import/export.

## Locked Decisions

These are fixed. Planning must implement them exactly.

- **D1:** Script persistence is an in-app library stored locally via
  `electron-store` (same mechanism as connections/settings). No filesystem
  `.sql` save/open dialogs.
  - Rationale: matches the established `connection-store.ts` / `settings-store.ts`
    persistence pattern; keeps blast radius off the OS file layer.
- **D2:** Scripts are **global** (visible under every connection). Each script
  may carry an optional connection tag as a non-filtering hint only — the tag
  never hides a script from other connections.
- **D3:** Name is required and must be unique. On Save, if the name collides with
  an existing script, prompt the user to **Overwrite** or **Rename**. (Overwrite
  is the update path — see D6.)
- **D4:** Script list is a **flat list with a search box**, sortable by name /
  last-modified. No folders, no tags-for-organization.
- **D5:** UI integration is the **main ad-hoc QueryEditor only**
  (`src/renderer/src/components/query/QueryEditor.tsx`). Save button + a
  list/panel to reopen live here.
- **D6:** Operation set is **minimal: Save / Open / Delete**. There is no
  separate Update/Rename operation — editing an existing script is done by
  Save-ing under the same name and choosing Overwrite (D3). IPC contract:
  `script:list`, `script:save`, `script:delete`.
  - Open is a renderer-side action: it loads a listed script's text into the
    editor; no dedicated `script:get` channel is required if `script:list`
    returns full text.

### Agent's Discretion

- Exact `electron-store` schema/shape for a script record (id, name, sql,
  optional connection tag, createdAt/updatedAt) — planning decides, must support
  D2–D4 and D6.
- Where the Save button and the script list/panel physically sit within
  QueryEditor's layout, and how Open behaves relative to unsaved editor content
  (replace vs. confirm) — resolve during planning as a UX detail; do not expand
  scope beyond QueryEditor.
- IPC channel naming may follow the repo convention (`script:<verb>`) but exact
  constant names in `src/shared/ipc-channels.ts` are planning's call.

## Existing Code Context

From the quick scout. Downstream agents read these before planning.

### Reusable Assets

- `src/main/db/connection-store.ts` - `electron-store`-backed store; template for
  a new `script-store.ts`.
- `src/main/db/settings-store.ts` - second `electron-store` example (masked
  get/set discipline); reference for store shape and IPC handler style.
- `src/renderer/src/components/common/SqlEditor.tsx` - shared CodeMirror editor;
  QueryEditor already wraps it. Save reads its current `value`; Open sets it.

### Established Patterns

- One narrow IPC channel per verb, `<domain>:<verb>` — see
  `src/shared/ipc-channels.ts` (`CONN_*`, `SETTINGS_*`, `AI_*`). New channels:
  `script:list`, `script:save`, `script:delete`.
- Main-process store + `ipc/<domain>-handlers.ts` handler module registered from
  `src/main/index.ts` — mirror `connection-handlers.ts`.
- Critical pattern [20260701] "Provider SDK / IPC in Electron Main": store lives
  in `src/main/db/`, renderer never touches persistence directly, one narrow IPC
  channel per verb. (`history/learnings/critical-patterns.md`)

### Integration Points

- `src/renderer/src/components/query/QueryEditor.tsx` - host for the Save button
  and the reopen list/panel.
- `src/shared/ipc-channels.ts` - add `SCRIPT_LIST/SAVE/DELETE` constants.
- `src/main/index.ts` (or the IPC registration site) - register new handlers.
- `src/main/ipc/` - new `script-handlers.ts` alongside existing handler modules.

## Canonical References

- `docs/FEATURE_INTAKE.md` - intake lane rules; preliminary lane = **normal**
  (data model + public-contract flags, no hard gate).
- `history/learnings/critical-patterns.md` - IPC/store patterns to reuse.
- `history/ai-sql-generation/` - most recent comparable feature (store + IPC +
  renderer wiring); good precedent for phase shape.

## Outstanding Questions

### Deferred To Planning

- [ ] Does `script:list` return full SQL text (making Open renderer-only) or just
      metadata + a `script:get`? - decide by store size/perf, but D6 leans full text.
- [ ] Open-vs-unsaved-content UX (replace silently / confirm / new context) -
      planning UX decision within QueryEditor.
- [ ] Store record shape and whether the optional connection tag stores a
      connection id or label - planning decides against D2.

## Deferred Ideas

- Save/Open in `FederatedQueryTab` and `LinkedQueryTab` - out of scope (D5);
  their payloads are structured, not plain SQL text, so they need separate design.
- Filesystem `.sql` import/export - explicitly excluded by D1.
- Folders / tags-for-organization - excluded by D4.
- Rename / dedicated Update operation - excluded by D6 (overwrite covers it).

## Handoff Note

CONTEXT.md is the source of truth. Decision IDs (D1-D6) are stable. Planning reads
locked decisions, code context, canonical references, and deferred-to-planning
questions. Validating and reviewing use locked decisions for coverage and UAT.
