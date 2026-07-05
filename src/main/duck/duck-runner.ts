// Federated query runner: executes one SQL statement across several attached
// Postgres databases using an in-process DuckDB engine (postgres extension).
//
// V1 favours correctness and isolation over throughput: every run spins up a
// fresh in-memory DuckDB instance, ATTACHes the requested connections
// READ_ONLY, runs the statement, and tears the instance down. There is no
// caching or connection reuse yet — attach cost is paid per run.
import { DuckDBInstance } from '@duckdb/node-api'
import type { FederatedAttachment, FederatedRunResult } from '@shared/types'
import { getConnection } from '../db/connection-store'
import { isConnected } from '../pg/pool-manager'
import { isReadOnlyStatement, applyAutoLimit } from '../linked-query/executor'
import { FEDERATED_ROW_LIMIT } from '@shared/federated'
import { buildLibpqConnString } from './connection-string'

export class FederatedRunError extends Error {}

// DuckDB catalog aliases are emitted by the client; validate here as defence in
// depth so a crafted alias can't break out of the ATTACH ... AS <ident> clause.
const ALIAS_RE = /^[a-z][a-z0-9_]*$/
// Schemas flow into the `alias.schema` search_path list; keep them to plain
// identifiers so a name can't inject a path separator or break out of the
// literal. Unusual (quoted) schema names must be referenced via full
// `alias.schema.table` qualification in the SQL instead.
const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/

/**
 * Run `sql` across the given attachments. Throws `FederatedRunError` with a
 * user-facing message on bad input (empty SQL, non-read-only statement, unknown
 * or disconnected connection, malformed alias); lets unexpected DuckDB errors
 * propagate to the handler's catch-all. Never logs connection strings (they
 * carry passwords).
 */
export async function runFederatedQuery(
  attachments: FederatedAttachment[],
  sql: string,
  autoLimit: boolean
): Promise<FederatedRunResult> {
  if (!sql.trim()) throw new FederatedRunError('SQL is empty')
  if (!isReadOnlyStatement(sql)) {
    throw new FederatedRunError(
      'Federated SQL must be a read-only SELECT or WITH statement — DML/DDL is not allowed'
    )
  }
  if (attachments.length === 0) {
    throw new FederatedRunError('Select at least one connection to attach')
  }

  const seen = new Set<string>()
  for (const a of attachments) {
    if (!ALIAS_RE.test(a.alias)) throw new FederatedRunError(`Invalid alias "${a.alias}"`)
    if (!SCHEMA_RE.test(a.schema)) {
      throw new FederatedRunError(
        `Schema "${a.schema}" for "${a.alias}" isn't a plain identifier — qualify its tables as alias.schema.table instead`
      )
    }
    if (seen.has(a.alias)) throw new FederatedRunError(`Duplicate alias "${a.alias}"`)
    seen.add(a.alias)
    if (!getConnection(a.connectionId)) {
      throw new FederatedRunError(`Connection ${a.connectionId} not found`)
    }
    if (!isConnected(a.connectionId)) {
      throw new FederatedRunError(`Connection "${a.alias}" is not connected`)
    }
  }

  const { sql: capped, appended } = autoLimit
    ? applyAutoLimit(sql, FEDERATED_ROW_LIMIT)
    : { sql, appended: false }

  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  try {
    // Ensure the postgres extension is present. INSTALL downloads it to the
    // user's DuckDB extension dir on first use (needs network once, then
    // cached); LOAD activates it. Offline packaged use needs a bundled
    // extension — tracked as a follow-up.
    await connection.run('INSTALL postgres')
    await connection.run('LOAD postgres')

    for (const a of attachments) {
      const conn = getConnection(a.connectionId)!
      const connStr = buildLibpqConnString(conn, a.database)
      // `connStr` carries the password — do not log it. Alias is validated
      // above so it is safe to interpolate as an identifier.
      await connection.run(
        `ATTACH ${escapeLiteral(connStr)} AS ${a.alias} (TYPE postgres, READ_ONLY)`
      )
    }
    // Build search_path from every attachment's `alias.schema` in order, so
    // unqualified table names resolve across the attached DBs. Names that
    // collide across DBs are still ambiguous — qualify those as
    // `alias.schema.table`. Join with a bare comma: DuckDB does NOT trim
    // whitespace between entries, so `a, b` looks for a schema named " b".
    const searchPath = attachments.map((a) => `${a.alias}.${a.schema}`).join(',')
    await connection.run(`SET search_path = ${escapeLiteral(searchPath)}`)

    const started = Date.now()
    const reader = await connection.runAndReadAll(capped)
    const durationMs = Date.now() - started

    const fields = reader.columnNames()
    const rows = reader.getRowObjectsJson() as Record<string, unknown>[]

    return {
      rows,
      fields,
      rowCount: rows.length,
      durationMs,
      autoLimited: appended
    }
  } finally {
    connection.disconnectSync()
  }
}

// DuckDB string literal: wrap in single quotes, double any interior quote.
function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
