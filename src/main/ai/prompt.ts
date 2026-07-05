import type { ForeignKeyEdge } from '@shared/types'
import { findAmbiguousPairs, serializeAmbiguousPaths, detectRequestTables } from './sql-graph'

export interface SchemaTable {
  name: string
  columns: Array<{ name: string; data_type: string }>
}

// Group composite FK columns into a single arrow line, e.g.
// `orders.customer_id -> customers.id` or, composite,
// `shipments.(region, wh_code) -> warehouses.(region, code)`.
// This arrow-list format was confirmed by the 2026-07-01 spike to yield correct
// single-, multi-hop, and composite joins from claude-sonnet-4-6.
export function serializeForeignKeys(
  edges: ForeignKeyEdge[],
  schema: string,
  // Optional DuckDB catalog alias to prefix every table with, so federated
  // prompts read `alias.schema.table` (FKs never cross a DB, so both ends share
  // the alias). Omit for the single-database Postgres prompts.
  alias?: string
): string {
  const q = alias ? `${alias}.` : ''
  const byConstraint = new Map<string, ForeignKeyEdge[]>()
  for (const e of edges) {
    const list = byConstraint.get(e.constraint_name) ?? []
    list.push(e)
    byConstraint.set(e.constraint_name, list)
  }
  const lines: string[] = []
  for (const cols of byConstraint.values()) {
    cols.sort((a, b) => a.key_ordinal - b.key_ordinal)
    const first = cols[0]
    const srcCols = cols.map((c) => c.src_column)
    const refCols = cols.map((c) => c.ref_column)
    const src =
      srcCols.length > 1
        ? `${q}${schema}.${first.src_table}.(${srcCols.join(', ')})`
        : `${q}${schema}.${first.src_table}.${srcCols[0]}`
    const ref =
      refCols.length > 1
        ? `${q}${first.ref_schema}.${first.ref_table}.(${refCols.join(', ')})`
        : `${q}${first.ref_schema}.${first.ref_table}.${refCols[0]}`
    lines.push(`- ${src} -> ${ref}`)
  }
  return lines.length ? lines.join('\n') : '- (none)'
}

function serializeTables(schema: string, tables: SchemaTable[]): string {
  return tables
    .map((t) => {
      const cols = t.columns.map((c) => `${c.name} ${c.data_type}`).join(', ')
      return `- ${schema}.${t.name}(${cols})`
    })
    .join('\n')
}

export const SYSTEM_PROMPT =
  'You are a PostgreSQL expert. Given a database schema with foreign keys and a ' +
  'request in natural language, return ONE runnable PostgreSQL query that answers ' +
  'it. Use the listed foreign keys to join related tables, including multi-hop ' +
  'joins. Use fully-qualified schema.table names.\n' +
  'You may also be given an "Ambiguous join paths" section listing table pairs ' +
  'that can be related through MORE THAN ONE join path (each path is spelled out ' +
  'for you). When the request concerns such a pair, do not invent or pick a route ' +
  'blindly: choose the path whose meaning matches the wording. If the request ' +
  'means membership through ANY route (e.g. "users who are admins", "effective" ' +
  'access, without naming a specific path), combine the relevant paths with UNION ' +
  'rather than picking just one. If it names a specific route (e.g. "directly ' +
  'assigned", "via group"), use only that path.\n' +
  'When filtering on a text label taken from the user\'s wording (a role, status, ' +
  'category, type, name, etc.) that may not match how the value is stored, do NOT ' +
  'use strict equality. Use case-insensitive pattern matching so differences in ' +
  'case, spacing, and separators (space, ".", "_", "-") still match — e.g. ' +
  "`col ILIKE '%targeting%analyst%'` rather than `col = 'targeting analyst'`. Keep " +
  'strict equality only for numeric ids, booleans, dates, and values the user gave ' +
  'verbatim (quoted or obviously exact).\n' +
  'Return ONLY the SQL — no markdown fences, no explanation.'

// Split user message: the schema context (schema + tables + FKs) is stable across
// every call against the same database, so it is a cacheable prefix; the request
// tail (ambiguous paths, base SQL, the ask) varies per call. The client applies
// prompt caching to `schemaContext` — see client.ts. Concatenating the two fields
// reproduces the original single-string prompt byte-for-byte.
export interface UserMessageParts {
  schemaContext: string
  request: string
}

