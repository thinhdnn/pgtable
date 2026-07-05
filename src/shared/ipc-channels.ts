export const IPC = {
  // Connection management
  CONN_LIST: 'conn:list',
  CONN_ADD: 'conn:add',
  CONN_UPDATE: 'conn:update',
  CONN_DELETE: 'conn:delete',
  CONN_TEST: 'conn:test',
  CONN_CONNECT: 'conn:connect',
  CONN_DISCONNECT: 'conn:disconnect',

  // Database explorer
  DB_LIST: 'db:list',

  // Schema explorer
  SCHEMA_LIST: 'schema:list',

  // Table explorer
  TABLE_LIST: 'table:list',

  // Schema objects grouped by kind (tables, views, sequences, ...)
  OBJECT_LIST: 'object:list',

  // Object counts per kind for one schema (used to hide empty categories)
  OBJECT_COUNTS: 'object:counts',

  // Column viewer
  COLUMN_LIST: 'column:list',

  // Primary-key columns for a table (needed to edit rows safely)
  PRIMARY_KEYS: 'table:primary-keys',

  // Distinct values of one column (capped) — used by the column filter UI to
  // suggest existing values.
  COLUMN_DISTINCT: 'column:distinct',

  // Table data
  TABLE_DATA: 'table:data',

  // Bulk export: every row matching the current filters/sort, up to a
  // server-side cap. Read-only; used by the table viewer's export menu.
  TABLE_EXPORT: 'table:export',

  // Update a single row, identified by its primary key
  ROW_UPDATE: 'row:update',

  // Ad-hoc SQL execution from the query editor
  QUERY_RUN: 'query:run',

  // Substring search for tables/views in one database (backend ILIKE)
  TABLE_SEARCH: 'table:search',

  // Substring search across every live pool — covers databases the user
  // hasn't expanded in the sidebar yet.
  TABLE_SEARCH_GLOBAL: 'table:search-global',

  // Full {schema.table -> [column, ...]} introspection for one database,
  // used to seed SQL editor autocomplete.
  SCHEMA_INTROSPECT: 'schema:introspect',

  // Foreign-key edges for one schema (pg_constraint), used to let the AI join
  // related tables automatically.
  SCHEMA_FOREIGN_KEYS: 'schema:foreign-keys',

  // App settings (Claude API key) stored locally. GET returns a masked "is set"
  // view; SET persists the raw key. The raw key never crosses to the renderer.
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Generate SQL from a natural-language request using the selected schema +
  // FK graph. Main process only (holds the API key); returns SQL text (D1).
  AI_GENERATE_SQL: 'ai:generate-sql',

  // Generate a DuckDB federated query from a natural-language request. Gathers
  // each attached database's tables + FKs and prompts for cross-DB SQL using
  // `alias.schema.table` names. Main process only; returns SQL text (D1).
  AI_GENERATE_FEDERATED_SQL: 'ai:generate-federated-sql',

  // "Did you mean" value suggestions when a query returns no rows. Ranks actually
  // stored values by trigram similarity to the filter literal. Local only — no
  // values are sent to the AI provider.
  AI_SUGGEST_VALUES: 'ai:suggest-values',

  // Review the SQL in the editor for errors using the selected schema + FK graph.
  // Main process only (holds the API key); returns a structured review and, when
  // there are errors, a corrected query. Never executes anything (D1).
  AI_CHECK_SQL: 'ai:check-sql',

  // Free-form question about ONE selected result row. Unlike the other AI
  // features, this sends the row's actual VALUES to the provider — the renderer
  // must confirm each send (shows the exact JSON first). Returns a text answer
  // that may embed a ```sql suggestion.
  AI_ASK_ROW: 'ai:ask-row',

  // Linked Query — run one step of an N-step linear chain against a chosen
  // (connection, database). The main-side rewriter turns every `:stepN.<col>`
  // referencing an earlier step into a `$k, ..., $m` param list (the caller
  // writes the surrounding `IN (...)`) bound to parameterised placeholders,
  // using the upstream result sets passed in the payload. Step 1 runs plain.
  LINKED_STEP_RUN: 'linked:step-run',

  // Federated Query — run one SQL statement across several attached Postgres
  // databases via an in-process DuckDB engine. The user picks which connections
  // to ATTACH (READ_ONLY); tables are referenced as `alias.schema.table`. Main
  // process only (holds credentials). Read-only guarded like Linked Query.
  FEDERATED_RUN: 'federated:run',

  // Saved SQL scripts — an in-app library of named queries persisted locally via
  // electron-store (see history/save-sql-script/CONTEXT.md). LIST returns full
  // records incl. SQL so Open is renderer-only (D6). SAVE upserts by unique name;
  // a name collision without `overwrite` returns `{ error: 'NAME_EXISTS' }` so the
  // renderer can prompt Overwrite / Rename (D3). DELETE removes one by id.
  SCRIPT_LIST: 'script:list',
  SCRIPT_SAVE: 'script:save',
  SCRIPT_DELETE: 'script:delete',

  // Saved federated queries — an in-app library for the Federated Query tab (see
  // history/save-federated-query/CONTEXT.md). Same discipline as SCRIPT_*: LIST
  // returns full records (attachments + SQL + autoLimit) so Open is renderer-only;
  // SAVE upserts by unique name and returns `{ error: 'NAME_EXISTS' }` on a
  // collision without `overwrite` (D4); DELETE removes one by id.
  FEDERATED_SCRIPT_LIST: 'federated-script:list',
  FEDERATED_SCRIPT_SAVE: 'federated-script:save',
  FEDERATED_SCRIPT_DELETE: 'federated-script:delete'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
