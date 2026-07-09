import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  beginRun,
  endRun,
  cancelRun,
  throwIfCancelled,
  inFlightCount,
  FederatedCancelledError,
  type Interruptible,
  type RunHandle
} from './run-registry'

/** Stand-in for DuckDBConnection: the registry only ever calls `interrupt`. */
function fakeConnection() {
  return { interrupt: vi.fn<() => void>() } satisfies Interruptible
}

// The registry is module-level state. Every test releases what it registered so
// leaks in one test cannot mask a leak assertion in another.
const opened: Array<[string, RunHandle]> = []
function open(runId: string): RunHandle {
  const handle = beginRun(runId)
  opened.push([runId, handle])
  return handle
}
afterEach(() => {
  for (const [runId, handle] of opened) endRun(runId, handle)
  opened.length = 0
  expect(inFlightCount()).toBe(0)
})

describe('beginRun / endRun', () => {
  it('registers and releases a run', () => {
    const handle = beginRun('a')
    expect(inFlightCount()).toBe(1)
    endRun('a', handle)
    expect(inFlightCount()).toBe(0)
  })

  it('rejects a duplicate runId rather than clobbering the live entry', () => {
    const handle = open('dup')
    expect(() => beginRun('dup')).toThrow(/already in flight/)
    // The original is untouched and still cancellable.
    expect(cancelRun('dup')).toBe(true)
    expect(handle.cancelled).toBe(true)
  })

  it('ignores an endRun carrying a handle that is no longer registered', () => {
    const first = beginRun('reused')
    endRun('reused', first)
    const second = open('reused')
    // A late release from the finished run must not evict the live one.
    endRun('reused', first)
    expect(inFlightCount()).toBe(1)
    expect(cancelRun('reused')).toBe(true)
    expect(second.cancelled).toBe(true)
  })
})

describe('cancelRun', () => {
  it('arms the flag and interrupts the bound connection', () => {
    const handle = open('r')
    const conn = fakeConnection()
    handle.connection = conn

    expect(cancelRun('r')).toBe(true)
    expect(handle.cancelled).toBe(true)
    expect(conn.interrupt).toHaveBeenCalledTimes(1)
  })

  it('arms the flag even before a connection exists', () => {
    // The window between `beginRun` and `DuckDBInstance.create` resolving. There
    // is nothing to interrupt, so only the flag can carry the cancel forward.
    const handle = open('early')
    expect(cancelRun('early')).toBe(true)
    expect(handle.cancelled).toBe(true)
    expect(() => throwIfCancelled(handle)).toThrow(FederatedCancelledError)
  })

  it('returns false for a run that already ended', () => {
    const handle = beginRun('done')
    endRun('done', handle)
    expect(cancelRun('done')).toBe(false)
  })

  it('returns false for an unknown runId', () => {
    expect(cancelRun('never-existed')).toBe(false)
  })

  it('leaves other in-flight runs alone', () => {
    const a = open('a')
    const b = open('b')
    const connA = fakeConnection()
    const connB = fakeConnection()
    a.connection = connA
    b.connection = connB

    cancelRun('a')

    expect(a.cancelled).toBe(true)
    expect(connA.interrupt).toHaveBeenCalledTimes(1)
    expect(b.cancelled).toBe(false)
    expect(connB.interrupt).not.toHaveBeenCalled()
  })
})

describe('throwIfCancelled', () => {
  it('is a no-op while the run is live', () => {
    const handle = open('live')
    expect(() => throwIfCancelled(handle)).not.toThrow()
  })

  it('throws FederatedCancelledError once cancelled', () => {
    const handle = open('stopped')
    handle.connection = fakeConnection()
    cancelRun('stopped')
    expect(() => throwIfCancelled(handle)).toThrow(FederatedCancelledError)
  })
})