export function buildUserMessageParts(
  schema: string,
  tables: SchemaTable[],
  edges: ForeignKeyEdge[],
  request: string,
  // Existing query to refine. When set, the request is a follow-up edit to this
  // SQL rather than a from-scratch generation.
  baseSql?: string
): UserMessageParts {
  // Approach 2: enumerate multi-path table pairs in code so the model picks a
  // route instead of discovering one. Scope the search to the tables the request
  // names — on a cyclic schema an all-pairs scan floods the prompt with pointless
  // detour routes (see sql-graph.ts). Omit the section entirely when there is
  // nothing to disambiguate.
  const detected = detectRequestTables(
    tables.map((t) => t.name),
    request
  )
  const ambiguous = serializeAmbiguousPaths(
    findAmbiguousPairs(edges, { includeTables: detected })
  )
  const ambiguousBlock = ambiguous
    ? `Ambiguous join paths (more than one route relates these tables — pick the ` +
      `one matching the request, or UNION the paths when it means "through any route"):\n${ambiguous}\n\n`
    : ''
  // Refine mode: hand the model the query it should edit and frame the request as
  // a modification. It must return the FULL updated query, not a diff or snippet.
  const baseBlock = baseSql?.trim()
    ? `Existing query to modify (return the FULL updated query, not a fragment):\n${baseSql.trim()}\n\n`
    : ''
  const requestLabel = baseBlock ? 'Change requested' : 'Request'
  const schemaContext =
    `Schema: ${schema}\n` +
    `Tables:\n${serializeTables(schema, tables)}\n\n` +
    `Foreign keys (use these to join):\n${serializeForeignKeys(edges, schema)}\n\n`
  return { schemaContext, request: ambiguousBlock + baseBlock + `${requestLabel}: ${request}` }
}

export function buildUserMessage(
  schema: string,
  tables: SchemaTable[],
  edges: ForeignKeyEdge[],
  request: string,
  baseSql?: string
): string {
  const { schemaContext, request: tail } = buildUserMessageParts(
    schema,
    tables,
    edges,
    request,
    baseSql
  )
  return schemaContext + tail
}

// System prompt for the "check SQL" feature. Asks for a strict JSON review so the
// renderer can render issues consistently; the client parses it defensively.
export const SQL_CHECK_SYSTEM_PROMPT =
  'You are a PostgreSQL expert reviewing a single SQL query for correctness. You ' +
  'are given a database schema (tables, columns, foreign keys) and one query. ' +
  'Find problems: syntax errors, references to tables or columns that do not ' +
  'exist in the schema, type mismatches, wrong or missing joins, ambiguous ' +
  'columns, and anything that would make the query fail or return wrong results.\n' +
  'Respond with ONLY a JSON object — no markdown fences and no prose outside it — ' +
  'of exactly this shape:\n' +
  '{"ok": boolean, "summary": string, "issues": [{"severity": "error"|"warning"|"info", "message": string, "suggestion": string}], "fixedSql": string}\n' +
  'Rules: "ok" is true only when there are no errors. Use severity "error" when ' +
  'the query would fail or is clearly wrong, "warning" for risky or suboptimal ' +
  'patterns, and "info" for minor notes. Each issue "message" is one sentence and ' +
  '"suggestion" is a concrete fix (may be an empty string). Provide "fixedSql" ' +
  'with a corrected, runnable query using fully-qualified schema.table names ONLY ' +
  'when there are errors to fix; otherwise set it to an empty string.'

export function buildCheckUserMessage(
  schema: string,
  tables: SchemaTable[],
  edges: ForeignKeyEdge[],
  sql: string
): string {
  return (
    `Schema: ${schema}\n` +
    `Tables:\n${serializeTables(schema, tables)}\n\n` +
    `Foreign keys:\n${serializeForeignKeys(edges, schema)}\n\n` +
    `Query to check:\n${sql}`
  )
}

// System prompt for the "ask about a row" feature. Free-form Q&A grounded in the
// schema and one result row; answers in prose, and only emits SQL when a query is
// genuinely what answers the question.
export const ASK_ROW_SYSTEM_PROMPT =
  'You are a PostgreSQL data assistant. You are given a database schema (tables, ' +
  'columns, foreign keys), ONE row from a query result, and a question about it. ' +
  'Answer helpfully and concisely, grounded in the row values and the schema — ' +
  'use the foreign keys to explain how this row relates to other tables. If ' +
  'answering well calls for a query (e.g. to find related or drill-down records), ' +
  'include exactly ONE runnable PostgreSQL query in a single ```sql fenced block ' +
  'using fully-qualified schema.table names; otherwise answer in plain text with ' +
  'no code fence. Never invent columns or values that are not present.\n' +
  'You may be given an "Ambiguous join paths" section listing table pairs related ' +
  'by more than one route (each path spelled out). When a drill-down query touches ' +
  'such a pair, pick the path matching the question, or UNION the relevant paths ' +
  'when it means membership through ANY route.'

// Serialize the selected row as ordered JSON so field order matches what the user
// saw. Values are stringified defensively (objects/arrays via JSON).
function serializeRow(columns: string[], row: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {}
  const keys = columns.length ? columns : Object.keys(row)
  for (const k of keys) ordered[k] = row[k] ?? null
  return JSON.stringify(ordered, null, 2)
}

