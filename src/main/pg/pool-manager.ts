import { Pool } from 'pg'
import type { Connection, SslMode } from '@shared/types'

// Pools keyed by `connectionId` (default DB) or `connectionId::database`.
const pools = new Map<string, Pool>()
// Records the actual database name behind each pool so consumers don't have
// to reverse-engineer it from the key or peek at pg internals.
const poolDb = new Map<string, string>()

function sslConfig(mode: SslMode): object | boolean {
  if (mode === 'disable') return false
  if (mode === 'require') return { rejectUnauthorized: false }
  if (mode === 'verify-ca' || mode === 'verify-full') return { rejectUnauthorized: true }
  return false
}

export function createPool(conn: Connection, database?: string): Pool {
  const pool = new Pool({
    host: conn.host,
    port: conn.port,
    user: conn.username,
    password: conn.password,
    database: database ?? conn.default_database,
    ssl: sslConfig(conn.ssl_mode),
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  })
  return pool
}

export function getPool(connectionId: string): Pool | undefined {
  return pools.get(connectionId)
}

export function getOrCreatePool(conn: Connection, database?: string): Pool {
  const key = database ? `${conn.id}::${database}` : conn.id
  if (!pools.has(key)) {
    pools.set(key, createPool(conn, database))
    poolDb.set(key, database ?? conn.default_database)
  }
  return pools.get(key)!
}

export async function connectPool(conn: Connection): Promise<void> {
  const pool = createPool(conn, conn.default_database)
  // Verify connectivity
  const client = await pool.connect()
  client.release()
  pools.set(conn.id, pool)
  poolDb.set(conn.id, conn.default_database)
}

export async function disconnectPool(connectionId: string): Promise<void> {
  // Drain all pools that start with this connectionId
  for (const [key, pool] of pools) {
    if (key === connectionId || key.startsWith(`${connectionId}::`)) {
      await pool.end()
      pools.delete(key)
      poolDb.delete(key)
    }
  }
}

export function isConnected(connectionId: string): boolean {
  return pools.has(connectionId)
}

// Lists every live pool as (connectionId, database, pool). Used by
// cross-database features like global table search so callers don't need to
// guess which databases the user has touched.
export function listPools(): Array<{ connectionId: string; database: string; pool: Pool }> {
  const out: Array<{ connectionId: string; database: string; pool: Pool }> = []
  for (const [key, pool] of pools) {
    const db = poolDb.get(key) ?? ''
    const cid = key.includes('::') ? key.slice(0, key.indexOf('::')) : key
    out.push({ connectionId: cid, database: db, pool })
  }
  return out
}

// All connectionIds that currently have at least one open pool.
export function listConnectedIds(): string[] {
  const ids = new Set<string>()
  for (const key of pools.keys()) {
    ids.add(key.includes('::') ? key.slice(0, key.indexOf('::')) : key)
  }
  return [...ids]
}
