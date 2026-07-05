import { app, ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  AiGenerateSqlPayload,
  AiGenerateSqlResult,
  ForeignKeyEdge,
  AiSuggestValuesPayload,
  AiSuggestValuesResult,
  AiCheckSqlPayload,
  AiCheckSqlResult,
  AiAskRowPayload,
  AiAskRowResult,
  AiGenerateFederatedSqlPayload,
  FuzzyValueGroup,
  FuzzyValueSuggestion
} from '@shared/types'
import { getConnection } from '../db/connection-store'
import { getApiKey, setApiKey, hasApiKey } from '../db/settings-store'
import { getOrCreatePool, isConnected } from '../pg/pool-manager'
import { query, queryOne } from '../pg/query-runner'
import { generateSqlFromClaude, checkSqlWithClaude, askAboutRowFromClaude } from '../ai/client'
import {
  SYSTEM_PROMPT,
  SQL_CHECK_SYSTEM_PROMPT,
  ASK_ROW_SYSTEM_PROMPT,
  FEDERATED_SYSTEM_PROMPT,
  buildUserMessageParts,
  buildCheckUserMessage,
  buildAskRowMessageParts,
  buildFederatedUserMessageParts,
  type SchemaTable,
  type FederatedSchemaContext
} from '../ai/prompt'

// Dev-only prompt logging (Mức A). In a packaged build this is a no-op, so the
// exact schema/FK/paths context sent to Claude never leaks to end users; while
// developing, print it to the main-process console so you can see what the model
// actually received when a generated query looks wrong.
function debugLogPrompt(label: string, message: string): void {
  if (app.isPackaged) return
  console.debug(`\n[ai] ${label} prompt ─────────────────────────────\n${message}\n─────────────────────────────`)
}

function requirePool(connectionId: string, database?: string) {
  const conn = getConnection(connectionId)
  if (!conn) throw new Error(`Connection ${connectionId} not found`)
  if (!isConnected(connectionId)) throw new Error(`Not connected`)
  return getOrCreatePool(conn, database)
}

// Quote a SQL identifier safely (double internal quotes).
function qid(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

// Dice coefficient over character bigrams — the fallback ranking when pg_trgm is
// not installed. Cheap and good enough to order a handful of candidate values.
function diceSimilarity(a: string, b: string): number {
  const bigrams = (s: string): string[] => {
    const t = s.toLowerCase()
    const out: string[] = []
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2))
    return out
  }
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.length === 0 || B.length === 0) return 0
  const counts = new Map<string, number>()
  for (const g of A) counts.set(g, (counts.get(g) ?? 0) + 1)
  let overlap = 0
  for (const g of B) {
    const c = counts.get(g) ?? 0
    if (c > 0) {
      overlap++
      counts.set(g, c - 1)
    }
  }
  return (2 * overlap) / (A.length + B.length)
}

// Tables + columns for one schema (scoped per CONTEXT D4), ordered so the prompt
// reads naturally.
async function fetchSchemaTables(
  connectionId: string,
  database: string,
  schema: string
): Promise<SchemaTable[]> {
  const pool = requirePool(connectionId, database)
  const rows = await query<{ table: string; column: string; data_type: string }>(
    pool,
    `SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS data_type
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND n.nspname = $1
     ORDER BY c.relname, a.attnum`,
    [schema]
  )
  const map = new Map<string, SchemaTable>()
  for (const r of rows) {
    let t = map.get(r.table)
    if (!t) {
      t = { name: r.table, columns: [] }
      map.set(r.table, t)
    }
    t.columns.push({ name: r.column, data_type: r.data_type })
  }
  return [...map.values()]
}

async function fetchForeignKeys(
  connectionId: string,
  database: string,
  schema: string
): Promise<ForeignKeyEdge[]> {
  const pool = requirePool(connectionId, database)
  return query<ForeignKeyEdge>(
    pool,
    `SELECT
       con.conname   AS constraint_name,
       src_ns.nspname AS src_schema,
       src.relname    AS src_table,
       src_att.attname AS src_column,
       tgt_ns.nspname AS ref_schema,
       tgt.relname    AS ref_table,
       tgt_att.attname AS ref_column,
       k.ord::int     AS key_ordinal
     FROM pg_constraint con
     JOIN pg_class src        ON src.oid = con.conrelid
     JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
     JOIN pg_class tgt        ON tgt.oid = con.confrelid
     JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
     JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(src_attnum, ref_attnum, ord) ON true
     JOIN pg_attribute src_att ON src_att.attrelid = con.conrelid AND src_att.attnum = k.src_attnum
     JOIN pg_attribute tgt_att ON tgt_att.attrelid = con.confrelid AND tgt_att.attnum = k.ref_attnum
     WHERE con.contype = 'f' AND src_ns.nspname = $1
     ORDER BY con.conname, k.ord`,
    [schema]
  )
}