// System prompt for generating a DuckDB federated query across several attached
// PostgreSQL databases. Confirmed conventions match the federated runner: tables
// are referenced as alias.schema.table, unqualified names resolve across the
// attached schemas via search_path, and FKs never cross a database boundary.
export const FEDERATED_SYSTEM_PROMPT =
  'You are a DuckDB SQL expert writing ONE federated query across several attached ' +
  'PostgreSQL databases. Each attached database has an alias; reference its tables ' +
  'as alias.schema.table. Unqualified table names resolve across the attached ' +
  'schemas, so qualify with alias.schema.table only when the same table name ' +
  'exists in more than one attached database. Use the listed foreign keys to join ' +
  'related tables WITHIN the same database — foreign keys never cross a database ' +
  'boundary, so cross-database joins must be written explicitly on matching ' +
  'columns. Use standard SQL that DuckDB supports.\n' +
  'When filtering on a text label taken from the user\'s wording (a role, status, ' +
  'category, name, etc.), use case-insensitive matching (ILIKE) rather than strict ' +
  'equality unless the value is a number, boolean, date, or given verbatim.\n' +
  'Return ONLY the SQL — no markdown fences, no explanation.'

// One attached database's schema context for the federated prompt.
export interface FederatedSchemaContext {
  alias: string
  schema: string
  tables: SchemaTable[]
  edges: ForeignKeyEdge[]
}

export function buildFederatedUserMessageParts(
  contexts: FederatedSchemaContext[],
  request: string
): UserMessageParts {
  const blocks = contexts.map((c) => {
    const prefix = `${c.alias}.${c.schema}`
    const tableLines = c.tables
      .map((t) => `- ${prefix}.${t.name}(${t.columns.map((col) => `${col.name} ${col.data_type}`).join(', ')})`)
      .join('\n')
    return (
      `Database "${c.alias}" (reference tables as ${prefix}.<table>):\n` +
      `Tables:\n${tableLines || '- (none)'}\n` +
      `Foreign keys (within ${c.alias}):\n${serializeForeignKeys(c.edges, c.schema, c.alias)}`
    )
  })
  return {
    schemaContext: `Attached databases:\n\n${blocks.join('\n\n')}\n\n`,
    request: `Request: ${request}`
  }
}

export function buildFederatedUserMessage(
  contexts: FederatedSchemaContext[],
  request: string
): string {
  const { schemaContext, request: tail } = buildFederatedUserMessageParts(contexts, request)
  return schemaContext + tail
}

export function buildAskRowMessageParts(
  schema: string,
  tables: SchemaTable[],
  edges: ForeignKeyEdge[],
  columns: string[],
  row: Record<string, unknown>,
  question: string,
  // The row's source table, when known. Anchors the ambiguous-paths hint.
  sourceTable?: string
): UserMessageParts {
  // Scope the multi-path hint to the row's table plus any tables named in the
  // question, so a drill-down ("which users have this role") gets the explicit
  // join routes without an all-pairs flood on a cyclic schema. A single endpoint
  // yields no pairs, so pure explain-type questions add nothing.
  const include = [
    ...(sourceTable ? [sourceTable] : []),
    ...detectRequestTables(
      tables.map((t) => t.name),
      question
    )
  ]
  const ambiguous = include.length
    ? serializeAmbiguousPaths(findAmbiguousPairs(edges, { includeTables: include }))
    : ''
  const ambiguousBlock = ambiguous
    ? `Ambiguous join paths (more than one route relates these tables — pick the one ` +
      `matching the question, or UNION the paths when it means "through any route"):\n${ambiguous}\n\n`
    : ''
  const rowLabel = sourceTable
    ? `Selected row (from ${schema}.${sourceTable}, JSON)`
    : 'Selected row (JSON)'
  const schemaContext =
    `Schema: ${schema}\n` +
    `Tables:\n${serializeTables(schema, tables)}\n\n` +
    `Foreign keys:\n${serializeForeignKeys(edges, schema)}\n\n`
  return {
    schemaContext,
    request: ambiguousBlock + `${rowLabel}:\n${serializeRow(columns, row)}\n\n` + `Question: ${question}`
  }
}

export function buildAskRowMessage(
  schema: string,
  tables: SchemaTable[],
  edges: ForeignKeyEdge[],
  columns: string[],
  row: Record<string, unknown>,
  question: string,
  sourceTable?: string
): string {
  const { schemaContext, request } = buildAskRowMessageParts(
    schema,
    tables,
    edges,
    columns,
    row,
    question,
    sourceTable
  )
  return schemaContext + request
}
