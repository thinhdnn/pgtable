import type { Pool } from 'pg'

export async function query<T extends Record<string, unknown>>(
  pool: Pool,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await pool.query(sql, params)
  return result.rows as T[]
}

export async function queryOne<T extends Record<string, unknown>>(
  pool: Pool,
  sql: string,
  params: unknown[] = []
): Promise<T | undefined> {
  const rows = await query<T>(pool, sql, params)
  return rows[0]
}

export async function countEstimate(pool: Pool, schema: string, table: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    pool,
    `SELECT reltuples::bigint AS n FROM pg_class c
     JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = $1 AND c.relname = $2`,
    [schema, table]
  )
  return row ? parseInt(row.n, 10) : 0
}
