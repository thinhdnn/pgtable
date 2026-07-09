# US-019 Unify the feature tabs with the app's design system

## Status

in_progress

## Lane

normal

## Product Contract

The query, federated, linked-query and table tabs must read as one application.
A user switching between them sees the same toolbar, the same control density,
the same accent color, and the same keyboard bindings. AI copy names no specific
vendor.

## Relevant Product Docs

- `docs/decisions/0011-renderer-ui-conventions.md` (conventions established here)
- `docs/decisions/0010-pluggable-ai-providers.md` (source of the stale "Claude" copy)

## Acceptance Criteria

- Federated and linked-query tabs are full-height panes with a flush toolbar,
  not `padding: 16` scrolling pages.
- Buttons and selects in both new tabs are `size="small"`, matching `QueryEditor`
  and `TableViewer`.
- No `<Tag>` in the renderer uses a preset palette color (`blue`, `green`, `red`,
  `orange`). Status colors only, so tags track the teal accent and dark mode.
- `Mod-Enter` runs the query in the federated tab and runs the focused step in
  the linked-query tab. `Shift-Alt-F` formats in both.
- Federated `Ask AI` routes a missing API key to Settings rather than surfacing a
  raw error, as `QueryEditor` does.
- No user-facing string names Claude.
- Neither new tab repeats its own title inside the pane.

## Design Notes

- Commands: none.
- Queries: none.
- API: none. Renderer-only; no IPC channel, payload, or main-process change.
- Tables: none.
- Domain rules: none.
- UI surfaces: `styles.css` (new `.pg-toolbar`, `.pg-toolbar-meta`, `.pg-subbar`,
  `.pg-hint`, `.pg-mono`, `.pg-placeholder`), `FederatedQueryTab`,
  `LinkedQueryTab`, `QueryEditor`, `AskRowModal`, `QueryResultTable`,
  `useAiGenerate`.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Existing 114 tests still pass; no new pure logic introduced to cover. |
| Integration | n/a — no IPC or main-process surface changed. |
| E2E | n/a — no DOM test environment installed (clean skip per AGENTS.md). |
| Platform | Renderer builds for the packaged app. |
| Release | Manual UAT of the three tabs against a live Postgres pair. |

## Harness Delta

None. `npm run lint` is declared in `package.json` but `eslint` is not installed
in `node_modules`; treated as an absent capability and skipped.

## Evidence

- `npm run typecheck` (node + web) clean.
- `npx vitest run` — 114/114 across 11 files.
- `npm run build` clean; all six new `.pg-*` classes verified present in
  `out/renderer/assets/index-*.css`.
- `antd/es/tag/style/statusCmp.js` read directly to confirm `processing` maps to
  `colorInfo`, which `theme.tsx` sets to the teal accent in both modes.
- Manual in-app UAT still pending.
