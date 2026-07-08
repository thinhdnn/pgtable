// Connection stored locally
export interface Connection {
  id: string
  name: string
  host: string
  port: number
  username: string
  password: string
  ssl_mode: SslMode
  default_database: string
  /** Explicit database allow-list. When non-empty, the app shows exactly these
   *  databases and never queries `pg_database` — for servers where the role
   *  can't read the catalog and a DB is only reachable if you know its name.
   *  Empty/absent means auto-discover every non-template database. */
  databases?: string[]
  description: string
  created_at: string
  updated_at: string
}

export type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'

export type ConnectionState = 'connected' | 'disconnected' | 'failed'

// Schema object categories, mirroring DBeaver's grouping.
export type DbObjectKind =
  | 'table'
  | 'foreign'
  | 'view'
  | 'matview'
  | 'sequence'
  | 'function'

// Input for add/update (same shape, id omitted on add)
export type ConnectionInput = Omit<Connection, 'id' | 'created_at' | 'updated_at'>

// Explorer types
export interface TableMeta {
  schema: string
  name: string
  type: 'BASE TABLE' | 'VIEW'
}

export interface ColumnMeta {
  name: string
  data_type: string
  is_nullable: 'YES' | 'NO'
  column_default: string | null
}

// Table data
export type FilterOp =
  | 'contains'
  | 'starts_with'
  | 'like'
  | 'ilike'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_null'
  | 'is_not_null'

export interface ColumnFilter {
  column: string
  op: FilterOp
  /** Omitted for is_null / is_not_null. */
  value?: string
}

export interface TableDataPayload {
  connectionId: string
  database: string
  schema: string
  table: string
  limit: 100 | 500 | 1000
  offset: number
  sortColumn?: string
  sortDir?: 'asc' | 'desc'
  filters?: ColumnFilter[]
}

export interface TableDataResult {
  rows: Record<string, unknown>[]
  total_hint: number
}

// Bulk export of a table's rows honouring the current filters/sort. Unlike
// TableDataPayload this is not paginated: the handler returns every matching
// row up to a server-side safety cap.
export interface TableExportPayload {
  connectionId: string
  database: string
  schema: string
  table: string
  sortColumn?: string
  sortDir?: 'asc' | 'desc'
  filters?: ColumnFilter[]
  /** Columns to include, in order. Omit for every column (SELECT *). */
  columns?: string[]
  /** Requested row ceiling; the handler clamps it to its own hard cap. */
  maxRows?: number
}

export interface TableExportResult {
  rows: Record<string, unknown>[]
  /** True when the row cap was hit and the result was cut off. */
  truncated: boolean
}

// IPC response envelope
export type IpcOk<T = undefined> = T extends undefined ? { ok: true } : { ok: true } & T
export type IpcError = { error: string }
export type IpcResult<T = undefined> = IpcOk<T> | IpcError

// Tab identity. Discriminated union: a tab is either a table viewer or a SQL
// editor. Both carry connection/database context.
export interface TableTab {
  kind: 'table'
  connectionId: string
  database: string
  schema: string
  table: string
}

export interface QueryTab {
  kind: 'query'
  id: string
  connectionId: string
  database: string
  title: string
  /**
   * Optional starter: seed the editor with `TABLE schema.table;` for this
   * table (set when the tab is opened from a table's context).
   */
  suggest?: { schema: string; table: string }
  /**
   * Optional starter: seed the editor for the database's first table. The
   * concrete table isn't known until schema introspection resolves, so the
   * editor picks it lazily (set when opened from a database node).
   */
  suggestFirstTable?: boolean
  /**
   * Optional starter: pre-fill the editor with this exact SQL (e.g. a query the
   * AI produced from a table row). Takes precedence over the `suggest*` seeds.
   */
  initialSql?: string
}

/**
 * Linked Query tab. Not tied to a single connection/database — each Step
 * inside the tab picks its own (D5 in `history/linked-query/CONTEXT.md`).
 * `id` disambiguates multiple concurrent Linked Query tabs (VQ2 = unlimited).
 */
export interface LinkedQueryTab {
  kind: 'linked-query'
  id: string
  title: string
}

/**
 * Federated Query tab. Like Linked Query, not tied to a single
 * connection/database — the user picks which connections to ATTACH inside the
 * tab. A single SQL statement runs across them via an in-process DuckDB engine.
 * `id` disambiguates multiple concurrent Federated Query tabs.
 */
export interface FederatedTab {
  kind: 'federated'
  id: string
  title: string
}

/** Seed passed to `openQueryTab` describing what starter SQL to pre-fill. */
export type QueryTabSeed =
  | { kind: 'table'; schema: string; table: string }
  | { kind: 'firstTable' }
  | { kind: 'sql'; sql: string }

export type TabId = TableTab | QueryTab | LinkedQueryTab | FederatedTab

