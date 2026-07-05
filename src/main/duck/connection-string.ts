// Pure helpers for the federated (DuckDB) runner: build a libpq connection
// string for the postgres extension's ATTACH, and derive a stable DuckDB
// catalog alias from a connection name. No `pg`, no DuckDB, no IPC — unit-test
// in isolation like src/main/linked-query/executor.ts.
import type { Connection, SslMode } from '@shared/types'

// libpq keyword/value strings quote a value in single quotes and escape a
// literal backslash or single quote with a backslash. Empty values must still
// be quoted so the parser doesn't swallow the following key.
// See PostgreSQL "Connection Strings" (keyword/value form).
function quoteLibpqValue(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

// Our SslMode union is exactly the set of libpq `sslmode` values, so it maps
// through unchanged. Kept as an explicit function so a future divergence has an
// obvious seam.
function sslModeParam(mode: SslMode): string {
  return mode
}

/**
 * Build the libpq connection string DuckDB's postgres extension expects in
 * `ATTACH '<connstr>' AS ... (TYPE postgres)`. `database` overrides the
 * connection's default so a federated attachment can target any database on the
 * server. The password is embedded here (unavoidable for ATTACH) — callers must
 * never log the result.
 */
export function buildLibpqConnString(conn: Connection, database: string): string {
  const parts: Array<[string, string]> = [
    ['host', conn.host],
    ['port', String(conn.port)],
    ['dbname', database],
    ['user', conn.username],
    ['password', conn.password],
    ['sslmode', sslModeParam(conn.ssl_mode)]
  ]
  return parts.map(([k, v]) => `${k}=${quoteLibpqValue(v)}`).join(' ')
}
