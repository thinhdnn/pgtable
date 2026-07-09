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

/**
 * True when a handler answered with its failure envelope rather than a result.
 * Every handler in `db-handlers.ts` catches and returns `{ error: string }`, so
 * a failed call RESOLVES — it does not reject. Callers that render the result
 * directly therefore receive an object where their type promised an array.
 *
 * Arrays are excluded explicitly: a legitimate `string[]` result must never be
 * mistaken for an envelope.
 */
export function isErrorEnvelope(res: unknown): res is { error: string } {
  return (
    !!res &&
    typeof res === 'object' &&
    !Array.isArray(res) &&
    typeof (res as { error?: unknown }).error === 'string'
  )
}

/**
 * `invoke`, but a failure envelope becomes a rejection.
 *
 * Use this from react-query hooks. It is the difference between the failure
 * landing in the query's `error` state (`data` stays `undefined`, the component
 * renders its empty case) and the envelope object reaching the component as
 * `data` — where the first `.map()` throws mid-render and takes the whole React
 * tree down with it, since the app has no error boundary.
 */
export async function invokeOrThrow<T>(channel: IpcChannel, payload?: unknown): Promise<T> {
  const res = await invoke<T | { error: string }>(channel, payload)
  if (isErrorEnvelope(res)) throw new Error(res.error)
  return res as T
}
