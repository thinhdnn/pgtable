import { describe, it, expect, vi, afterEach } from 'vitest'
import { isErrorEnvelope, invokeOrThrow } from './api'
import { IPC } from '@shared/ipc-channels'

// Stand in for the preload bridge. `invoke` reads `window.pgtable` at call time,
// so a plain global is enough under the node environment.
function stubBridge(result: unknown): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    pgtable: { invoke: vi.fn().mockResolvedValue(result) }
  }
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('isErrorEnvelope', () => {
  it('recognises a handler failure envelope', () => {
    expect(isErrorEnvelope({ error: 'Not connected' })).toBe(true)
  })

  // The bug this guard exists for: db:list answers `{ error }` on a
  // disconnected connection, and the caller does `(data ?? []).map(...)`.
  it('never mistakes a legitimate array result for an envelope', () => {
    expect(isErrorEnvelope([])).toBe(false)
    expect(isErrorEnvelope(['postgres', 'app'])).toBe(false)
  })

  it('rejects non-envelope objects and primitives', () => {
    expect(isErrorEnvelope({ rows: [], total_hint: 0 })).toBe(false)
    // A non-string `error` is not the envelope the handlers produce.
    expect(isErrorEnvelope({ error: 500 })).toBe(false)
    expect(isErrorEnvelope(null)).toBe(false)
    expect(isErrorEnvelope(undefined)).toBe(false)
    expect(isErrorEnvelope('error')).toBe(false)
  })
})

describe('invokeOrThrow', () => {
  it('returns an array result untouched', async () => {
    stubBridge(['postgres', 'app'])
    await expect(invokeOrThrow<string[]>(IPC.DB_LIST, { connectionId: 'c1' })).resolves.toEqual([
      'postgres',
      'app'
    ])
  })

  it('returns a non-array result untouched', async () => {
    stubBridge({ rows: [], total_hint: 0 })
    await expect(invokeOrThrow(IPC.TABLE_DATA, {})).resolves.toEqual({ rows: [], total_hint: 0 })
  })

  // Rejecting is what keeps the envelope out of react-query's `data`, which is
  // what kept `.map is not a function` from unmounting the whole React tree.
  it('rejects with the handler message when the call answers an envelope', async () => {
    stubBridge({ error: 'Not connected' })
    await expect(invokeOrThrow<string[]>(IPC.DB_LIST, { connectionId: 'c1' })).rejects.toThrow(
      'Not connected'
    )
  })
})
