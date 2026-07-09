import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc-channels'
import type {
  FederatedRunPayload,
  FederatedRunOutcome,
  FederatedCancelPayload,
  FederatedCancelOutcome
} from '@shared/types'
import {
  runFederatedQuery,
  cancelRun,
  FederatedRunError,
  FederatedCancelledError
} from '../duck/duck-runner'

export function registerFederatedHandlers(): void {
  // Run one SQL statement across the attached Postgres databases via DuckDB.
  // Validation and attach happen in the runner; expected input problems arrive
  // as FederatedRunError (mapped to the `{ error }` envelope), everything else
  // is stringified so the renderer always gets a message.
  ipcMain.handle(
    IPC.FEDERATED_RUN,
    async (
      _e,
      { attachments, sql, autoLimit, runId }: FederatedRunPayload
    ): Promise<FederatedRunOutcome> => {
      try {
        // The tab defaults autoLimit off and always sends an explicit value, so
        // `?? true` only fires for a caller that omits the field. Such a caller
        // gets the safety net rather than an uncapped scan.
        //
        // A caller that omits `runId` gets a synthetic one: the run still needs a
        // registry key to release, it is simply uncancellable because nobody else
        // knows the id.
        return await runFederatedQuery(
          attachments ?? [],
          sql,
          autoLimit ?? true,
          runId ?? randomUUID()
        )
      } catch (err) {
        // Ordered: a cancelled run is not a failure, so it must be caught before
        // the generic envelopes turn it into an error alert.
        if (err instanceof FederatedCancelledError) return { cancelled: true }
        if (err instanceof FederatedRunError) return { error: err.message }
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Stop an in-flight run. Never throws: an unknown `runId` is the ordinary race
  // where the run finished first, reported as `{ cancelled: false }`.
  ipcMain.handle(
    IPC.FEDERATED_CANCEL,
    async (_e, { runId }: FederatedCancelPayload): Promise<FederatedCancelOutcome> => ({
      cancelled: runId ? cancelRun(runId) : false
    })
  )
}