export function registerAiHandlers(): void {
  // Renderer only learns whether a key is configured — never the raw key.
  ipcMain.handle(IPC.SETTINGS_GET, async () => {
    return { hasApiKey: hasApiKey() }
  })

  ipcMain.handle(IPC.SETTINGS_SET, async (_e, { apiKey }: { apiKey: string }) => {
    try {
      setApiKey(apiKey)
      return { ok: true, hasApiKey: hasApiKey() }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // Generate SQL from a natural-language request. Gathers the selected schema's
  // tables/columns + FK edges (D4), builds the prompt, and calls Claude in-main
  // (D1: returns SQL text only — never executes it).
  ipcMain.handle(
    IPC.AI_GENERATE_SQL,
    async (
      _e,
      { connectionId, database, schema, request, baseSql }: AiGenerateSqlPayload
    ): Promise<AiGenerateSqlResult | { error: string }> => {
      try {
        const apiKey = getApiKey()
        if (!apiKey) return { error: 'NO_API_KEY' }
        if (!request.trim()) return { error: 'Empty request' }

        const [tables, edges] = await Promise.all([
          fetchSchemaTables(connectionId, database, schema),
          fetchForeignKeys(connectionId, database, schema)
        ])
        if (tables.length === 0) {
          return { error: `Schema "${schema}" has no tables to query` }
        }

        const parts = buildUserMessageParts(schema, tables, edges, request, baseSql)
        debugLogPrompt('generate-sql', parts.schemaContext + parts.request)
        const sql = await generateSqlFromClaude(apiKey, SYSTEM_PROMPT, parts)
        return { sql }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // Generate a DuckDB federated query from a natural-language request. Gathers
  // each attached database's tables + FKs (per attachment's connection/database/
  // schema) and prompts for cross-DB SQL. Main process only; returns SQL (D1).
  ipcMain.handle(
    IPC.AI_GENERATE_FEDERATED_SQL,
    async (
      _e,
      { attachments, request }: AiGenerateFederatedSqlPayload
    ): Promise<AiGenerateSqlResult | { error: string }> => {
      try {
        const apiKey = getApiKey()
        if (!apiKey) return { error: 'NO_API_KEY' }
        if (!request.trim()) return { error: 'Empty request' }
        if (attachments.length === 0) return { error: 'Attach at least one database first' }

        const contexts: FederatedSchemaContext[] = await Promise.all(
          attachments.map(async (a) => {
            const [tables, edges] = await Promise.all([
              fetchSchemaTables(a.connectionId, a.database, a.schema),
              fetchForeignKeys(a.connectionId, a.database, a.schema)
            ])
            return { alias: a.alias, schema: a.schema, tables, edges }
          })
        )

        const parts = buildFederatedUserMessageParts(contexts, request)
        debugLogPrompt('generate-federated-sql', parts.schemaContext + parts.request)
        const sql = await generateSqlFromClaude(apiKey, FEDERATED_SYSTEM_PROMPT, parts)
        return { sql }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // Review the query in the editor for errors. Gathers the selected schema's
  // tables/columns + FK edges (D4), builds the prompt, and asks Claude for a
  // structured review (D1: reviews and reports — never executes).
  ipcMain.handle(
    IPC.AI_CHECK_SQL,
    async (
      _e,
      { connectionId, database, schema, sql }: AiCheckSqlPayload
    ): Promise<AiCheckSqlResult | { error: string }> => {
      try {
        const apiKey = getApiKey()
        if (!apiKey) return { error: 'NO_API_KEY' }
        if (!sql.trim()) return { error: 'Empty query' }

        const [tables, edges] = await Promise.all([
          fetchSchemaTables(connectionId, database, schema),
          fetchForeignKeys(connectionId, database, schema)
        ])
        const userMessage = buildCheckUserMessage(schema, tables, edges, sql)
        debugLogPrompt('check-sql', userMessage)
        return await checkSqlWithClaude(apiKey, SQL_CHECK_SYSTEM_PROMPT, userMessage)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // Free-form question about ONE result row. This is the only AI path that sends
  // actual data values to the provider, so the renderer is responsible for
  // confirming the send; here we just build the prompt (schema + FK give the model
  // context to relate the row) and return the text answer. Never executes SQL.
  ipcMain.handle(
    IPC.AI_ASK_ROW,
    async (
      _e,
      { connectionId, database, schema, columns, row, question, sourceTable }: AiAskRowPayload
    ): Promise<AiAskRowResult | { error: string }> => {
      try {
        const apiKey = getApiKey()
        if (!apiKey) return { error: 'NO_API_KEY' }
        if (!question.trim()) return { error: 'Empty question' }

        const [tables, edges] = await Promise.all([
          fetchSchemaTables(connectionId, database, schema),
          fetchForeignKeys(connectionId, database, schema)
        ])
        const parts = buildAskRowMessageParts(
          schema,
          tables,
          edges,
          columns,
          row,
          question,
          sourceTable
        )
        debugLogPrompt('ask-row', parts.schemaContext + parts.request)
        const answer = await askAboutRowFromClaude(apiKey, ASK_ROW_SYSTEM_PROMPT, parts)
        return { answer }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // "Did you mean" value suggestions. For each (column, value) filter that came
  // back empty, find columns of that name in the selected schema and return the
  // closest stored values by trigram similarity. Values never leave the machine.
  ipcMain.handle(
    IPC.AI_SUGGEST_VALUES,
    async (
      _e,
      { connectionId, database, schema, terms }: AiSuggestValuesPayload
    ): Promise<AiSuggestValuesResult | { error: string }> => {
      try {
        const pool = requirePool(connectionId, database)
        const trgm = await queryOne<{ ok: number }>(
          pool,
          `SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_trgm'`
        )
        const hasTrgm = !!trgm

        const groups: FuzzyValueGroup[] = []
        for (const term of terms.slice(0, 8)) {
          if (!term.column || !term.value) continue
          // Candidate tables/views in the schema that have a column of this name.
          const candidates = await query<{ table: string }>(
            pool,
            `SELECT c.relname AS table
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
             WHERE n.nspname = $1 AND a.attname = $2
               AND a.attnum > 0 AND NOT a.attisdropped
               AND c.relkind IN ('r','p','v','m','f')
             ORDER BY c.relname
             LIMIT 5`,
            [schema, term.column]
          )

          const merged = new Map<string, FuzzyValueSuggestion>()
          let source = ''
          for (const cand of candidates) {
            const col = qid(term.column)
            const rel = `${qid(schema)}.${qid(cand.table)}`
            let rows: Array<{ value: string; similarity?: number }> = []
            if (hasTrgm) {
              rows = await query<{ value: string; similarity: number }>(
                pool,
                `SELECT val AS value, similarity(val, $1) AS similarity
                 FROM (SELECT DISTINCT ${col}::text AS val FROM ${rel}
                       WHERE ${col} IS NOT NULL LIMIT 10000) d
                 WHERE similarity(val, $1) > 0.1
                 ORDER BY similarity DESC
                 LIMIT 5`,
                [term.value]
              )
            } else {
              const raw = await query<{ value: string }>(
                pool,
                `SELECT DISTINCT ${col}::text AS value FROM ${rel}
                 WHERE ${col}::text ILIKE '%' || $1 || '%'
                 LIMIT 20`,
                [term.value]
              )
              rows = raw.map((r) => ({ value: r.value, similarity: diceSimilarity(term.value, r.value) }))
            }
            for (const r of rows) {
              if (r.value == null) continue
              const sim = r.similarity ?? diceSimilarity(term.value, r.value)
              const prev = merged.get(r.value)
              if (!prev || sim > prev.similarity) merged.set(r.value, { value: r.value, similarity: sim })
              if (!source) source = `${schema}.${cand.table}`
            }
          }

          const suggestions = [...merged.values()]
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, 5)
          if (suggestions.length > 0) {
            groups.push({ column: term.column, value: term.value, raw: term.raw, source, suggestions })
          }
        }

        return { groups, trigram: hasTrgm }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )
}
