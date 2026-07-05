import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  TableMeta,
  ColumnMeta,
  TableDataPayload,
  TableDataResult,
  TableExportPayload,
  TableExportResult,
  DbObjectKind,
  ColumnFilter,
  ForeignKeyEdge
} from '@shared/types'
import { getConnection } from '../db/connection-store'
import { getOrCreatePool, isConnected, listPools, listConnectedIds } from '../pg/pool-manager'
import { query, queryOne, countEstimate } from '../pg/query-runner'

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

// Build a parameterized WHERE clause from user-supplied column filters. All
// values are bound as parameters; only the operator/column come from a fixed
// allow-list, never from user text.
function buildWhere(
  filters: ColumnFilter[]
): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  const parts: string[] = []
  for (const f of filters) {
    if (!f.column) continue
    const col = qid(f.column)
    switch (f.op) {
      case 'is_null':
        parts.push(`${col} IS NULL`)
        break
      case 'is_not_null':
        parts.push(`${col} IS NOT NULL`)
        break
      case 'contains':
        params.push(f.value ?? '')
        parts.push(`${col}::text ILIKE '%' || $${params.length} || '%'`)
        break
      case 'starts_with':
        params.push(f.value ?? '')
        parts.push(`${col}::text ILIKE $${params.length} || '%'`)
        break
      case 'like':
        // Value is a raw LIKE pattern (user supplies their own % / _ wildcards).
        params.push(f.value ?? '')
        parts.push(`${col}::text LIKE $${params.length}`)
        break
      case 'ilike':
        params.push(f.value ?? '')
        parts.push(`${col}::text ILIKE $${params.length}`)
        break
      case 'eq':
        params.push(f.value ?? '')
        parts.push(`${col}::text = $${params.length}`)
        break
      case 'neq':
        params.push(f.value ?? '')
        parts.push(`${col}::text <> $${params.length}`)
        break
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const opMap = { gt: '>', gte: '>=', lt: '<', lte: '<=' } as const
        params.push(f.value ?? '')
        parts.push(`${col} ${opMap[f.op]} $${params.length}`)
        break
      }
    }
  }
  return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params }
}

