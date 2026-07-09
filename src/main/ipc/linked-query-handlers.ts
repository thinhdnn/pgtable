import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { LinkedStepRunPayload, LinkedStepRunOutcome } from '@shared/types'
import { getConnection } from '../db/connection-store'
import { getOrCreatePool, isConnected } from '../pg/pool-manager'
import { LINKED_STEP_ROW_LIMIT } from '@shared/linked-query'
import {
  isReadOnlyStatement,
  applyAutoLimit,
  rewritePlaceholders,
  LinkedRewriteError,
  type RewriteResult
} from '../linked-query/executor'

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
      { connectionId, database, sql, stepIndex, upstream, autoLimit }: LinkedStepRunPayload
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

        // Per-step safety net. Off means "return every row" — it does not lift
        // MAX_KEY_VALUES: rewritePlaceholders() above already bounded whatever
        // keyset this step's placeholders consumed, so an oversized upstream
        // fails loudly with TOO_MANY_KEYS instead of running on truncated keys.
        // A payload missing the field is an older caller — give it the net.
        const armed = autoLimit ?? true
        const { sql: capped, appended } = armed
          ? applyAutoLimit(rewritten.sql, LINKED_STEP_ROW_LIMIT)
          : { sql: rewritten.sql, appended: false }

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
