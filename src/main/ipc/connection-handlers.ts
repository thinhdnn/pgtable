import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { Connection, ConnectionInput, IpcResult } from '@shared/types'
import {
  listConnections,
  addConnection,
  updateConnection,
  deleteConnection,
  getConnection
} from '../db/connection-store'
import { connectPool, disconnectPool, createPool } from '../pg/pool-manager'

export function registerConnectionHandlers(): void {
  ipcMain.handle(IPC.CONN_LIST, (): Connection[] => {
    return listConnections()
  })

  ipcMain.handle(IPC.CONN_ADD, (_e, input: ConnectionInput): IpcResult<{ id: string }> => {
    try {
      const conn = addConnection(input)
      return { ok: true, id: conn.id }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    IPC.CONN_UPDATE,
    (_e, payload: { id: string } & Partial<ConnectionInput>): IpcResult => {
      try {
        const { id, ...input } = payload
        updateConnection(id, input)
        return { ok: true }
      } catch (err) {
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(IPC.CONN_DELETE, async (_e, { id }: { id: string }): Promise<IpcResult> => {
    try {
      await disconnectPool(id)
      deleteConnection(id)
      return { ok: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(
    IPC.CONN_TEST,
    async (
      _e,
      input: ConnectionInput
    ): Promise<IpcResult<{ latency_ms: number }>> => {
      const start = Date.now()
      const pool = createPool(
        { id: '__test__', ...input, created_at: '', updated_at: '' },
        input.default_database
      )
      try {
        const client = await pool.connect()
        client.release()
        await pool.end()
        return { ok: true, latency_ms: Date.now() - start }
      } catch (err) {
        await pool.end().catch(() => {})
        return { error: String(err) }
      }
    }
  )

  ipcMain.handle(IPC.CONN_CONNECT, async (_e, { id }: { id: string }): Promise<IpcResult> => {
    try {
      const conn = getConnection(id)
      if (!conn) return { error: `Connection ${id} not found` }
      await connectPool(conn)
      return { ok: true }
    } catch (err) {
      return { error: String(err) }
    }
  })

  ipcMain.handle(IPC.CONN_DISCONNECT, async (_e, { id }: { id: string }): Promise<IpcResult> => {
    try {
      await disconnectPool(id)
      return { ok: true }
    } catch (err) {
      return { error: String(err) }
    }
  })
}
