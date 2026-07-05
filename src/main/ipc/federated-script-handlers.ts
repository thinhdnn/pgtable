import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { SavedFederatedQuery, SavedFederatedQueryInput, IpcResult } from '@shared/types'
import {
  listFederatedQueries,
  saveFederatedQuery,
  deleteFederatedQuery
} from '../db/federated-script-store'

export function registerFederatedScriptHandlers(): void {
  // Full records incl. attachments + SQL + autoLimit — Open is a renderer-only
  // action (the tab owns its own state; Open just hydrates it).
  ipcMain.handle(IPC.FEDERATED_SCRIPT_LIST, (): SavedFederatedQuery[] => {
    return listFederatedQueries()
  })

  ipcMain.handle(
    IPC.FEDERATED_SCRIPT_SAVE,
    (_e, input: SavedFederatedQueryInput): IpcResult<{ id: string }> => {
      try {
        const result = saveFederatedQuery(input)
        // Name collision without an overwrite confirmation — let the renderer
        // prompt Overwrite / Rename (D4).
        if (!result.ok) return { error: 'NAME_EXISTS' }
        return { ok: true, id: result.query.id }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(IPC.FEDERATED_SCRIPT_DELETE, (_e, { id }: { id: string }): IpcResult => {
    try {
      deleteFederatedQuery(id)
      return { ok: true }
    } catch (err) {
      return { error: String(err) }
    }
  })
}