export function tabKey(t: TabId): string {
  if (t.kind === 'query') return `query::${t.id}`
  if (t.kind === 'linked-query') return `linked::${t.id}`
  if (t.kind === 'federated') return `federated::${t.id}`
  return `table::${t.connectionId}::${t.database}::${t.schema}::${t.table}`
}

// One foreign-key relationship between two tables in the selected schema. A
// composite FK produces several columns sharing the same `constraint_name`,
// ordered by `key_ordinal`.
export type ForeignKeyEdge = {
  constraint_name: string
  src_schema: string
  src_table: string
  src_column: string
  ref_schema: string
  ref_table: string
  ref_column: string
  key_ordinal: number
}

// Request/response for AI SQL generation. The main process builds the prompt
// from the selected schema's tables/columns/FKs and calls Claude; only the SQL
// text comes back to the renderer (D1: generate and display, never execute).
export interface AiGenerateSqlPayload {
  connectionId: string
  database: string
  schema: string
  request: string
  /**
   * Existing SQL to refine. When present, the request is a follow-up instruction
   * to modify this query (e.g. the user selected a generated statement and asked
   * to change it) rather than a from-scratch generation. Omit for a fresh query.
   */
  baseSql?: string
}

export interface AiGenerateSqlResult {
  sql: string
}

// Generate a DuckDB FEDERATED query from a natural-language request. The main
// process fetches each attached database's tables/columns/FKs (per attachment's
// connection/database/schema) and prompts Claude to write cross-database SQL that
// references tables as `alias.schema.table`. Reuses AiGenerateSqlResult.
export interface AiGenerateFederatedSqlPayload {
  attachments: FederatedAttachment[]
  request: string
}

// Request/response for asking a free-form question about ONE result row. Unlike
// generation/check, this sends the row's actual values to the provider, so the
// renderer confirms each send. `columns` fixes the field order shown/sent; `row`
// holds the values. The answer is prose that may contain a ```sql block.
export interface AiAskRowPayload {
  connectionId: string
  database: string
  schema: string
  columns: string[]
  row: Record<string, unknown>
  question: string
  /**
   * The table the row came from, when known (table viewer). Anchors the
   * ambiguous-join-paths hint so a drill-down question ("which users have this
   * role") gets the explicit multi-hop routes. Omit when the row has no single
   * source table (e.g. a join result in the SQL editor).
   */
  sourceTable?: string
}

export interface AiAskRowResult {
  answer: string
}

// Request/response for the AI "check SQL" feature. The main process builds a
// prompt from the selected schema (tables/columns/FKs) plus the query in the
// editor and asks Claude to review it. Like generation, it only reviews — it
// never executes anything (D1).
export interface AiCheckSqlPayload {
  connectionId: string
  database: string
  schema: string
  sql: string
}

export type AiCheckSeverity = 'error' | 'warning' | 'info'

export interface AiCheckSqlIssue {
  severity: AiCheckSeverity
  /** One-sentence description of the problem. */
  message: string
  /** Optional concrete fix for this issue. */
  suggestion?: string
}

export interface AiCheckSqlResult {
  /** True when the query has no errors. */
  ok: boolean
  /** One-line overall assessment. */
  summary: string
  issues: AiCheckSqlIssue[]
  /** Corrected, runnable query — present only when there were errors to fix. */
  fixedSql?: string
}

// "Did you mean" support: when a generated query returns no rows, the renderer
// extracts the (column, value) filter literals and asks the main process for the
// closest actually-stored values, ranked by trigram similarity (pg_trgm) with an
// ILIKE fallback when the extension is absent. Values stay on the machine — never
// sent to Claude.
export interface FuzzyValueQuery {
  /** Bare column name (any alias prefix already stripped). */
  column: string
  /** The literal the user filtered on (wildcards/quotes already stripped). */
  value: string
  /** The exact quoted literal as it appears in the SQL, for in-editor patching. */
  raw: string
}

export interface FuzzyValueSuggestion {
  value: string
  similarity: number
}

export interface FuzzyValueGroup {
  column: string
  value: string
  raw: string
  /** schema.table where these suggestions came from. */
  source: string
  suggestions: FuzzyValueSuggestion[]
}

export interface AiSuggestValuesPayload {
  connectionId: string
  database: string
  schema: string
  terms: FuzzyValueQuery[]
}

export interface AiSuggestValuesResult {
  groups: FuzzyValueGroup[]
  /** False when pg_trgm is unavailable and ranking fell back to substring match. */
  trigram: boolean
}

// Ad-hoc SQL query execution
export interface QueryRunPayload {
  connectionId: string
  database: string
  sql: string
}

export interface QueryRunResult {
  rows: Record<string, unknown>[]
  fields: string[]
  rowCount: number
  durationMs: number
  command: string
}

