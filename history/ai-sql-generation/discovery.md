# AI SQL Generation - Discovery

**Feature slug:** ai-sql-generation
**Date:** 2026-07-01
**Method:** direct file inspection (gkg supported but not indexed; fallback used)

## Repo Reality

pgtable is a working Electron + React app. Three-layer split:
`src/main` (Node/pg/IPC) · `src/preload` (context bridge) · `src/renderer` (React + antd + CodeMirror).

### Storage (relevant to D5)
- Connections persist via **`electron-store`** (`src/main/db/connection-store.ts`),
  store name `pgtable`, not SQLite. CONTEXT.md's "SQLite" was the MVP spec's
  intent; actual impl uses electron-store. The Claude API key follows the same
  pattern: a new key in this store (plaintext, per D5).

### IPC wiring (relevant to Claude + FK channels)
- Channels centralized in `src/shared/ipc-channels.ts` as `IPC` const map.
- Preload bridge (`src/preload/index.ts`) is **generic**: `invoke(channel, payload)`.
  Adding a channel needs NO preload change — just an entry in `ipc-channels.ts`,
  a typed `ipcMain.handle` in main, and a renderer call via `invoke<T>()` from
  `src/renderer/src/api.ts`.
- Handlers registered in `src/main/index.ts` (`registerConnectionHandlers()`,
  `registerDbHandlers()`). A new `registerAiHandlers()` slots in the same way.
- Handler convention: `try { ... } catch (err) { return { error: String(err) } }`.

### Introspection patterns (relevant to FK work)
- `src/main/ipc/db-handlers.ts` already reads pg_catalog: `SCHEMA_INTROSPECT`
  (tables+columns for a database), `OBJECT_LIST`, `PRIMARY_KEYS` (pg_index),
  `OBJECT_COUNTS`. FK introspection is the same shape: query `pg_constraint`
  (`contype = 'f'`) joined to `pg_class`/`pg_namespace`/`pg_attribute`, scoped to
  the selected schema (D4). No FK query exists yet — this is genuinely new.
- `qid()` identifier-quoting helper exists in db-handlers.ts.

### Query editor (relevant to D1, D6 target surface)
- `src/renderer/src/components/query/QueryEditor.tsx` holds `sqlText` in local
  `useState`. Generated SQL lands here by setting that state.
- It already has statement-type detection: `stripCommentsAndStrings()` +
  `applyAutoLimit()` classify SELECT/WITH/TABLE/VALUES vs write/DDL. **The D6
  non-SELECT warning can reuse this exact classification** rather than reinventing it.
- Editor is opened as a tab kind `'query'` via `openQueryTab` in
  `src/renderer/src/store/active-connection.tsx` and rendered in `App.tsx`.

### Settings surface (relevant to D5)
- No settings screen exists. `src/renderer/src/components/TitleBar.tsx` is the
  natural home for a gear icon that opens a settings modal (antd `Modal` + `Form`,
  same components ConnectionForm already uses).

## Gaps to Build

1. FK introspection query + IPC channel (`schema:foreign-keys` or similar).
2. `@anthropic-ai/sdk` dependency (not installed) + main-process Claude client.
3. `ai:generate-sql` IPC channel + prompt assembly (schema + FK graph -> SQL).
4. API-key storage in electron-store + a `settings:get/set` IPC pair.
5. Settings modal UI (enter/save key).
6. Natural-language input UI feeding generated SQL into QueryEditor + non-SELECT warning.

## Constraints / Risks

- **External provider (Anthropic)** — network dependency, API errors, rate limits,
  cost. Intake risk flag. Mitigated by D1 (no auto-execute).
- **Secret handling** — API key at rest (plaintext, D5) and never in renderer memory
  (Claude calls must be main-process only).
- **No test suite is visible** in the repo — "weak proof" flag; validation must
  define how each story is proven (likely manual UAT + typecheck/lint that exist
  in package.json scripts).
- **Feasibility unknown:** calling `@anthropic-ai/sdk` from the Electron main
  process, and whether the selected model reliably returns runnable SQL from the
  scoped schema+FK context. Warrants a spike before full build.
