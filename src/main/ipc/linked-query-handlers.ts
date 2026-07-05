import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { LinkedStepRunPayload, LinkedStepRunOutcome } from '@shared/types'
import { getConnection } from '../db/connection-store'
import { getOrCreatePool, isConnected } from '../pg/pool-manager'
import {
  isReadOnlyStatement,
  applyAutoLimit,
  rewritePlaceholders,
  LinkedRewriteError,
  type RewriteResult
} from '../linked-query/executor'

/** Row cap on any step's result. A step's rows can feed the next step's IN-list,
 * so the cap aligns with MAX_KEY_VALUES (5000) rather than a smaller preview
 * limit — truncating below that would silently drop downstream keys. Users can
 * override by writing their own LIMIT. */
const STEP_ROW_LIMIT = 5000

function requirePool(connectionId: string, database: string) {
  const conn = getConnection(connectionId)
  if (!conn) throw new Error(`Connection ${connectionId} not found`)
  if (!isConnected(connectionId)) throw new Error(`Not connected`)
  return getOrCreatePool(conn, database)
}

export function registerLinkedQueryHandlers(): void {
  // Run one step of the linear chain: whitelist the SQL, rewrite every
  // `:stepN.<col>` against the upstream result sets, bound the keysets, and
  // execute. Step 1 (and any step with no placeholder) runs as a plain
  // read-only query. The D4 empty-keyset path skips the pg call entirely.
  ipcMain.handle(
    IPC.LINKED_STEP_RUN,
    async (
      _e,
      { connectionId, database, sql, stepIndex, upstream }: LinkedStepRunPayload
    ): Promise<LinkedStepRunOutcome | { error: string }> => {
      try {
        if (!sql.trim()) return { error: `Step ${stepIndex} SQL is empty` }
        if (!isReadOnlyStatement(sql)) {
          return {
            error: `Step ${stepIndex} SQL must be a read-only SELECT or WITH statement — DML/DDL is not allowed`
          }
        }

        // Rewrite `:stepN.<col>` placeholders to parameterised IN-lists. A step
        // with no placeholder (Step 1, or an exploratory step) is allowed: it
        // runs as a plain read-only query so users can inspect columns before
        // wiring up the link.
        let rewritten: RewriteResult
        try {
          rewritten = rewritePlaceholders(sql, stepIndex, upstream ?? {})
        } catch (err) {
          if (err instanceof LinkedRewriteError && err.code === 'NO_PLACEHOLDER') {
            rewritten = { sql, params: [], usedColumns: [], emptyKeyset: false }
          } else if (err instanceof LinkedRewriteError) {
            return { error: err.message }
          } else {
            throw err
          }
        }

        // A referenced upstream keyset collapsed to zero (null-drop or empty
        // source) — skip the pg call per D4.
        if (rewritten.emptyKeyset) {
          return { skipped: true, reason: 'EMPTY_KEYSET' }
        }

        const { sql: capped, appended } = applyAutoLimit(rewritten.sql, STEP_ROW_LIMIT)

        const pool = requirePool(connectionId, database)
        const started = Date.now()
        const result = await pool.query(capped, rewritten.params)
        const durationMs = Date.now() - started

        return {
          rows: result.rows as Record<string, unknown>[],
          fields: result.fields.map((f) => f.name),
          rowCount: result.rowCount ?? result.rows.length,
          durationMs,
          autoLimited: appended
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
