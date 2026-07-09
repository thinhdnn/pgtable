// Federated query runner: executes one SQL statement across several attached
// Postgres databases using an in-process DuckDB engine (postgres extension).
//
// V1 favours correctness and isolation over throughput: every run spins up a
// fresh in-memory DuckDB instance, ATTACHes the requested connections
// READ_ONLY, runs the statement, and tears the instance down. There is no
// caching or connection reuse yet — attach cost is paid per run.
//
// A run is cancellable. It registers itself under the caller's `runId` for as
// long as it holds a DuckDB instance, so `cancelRun` can interrupt it from the
// IPC handler; see `run-registry.ts` for why interrupting alone is not enough.
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import type { FederatedAttachment, FederatedRunResult } from '@shared/types'
import { getConnection } from '../db/connection-store'
import { isConnected } from '../pg/pool-manager'
import { isReadOnlyStatement, applyAutoLimit } from '../linked-query/executor'
import { FEDERATED_ROW_LIMIT } from '@shared/federated'
import { buildLibpqConnString } from './connection-string'
import { beginRun, endRun, throwIfCancelled, FederatedCancelledError } from './run-registry'

export { cancelRun, FederatedCancelledError } from './run-registry'

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
 *
 * `runId` identifies the run for `cancelRun`. A cancelled run throws
 * `FederatedCancelledError`, which the handler reports as an abort rather than a
 * query failure. Validation runs before registration, so a run that never
 * reaches DuckDB is never cancellable — there is nothing to stop.
 */
export async function runFederatedQuery(
  attachments: FederatedAttachment[],
  sql: string,
  autoLimit: boolean,
  runId: string
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

  const handle = beginRun(runId)
  let instance: DuckDBInstance | null = null
  let connection: DuckDBConnection | null = null
  try {
    instance = await DuckDBInstance.create(':memory:')
    connection = await instance.connect()
    // Only now can a cancel interrupt anything. Re-check first: `cancelRun` may
    // have armed the flag while the instance was still spinning up.
    handle.connection = connection
    throwIfCancelled(handle)

    // Ensure the postgres extension is present. INSTALL downloads it to the
    // user's DuckDB extension dir on first use (needs network once, then
    // cached); LOAD activates it. Offline packaged use needs a bundled
    // extension — tracked as a follow-up.
    await connection.run('INSTALL postgres')
    await connection.run('LOAD postgres')
    throwIfCancelled(handle)

    for (const a of attachments) {
      const conn = getConnection(a.connectionId)!
      const connStr = buildLibpqConnString(conn, a.database)
      // `connStr` carries the password — do not log it. Alias is validated
      // above so it is safe to interpolate as an identifier.
      await connection.run(
        `ATTACH ${escapeLiteral(connStr)} AS ${a.alias} (TYPE postgres, READ_ONLY)`
      )
      // Each ATTACH dials Postgres, so a user cancelling during a slow handshake
      // must not have to wait for the remaining attachments.
      throwIfCancelled(handle)
    }
    // Build search_path from every attachment's `alias.schema` in order, so
    // unqualified table names resolve across the attached DBs. Names that
    // collide across DBs are still ambiguous — qualify those as
    // `alias.schema.table`. Join with a bare comma: DuckDB does NOT trim
    // whitespace between entries, so `a, b` looks for a schema named " b".
    const searchPath = attachments.map((a) => `${a.alias}.${a.schema}`).join(',')
    await connection.run(`SET search_path = ${escapeLiteral(searchPath)}`)
    throwIfCancelled(handle)

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
  } catch (err) {
    // An interrupted statement surfaces as a generic DuckDB error. The flag is
    // what tells us the abort was asked for, so report it as one instead of
    // showing the user "INTERRUPT Error: Interrupted!" in the error alert.
    if (handle.cancelled) throw new FederatedCancelledError()
    throw err
  } finally {
    endRun(runId, handle)
    connection?.disconnectSync()
    // The header has always claimed the instance is torn down; until now nothing
    // closed it, so every run leaked one in-memory DuckDB instance.
    instance?.closeSync()
  }
}

// DuckDB string literal: wrap in single quotes, double any interior quote.
function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
