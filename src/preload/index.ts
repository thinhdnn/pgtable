import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannel } from '@shared/ipc-channels'

contextBridge.exposeInMainWorld('pgtable', {
  invoke: (channel: IpcChannel, payload?: unknown) => ipcRenderer.invoke(channel, payload),
  platform: process.platform,
  setTitleBarOverlay: (dark: boolean) => ipcRenderer.invoke('window:set-overlay', dark)
})
