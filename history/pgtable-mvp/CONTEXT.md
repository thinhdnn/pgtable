# pgtable MVP - Context

**Feature slug:** pgtable-mvp
**Date:** 2026-06-30
**Exploring session:** complete
**Scope:** Standard
**Domain types:** SEE, CALL, ORGANIZE

## Feature Boundary

Build a lightweight Electron desktop app that lets developers, QA, and DBAs add PostgreSQL connections, browse the database/schema/table tree, and view table data and column metadata — nothing more. Not a DBeaver replacement.

## Locked Decisions

These are fixed. Planning must implement them exactly.

- **D1:** Multiple tables can be open simultaneously in the main panel. Each opened table occupies its own closeable tab. The Data sub-tab and Columns sub-tab live *inside* each table tab. A tab is uniquely identified by `(connectionId, database, schema, table)`. Clicking a table already open by that identity focuses its existing tab — no duplicate tabs are created.

- **D2:** All connections start as Disconnected on every app launch. No auto-reconnect. No tree state restoration. The user must click Connect explicitly each session.

- **D3:** Connection passwords are stored as plaintext in SQLite for MVP. This is an acknowledged deferral — not an oversight. Encryption (Electron safeStorage or AES) is deferred to post-MVP.

- **D4:** Double-clicking a table that is already open focuses its existing tab rather than opening a duplicate.
  - Note: D4 is a consequence of D1's identity rule; both are stated for clarity.

- **D5:** Copy actions on table rows write to the system clipboard. Copy Cell writes the raw cell value as text. Copy Row and Copy Selected Rows write JSON (array of objects, one object per row).

- **D6:** The Columns tab displays columns in `ordinal_position` order as returned by the SQL query. No client-side reordering.

### Agent's Discretion

- UI component library (Ant Design recommended, not locked).
- Exact error message copy for failed connections and query errors.
- Loading indicator placement within the data grid.
- Tab close button style (on hover vs always visible).
- Electron bootstrapper: agent may choose electron-vite or manual Vite + Electron setup; record the choice in `docs/decisions/`.
- pg pool-manager interface: one pool per active connection, destroyed on disconnect; agent designs the API and records it in `docs/decisions/`.

## Specific Ideas And References

- Full product spec is at `history/pgtable-mvp/SPEC.md` — includes exact SQL queries, column viewer field list, pagination sizes (100/500/1000), and layout sketch.
- Lazy loading: tree expands one level per click; no pre-fetching of the full tree on connect.
- Default pagination: 100 rows per page.

## Existing Code Context

No application code exists yet. Repo contains only Harness scaffolding (docs/, scripts/, .codex/, .khuym/).

### Reusable Assets

- `scripts/bin/harness-cli` — Harness CLI for story tracking and decisions

### Established Patterns

- Harness intake process — feature work flows through story packets in `docs/stories/epics/`
- Harness normal-lane story template — `docs/templates/story.md`
- Decision record template — `docs/templates/decision.md`

### Integration Points

- `docs/stories/epics/` — story packets created here per Harness normal-lane rules
- `docs/decisions/` — stack and security decisions recorded here (bootstrapper choice, pool-manager design)

## Canonical References

- `history/pgtable-mvp/SPEC.md` — full product spec with SQL, UI sketch, Phase 1 scope
- `docs/FEATURE_INTAKE.md` — intake classification and lane rules
- `docs/ARCHITECTURE.md` — layering and boundary rules
- `docs/templates/story.md` — story packet template for normal-lane work
- `docs/templates/decision.md` — decision record template

## Epic and Story Scope

**Proposed epic structure (planning confirms):**

| Epic ID | Name |
|---|---|
| E01 | Connection Management |
| E02 | Database / Schema / Table Explorer |
| E03 | Table Data Viewer |

Story files go under `docs/stories/epics/E01-*/`, `E02-*/`, `E03-*/`. Use `harness-cli story add` after creating each file.

## Outstanding Questions

### Resolve Before Planning

- (none — all blocking decisions locked)

### Deferred To Planning

- [ ] Which Electron bootstrapper: electron-vite vs manual Vite setup — investigate and record in `docs/decisions/`.
- [ ] pg pool-manager API: one pool per connectionId, destroyed on `conn:disconnect` — design the interface and record in `docs/decisions/`.
- [ ] IPC channel naming convention: confirm `domain:verb` pattern fits all 11 channels before writing preload bridge.

## Deferred Ideas

- Password encryption (safeStorage or AES) — deferred post-MVP per D3
- SQL Editor — Phase 3 per spec
- Export CSV/Excel — Phase 2 per spec
- SSH Tunnel — Phase 3 per spec
- Query History — Phase 3 per spec
- Auto-reconnect — deferred per D2
- Recent / Favorite Tables — Phase 2 per spec
- Dark Mode — Phase 2+ per spec
- Table Statistics — Phase 2 per spec

## Handoff Note

CONTEXT.md is the source of truth. Decision IDs D1–D6 are stable. Planning reads locked decisions, `history/pgtable-mvp/SPEC.md`, and deferred-to-planning questions. Validating and reviewing use D1–D6 for coverage and UAT. Epic IDs E01–E03 are proposed; planning confirms before assigning story IDs.
