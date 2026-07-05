import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { SavedScript, SavedScriptInput, IpcResult } from '@shared/types'
import { listScripts, saveScript, deleteScript } from '../db/script-store'

export function registerScriptHandlers(): void {
  // Full records incl. SQL — Open is a renderer-only action (D6).
  ipcMain.handle(IPC.SCRIPT_LIST, (): SavedScript[] => {
    return listScripts()
  })

  ipcMain.handle(IPC.SCRIPT_SAVE, (_e, input: SavedScriptInput): IpcResult<{ id: string }> => {
    try {
      const result = saveScript(input)
      // Name collision without an overwrite confirmation — let the renderer
      // prompt Overwrite / Rename (D3).
      if (!result.ok) return { error: 'NAME_EXISTS' }
      return { ok: true, id: result.script.id }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(IPC.SCRIPT_DELETE, (_e, { id }: { id: string }): IpcResult => {
    try {
      deleteScript(id)
      return { ok: true }
    } catch (err) {
      return { error: String(err) }
    }
  })
}