export function registerDbHandlers(): void {
  ipcMain.handle(IPC.DB_LIST, async (_e, { connectionId }: { connectionId: string }) => {
    try {
      const pool = requirePool(connectionId)
      const rows = await query<{ datname: string }>(
        pool,
        `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`
      )
      return rows.map((r) => r.datname)
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    IPC.SCHEMA_LIST,
    async (_e, { connectionId, database }: { connectionId: string; database: string }) => {
      try {
        const pool = requirePool(connectionId, database)
        const rows = await query<{ schema_name: string }>(
          pool,
          `SELECT schema_name FROM information_schema.schemata ORDER BY schema_name`
        )
        return rows.map((r) => r.schema_name)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    IPC.TABLE_LIST,
    async (
      _e,
      {
        connectionId,
        database,
        schema
      }: { connectionId: string; database: string; schema: string }
    ) => {
      try {
        const pool = requirePool(connectionId, database)
        const rows = await query<{
          table_schema: string
          table_name: string
          table_type: string
        }>(
          pool,
          `SELECT table_schema, table_name, table_type
           FROM information_schema.tables
           WHERE table_schema = $1
             AND table_schema NOT IN ('pg_catalog','information_schema')
           ORDER BY table_name`,
          [schema]
        )
        return rows.map(
          (r): TableMeta => ({
            schema: r.table_schema,
            name: r.table_name,
            type: r.table_type === 'VIEW' ? 'VIEW' : 'BASE TABLE'
          })
        )
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // Names of objects of one kind in a schema. pg_class.relkind is the reliable
  // discriminator (r/p = table, v = view, m = matview, S = sequence); functions
  // come from pg_proc.
  ipcMain.handle(
    IPC.OBJECT_LIST,
    async (
      _e,
      {
        connectionId,
        database,
        schema,
        kind
      }: { connectionId: string; database: string; schema: string; kind: DbObjectKind }
    ) => {
      try {
        const pool = requirePool(connectionId, database)
        if (kind === 'function') {
          const rows = await query<{ name: string }>(
            pool,
            `SELECT p.proname AS name
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = $1
             ORDER BY p.proname`,
            [schema]
          )
          return rows.map((r) => r.name)
        }
        const relkinds: Record<Exclude<DbObjectKind, 'function'>, string[]> = {
          table: ['r', 'p'],
          foreign: ['f'],
          view: ['v'],
          matview: ['m'],
          sequence: ['S']
        }
        const rows = await query<{ name: string }>(
          pool,
          `SELECT c.relname AS name
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relkind::text = ANY($2)
           ORDER BY c.relname`,
          [schema, relkinds[kind]]
        )
        return rows.map((r) => r.name)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // Count of each object kind in a schema, in one round-trip. Lets the tree hide
  // categories that have nothing in them.
  ipcMain.handle(
    IPC.OBJECT_COUNTS,
    async (
      _e,
      {
        connectionId,
        database,
        schema
      }: { connectionId: string; database: string; schema: string }
    ) => {
      try {
        const pool = requirePool(connectionId, database)
        const relCount = (kinds: string) =>
          `(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN (${kinds}))`
        const row = await queryOne<Record<DbObjectKind, string>>(
          pool,
          `SELECT
             ${relCount("'r','p'")} AS "table",
             ${relCount("'f'")} AS "foreign",
             ${relCount("'v'")} AS "view",
             ${relCount("'m'")} AS "matview",
             ${relCount("'S'")} AS "sequence",
             (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = $1) AS "function"`,
          [schema]
        )
        const counts: Record<DbObjectKind, number> = {
          table: 0,
          foreign: 0,
          view: 0,
          matview: 0,
          sequence: 0,
          function: 0
        }
        if (row) {
          for (const k of Object.keys(counts) as DbObjectKind[]) {
            counts[k] = parseInt(row[k] ?? '0', 10) || 0
          }
        }
        return counts
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(
    IPC.COLUMN_LIST,
    async (
      _e,
      {
        connectionId,
        database,
        schema,
        table
      }: { connectionId: string; database: string; schema: string; table: string }
    ) => {
      try {
        const pool = requirePool(connectionId, database)
        const rows = await query<{
          column_name: string
          data_type: string
          is_nullable: string
          column_default: string | null
        }>(
          pool,
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [schema, table]
        )
        return rows.map(
          (r): ColumnMeta => ({
            name: r.column_name,
            data_type: r.data_type,
            is_nullable: r.is_nullable === 'YES' ? 'YES' : 'NO',
            column_default: r.column_default
          })
        )
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // Primary-key column names. Empty array means the table has no PK, so the
  // renderer must disable row editing (no safe way to identify a row).
  ipcMain.handle(
    IPC.PRIMARY_KEYS,
    async (
      _e,
      {
        connectionId,
        database,
        schema,
        table
      }: { connectionId: string; database: string; schema: string; table: string }
    ) => {
      try {
        const pool = requirePool(connectionId, database)
        const rows = await query<{ name: string }>(
          pool,
          `SELECT a.attname AS name
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
           WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary`,
          [schema, table]
        )
        return rows.map((r) => r.name)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(IPC.TABLE_DATA, async (_e, payload: TableDataPayload) => {
    const { connectionId, database, schema, table, limit, offset, sortColumn, sortDir, filters } =
      payload
    try {
      const pool = requirePool(connectionId, database)
      const qualifiedTable = `${qid(schema)}.${qid(table)}`
      const where = buildWhere(filters ?? [])
      let sql = `SELECT * FROM ${qualifiedTable}${where.sql}`
      if (sortColumn) {
        const dir = sortDir === 'desc' ? 'DESC' : 'ASC'
        sql += ` ORDER BY ${qid(sortColumn)} ${dir}`
      }
      sql += ` LIMIT ${limit} OFFSET ${offset}`
      const rows = await query(pool, sql, where.params)
      // total_hint is the unfiltered table estimate (pg_class statistics); we
      // skip COUNT(*) on filtered queries to avoid expensive full scans.
      const total_hint = await countEstimate(pool, schema, table)
      return { rows, total_hint } satisfies TableDataResult
    } catch (err) {
      return { error: String(err) }
    }
  })

  // Bulk export honouring the current filters/sort. Same WHERE/ORDER BY as
  // TABLE_DATA but unpaginated, so the renderer can write a whole result set to
  // a file. A hard row cap keeps a runaway export from exhausting memory; we
  // fetch one row past the cap to tell the caller the export was truncated.
  const EXPORT_ROW_CAP = 100_000
  ipcMain.handle(IPC.TABLE_EXPORT, async (_e, payload: TableExportPayload) => {
    const { connectionId, database, schema, table, sortColumn, sortDir, filters, columns, maxRows } =
      payload
    try {
      const pool = requirePool(connectionId, database)
      const qualifiedTable = `${qid(schema)}.${qid(table)}`
      const where = buildWhere(filters ?? [])
      const cap = Math.min(Math.max(1, maxRows ?? EXPORT_ROW_CAP), EXPORT_ROW_CAP)
      const projection = columns && columns.length ? columns.map(qid).join(', ') : '*'
      let sql = `SELECT ${projection} FROM ${qualifiedTable}${where.sql}`
      if (sortColumn) {
        const dir = sortDir === 'desc' ? 'DESC' : 'ASC'
        sql += ` ORDER BY ${qid(sortColumn)} ${dir}`
      }
      sql += ` LIMIT ${cap + 1}`
      const rows = await query<Record<string, unknown>>(pool, sql, where.params)
      const truncated = rows.length > cap
      return {
        rows: truncated ? rows.slice(0, cap) : rows,
        truncated
      } satisfies TableExportResult
    } catch (err) {
      return { error: String(err) }
    }
  })

  // Distinct values of one column, capped. Used by the column-filter popover to
  // suggest existing values; the cap keeps the query fast on huge tables.
  ipcMain.handle(
    IPC.COLUMN_DISTINCT,
    async (
      _e,
      {
        connectionId,
        database,
        schema,
        table,
        column,
        limit = 200
      }: {
        connectionId: string
        database: string
        schema: string
        table: string
        column: string
        limit?: number
      }
    ) => {
      try {
        const pool = requirePool(connectionId, database)
        const cappedLimit = Math.min(Math.max(1, limit), 500)
        const sql = `SELECT DISTINCT ${qid(column)} AS v
                     FROM ${qid(schema)}.${qid(table)}
                     WHERE ${qid(column)} IS NOT NULL
                     ORDER BY 1
                     LIMIT ${cappedLimit}`
        const rows = await query<{ v: unknown }>(pool, sql)
        return rows.map((r) => r.v)
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // Update one row. The row is located by its primary-key values; only the
  // changed columns are written. All values are bound as parameters.
  ipcMain.handle(
    IPC.ROW_UPDATE,
    async (
      _e,
      {
        connectionId,
        database,
        schema,
        table,
        pk,
        changes
      }: {
        connectionId: string
        database: string
        schema: string
        table: string
        pk: Record<string, unknown>
        changes: Record<string, unknown>
      }
    ) => {
      try {
        const pool = requirePool(connectionId, database)
        const cols = Object.keys(changes)
        const pkCols = Object.keys(pk)
        if (pkCols.length === 0) return { error: 'Cannot edit a row without a primary key' }
        if (cols.length === 0) return { ok: true, rowCount: 0 }

        const params: unknown[] = []
        const setSql = cols
          .map((c) => {
            params.push(changes[c])
            return `${qid(c)} = $${params.length}`
          })
          .join(', ')
        const whereSql = pkCols
          .map((c) => {
            params.push(pk[c])
            return `${qid(c)} = $${params.length}`
          })
          .join(' AND ')

        const sql = `UPDATE ${qid(schema)}.${qid(table)} SET ${setSql} WHERE ${whereSql}`
        const result = await pool.query(sql, params)
        if ((result.rowCount ?? 0) === 0) {
          return { error: 'No row was updated (it may have changed or been deleted)' }
        }
        return { ok: true, rowCount: result.rowCount }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // Ad-hoc SQL execution for the query editor. Whatever the user types runs
  // verbatim against the chosen database. No parameterisation here — this is
  // an authoring tool; pg's parser handles statement boundaries.
  ipcMain.handle(
    IPC.QUERY_RUN,
    async (
      _e,
      {
        connectionId,
        database,
        sql
      }: { connectionId: string; database: string; sql: string }
    ) => {
      try {
        const pool = requirePool(connectionId, database)
        const start = Date.now()
        const result = await pool.query(sql)
        const durationMs = Date.now() - start
        // node-postgres returns a single result for one statement and an array
        // for multi-statement input; normalise to the last result so the editor
        // always renders the final rowset (matches DBeaver/TablePlus behaviour).
        const last = Array.isArray(result) ? result[result.length - 1] : result
        return {
          rows: last.rows ?? [],
          fields: (last.fields ?? []).map((f: { name: string }) => f.name),
          rowCount: last.rowCount ?? last.rows?.length ?? 0,
          durationMs,
          command: last.command ?? ''
        }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // Backend substring search across all user schemas in a database. Returns
  // tables, views, matviews and foreign tables; results are capped so a vague
  // query can't return tens of thousands of rows.
  ipcMain.handle(
    IPC.TABLE_SEARCH,
    async (
      _e,
      {
        connectionId,
        database,
        query: q,
        limit = 50
      }: {
        connectionId: string
        database: string
        query: string
        limit?: number
      }
    ) => {
      try {
        const pool = requirePool(connectionId, database)
        const capped = Math.min(Math.max(1, limit), 200)
        const rows = await query<{ schema: string; name: string; relkind: string }>(
          pool,
          `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND n.nspname NOT IN ('pg_catalog', 'information_schema')
             AND n.nspname NOT LIKE 'pg_toast%'
             AND n.nspname NOT LIKE 'pg_temp_%'
             AND c.relname ILIKE $1
           ORDER BY n.nspname, c.relname
           LIMIT $2`,
          [`%${q}%`, capped]
        )
        return rows
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // Cross-database substring search. Iterates every live pool so the user
  // doesn't have to manually expand a database before its tables become
  // findable. Per-pool failures are swallowed — one stale connection
  // shouldn't poison the whole result set.
  ipcMain.handle(
    IPC.TABLE_SEARCH_GLOBAL,
    async (
      _e,
      { query: q, limit = 50 }: { query: string; limit?: number }
    ): Promise<
      | Array<{ connectionId: string; database: string; schema: string; name: string; relkind: string }>
      | { error: string }
    > => {
      try {
        const capped = Math.min(Math.max(1, limit), 200)
        const sql = `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND n.nspname NOT IN ('pg_catalog', 'information_schema')
             AND n.nspname NOT LIKE 'pg_toast%'
             AND n.nspname NOT LIKE 'pg_temp_%'
             AND c.relname ILIKE $1
           ORDER BY n.nspname, c.relname
           LIMIT $2`

        // Build the search target set: every (connectionId, database) where
        // either a live pool already exists, or pg_database lists the DB on
        // a server we're connected to. This catches tables in databases the
        // user hasn't expanded yet.
        type Target = { connectionId: string; database: string }
        const targets = new Map<string, Target>()
        const key = (cid: string, db: string): string => `${cid}::${db}`

        for (const p of listPools()) {
          if (p.database) targets.set(key(p.connectionId, p.database), {
            connectionId: p.connectionId,
            database: p.database
          })
        }

        // Discover additional databases per connected server (pg_database).
        const cids = listConnectedIds()
        const discoveries = await Promise.all(
          cids.map(async (cid) => {
            const conn = getConnection(cid)
            if (!conn) return [] as Target[]
            try {
              const defaultPool = getOrCreatePool(conn)
              const rows = await query<{ datname: string }>(
                defaultPool,
                `SELECT datname FROM pg_catalog.pg_database
                 WHERE datistemplate = false AND datallowconn = true
                 ORDER BY datname`
              )
              return rows.map((r) => ({ connectionId: cid, database: r.datname }))
            } catch {
              return [] as Target[]
            }
          })
        )
        for (const list of discoveries) {
          for (const t of list) targets.set(key(t.connectionId, t.database), t)
        }

        // Search each target. Per-database failures are silently dropped so a
        // single inaccessible DB doesn't sink the whole result set.
        const results = await Promise.all(
          [...targets.values()].map(async (t) => {
            try {
              const conn = getConnection(t.connectionId)
              if (!conn) return []
              const pool = getOrCreatePool(conn, t.database)
              const rows = await query<{ schema: string; name: string; relkind: string }>(
                pool,
                sql,
                [`%${q}%`, capped]
              )
              return rows.map((r) => ({
                connectionId: t.connectionId,
                database: t.database,
                schema: r.schema,
                name: r.name,
                relkind: r.relkind
              }))
            } catch {
              return []
            }
          })
        )
        return results.flat()
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // Returns every user table/view with its columns for one database, used to
  // seed the SQL editor's autocomplete schema. Capped at ~5000 columns so a
  // pathological database can't lock the editor up.
  ipcMain.handle(
    IPC.SCHEMA_INTROSPECT,
    async (
      _e,
      { connectionId, database }: { connectionId: string; database: string }
    ): Promise<
      | { tables: Array<{ schema: string; name: string; columns: string[] }> }
      | { error: string }
    > => {
      try {
        const pool = requirePool(connectionId, database)
        const rows = await query<{ schema: string; table: string; column: string }>(
          pool,
          `SELECT n.nspname AS schema, c.relname AS table, a.attname AS column
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
           WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND a.attnum > 0 AND NOT a.attisdropped
             AND n.nspname NOT IN ('pg_catalog', 'information_schema')
             AND n.nspname NOT LIKE 'pg_toast%'
             AND n.nspname NOT LIKE 'pg_temp_%'
           ORDER BY n.nspname, c.relname, a.attnum
           LIMIT 5000`
        )
        const map = new Map<string, { schema: string; name: string; columns: string[] }>()
        for (const r of rows) {
          const key = `${r.schema}.${r.table}`
          let entry = map.get(key)
          if (!entry) {
            entry = { schema: r.schema, name: r.table, columns: [] }
            map.set(key, entry)
          }
          entry.columns.push(r.column)
        }
        return { tables: [...map.values()] }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  // Foreign-key edges for one schema. Uses pg_constraint (contype='f') and
  // unnest(conkey, confkey) WITH ORDINALITY so composite keys come back as one
  // row per column pair, ordered by key_ordinal. Scoped to the source schema so
  // the AI only ever sees the schema the user is working in (CONTEXT D4).
  ipcMain.handle(
    IPC.SCHEMA_FOREIGN_KEYS,
    async (
      _e,
      { connectionId, database, schema }: { connectionId: string; database: string; schema: string }
    ): Promise<ForeignKeyEdge[] | { error: string }> => {
      try {
        const pool = requirePool(connectionId, database)
        const rows = await query<ForeignKeyEdge>(
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
        return rows
      } catch (err) {
        return { error: String(err) }
      }
    }
  )
}