// Linked Query — see `history/linked-query/CONTEXT.md` (D1–D5) and D6 (N-step
// linear chaining). One channel runs any step in the chain: it rewrites every
// `:stepN.<col>` placeholder against the supplied upstream result sets. The
// renderer holds every step's result (VQ2 = renderer state only, no main-side
// cache) and passes the results of all earlier steps as `upstream`.

/** One earlier step's result set, keyed by 1-based step number in `upstream`. */
export interface LinkedUpstreamResult {
  fields: string[]
  rows: Record<string, unknown>[]
}

export type LinkedUpstreamResults = Record<number, LinkedUpstreamResult>

export interface LinkedStepRunPayload {
  connectionId: string
  database: string
  sql: string
  /** 1-based position of this step in the chain. Step 1 has no upstream. */
  stepIndex: number
  /** Result sets of already-run earlier steps, keyed by 1-based step number. */
  upstream: LinkedUpstreamResults
}

export interface LinkedStepRunResult {
  rows: Record<string, unknown>[]
  fields: string[]
  rowCount: number
  durationMs: number
  /** True when the executor appended a safety LIMIT. */
  autoLimited: boolean
}

/** A step's outcome: rows, or a D4 short-circuit when a referenced upstream
 * keyset is empty. Failures use the standard `{ error }` IPC envelope. */
export type LinkedStepRunOutcome =
  | (LinkedStepRunResult & { skipped?: false })
  | { skipped: true; reason: 'EMPTY_KEYSET' }

/** One Postgres database the federated query should ATTACH. `alias` is the
 * DuckDB catalog name the user references as `alias.schema.table`; it is
 * derived from the connection name on the renderer and echoed here so the run
 * report and the editor agree on the same names. */
export interface FederatedAttachment {
  connectionId: string
  database: string
  alias: string
  /** Schema whose tables become unqualified-resolvable via search_path. The
   * runner builds `search_path` from every attachment's `alias.schema` in
   * order, so unqualified table names resolve across the attached DBs (as long
   * as they don't collide). Defaults to `public` in the UI. */
  schema: string
}

export interface FederatedRunPayload {
  attachments: FederatedAttachment[]
  sql: string
  /** When true (default), a bare SELECT gets a safety LIMIT appended. Set false
   * to run with no row cap. */
  autoLimit: boolean
}

/** Federated run result. Same shape as a Linked step result so the renderer can
 * reuse QueryResultTable and the auto-LIMIT badge. Failures use `{ error }`. */
export type FederatedRunResult = LinkedStepRunResult

export type FederatedRunOutcome = FederatedRunResult | { error: string }

// Saved SQL script — an in-app library of named queries (see
// history/save-sql-script/CONTEXT.md). The list is global (D2): every script is
// visible under every connection. `connectionId` is an optional non-filtering
// hint tag only — it never scopes or hides a script. Stored locally via
// electron-store in its own file (`pgtable-scripts`).
export interface SavedScript {
  id: string
  name: string
  sql: string
  /** Optional non-filtering connection hint (D2); stores the stable connection id. */
  connectionId?: string
  created_at: string
  updated_at: string
}

// Save payload: no id/timestamps. `overwrite` confirms replacing an existing
// same-named script (D3). Absent/false against a name collision is rejected so
// the renderer can prompt Overwrite / Rename.
export interface SavedScriptInput {
  name: string
  sql: string
  connectionId?: string
  overwrite?: boolean
}

// One attachment inside a saved federated query (see
// history/save-federated-query/CONTEXT.md, D2). Deliberately omits the DuckDB
// `alias` present on FederatedAttachment: the alias is derived from the
// connection name in row order via deriveAlias(), so storing the ordered
// attachments regenerates identical aliases on Open.
export interface SavedFederatedAttachment {
  connectionId: string
  database: string
  schema: string
}

// Saved federated query — an in-app library entry for the Federated Query tab.
// Persists the full runnable payload (attachments + SQL + autoLimit) so Open
// reconstructs the tab ready to Run (D2). Stored locally via electron-store in
// its own file (`pgtable-federated-scripts`, D1), separate from saved scripts.
export interface SavedFederatedQuery {
  id: string
  name: string
  attachments: SavedFederatedAttachment[]
  sql: string
  /** Mirrors the tab's autoLimit toggle: when true (default) a bare SELECT gets
   * a safety LIMIT on Run. Restored on Open. */
  autoLimit: boolean
  created_at: string
  updated_at: string
}

// Save payload: no id/timestamps. `overwrite` confirms replacing an existing
// same-named entry (D4). Absent/false against a name collision is rejected so
// the renderer can prompt Overwrite / Rename.
export interface SavedFederatedQueryInput {
  name: string
  attachments: SavedFederatedAttachment[]
  sql: string
  autoLimit: boolean
  overwrite?: boolean
}
