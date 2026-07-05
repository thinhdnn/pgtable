import type { IpcChannel } from '@shared/ipc-channels'

declare global {
  interface Window {
    pgtable: {
      invoke: (channel: IpcChannel, payload?: unknown) => Promise<unknown>
      platform: NodeJS.Platform
      setTitleBarOverlay: (dark: boolean) => Promise<void>
    }
  }
}

export function invoke<T>(channel: IpcChannel, payload?: unknown): Promise<T> {
  return window.pgtable.invoke(channel, payload) as Promise<T>
}
