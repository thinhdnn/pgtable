import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { FederatedRunPayload, FederatedRunOutcome } from '@shared/types'
import { runFederatedQuery, FederatedRunError } from '../duck/duck-runner'

export function registerFederatedHandlers(): void {
  // Run one SQL statement across the attached Postgres databases via DuckDB.
  // Validation and attach happen in the runner; expected input problems arrive
  // as FederatedRunError (mapped to the `{ error }` envelope), everything else
  // is stringified so the renderer always gets a message.
  ipcMain.handle(
    IPC.FEDERATED_RUN,
    async (_e, { attachments, sql, autoLimit }: FederatedRunPayload): Promise<FederatedRunOutcome> => {
      try {
        return await runFederatedQuery(attachments ?? [], sql, autoLimit ?? true)
      } catch (err) {
        if (err instanceof FederatedRunError) return { error: err.message }
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
