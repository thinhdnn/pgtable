// Cancellation registry for in-flight federated runs, keyed by the `runId` the
// renderer mints per Run press.
//
// Deliberately free of `@duckdb/node-api` so it stays unit-testable without a
// DuckDB engine — the runner passes in anything that can `interrupt()`.
//
// Two mechanisms, because one is not enough. `interrupt()` aborts the statement
// a connection is executing *right now*; a cancel that lands while the runner is
// between statements (during `INSTALL postgres`, an `ATTACH`, or before the
// connection exists at all) would interrupt nothing and be silently lost. So the
// handle also carries a `cancelled` flag that the runner re-checks at every
// `await` boundary via `throwIfCancelled`.

/** The slice of `DuckDBConnection` this module needs. Structural, so tests can
 * pass a spy and the runner can pass the real connection. */
export interface Interruptible {
  interrupt(): void
}

/** Thrown by `throwIfCancelled`, and by the runner when a DuckDB error turns out
 * to be the fallout of an `interrupt()` we asked for. The handler maps it to
 * `{ cancelled: true }` so the tab reports an abort, not a query failure. */
export class FederatedCancelledError extends Error {
  constructor() {
    super('Federated query cancelled')
    this.name = 'FederatedCancelledError'
  }
}

export interface RunHandle {
  /** Bound once the DuckDB connection exists; null before that. */
  connection: Interruptible | null
  cancelled: boolean
}

const inFlight = new Map<string, RunHandle>()

/**
 * Registers `runId` and returns its handle. Throws on a duplicate id rather than
 * clobbering the live entry — `endRun` would otherwise release the wrong run and
 * leave the other uncancellable.
 */
export function beginRun(runId: string): RunHandle {
  if (inFlight.has(runId)) throw new Error(`Federated run "${runId}" is already in flight`)
  const handle: RunHandle = { connection: null, cancelled: false }
  inFlight.set(runId, handle)
  return handle
}

/**
 * Releases `runId`, but only if `handle` is still the registered one. The guard
 * makes a late `endRun` from a superseded run harmless.
 */
export function endRun(runId: string, handle: RunHandle): void {
  if (inFlight.get(runId) === handle) inFlight.delete(runId)
}

/**
 * Arms the cancel flag and interrupts the run's connection if it has one.
 * Returns false when `runId` is unknown — the run already ended, and there is
 * nothing to stop.
 */
export function cancelRun(runId: string): boolean {
  const handle = inFlight.get(runId)
  if (!handle) return false
  handle.cancelled = true
  // No-op when the connection is idle between statements; the flag covers that.
  handle.connection?.interrupt()
  return true
}

export function throwIfCancelled(handle: RunHandle): void {
  if (handle.cancelled) throw new FederatedCancelledError()
}

/** Test-only view of registry size, so leaks are assertable. */
export function inFlightCount(): number {
  return inFlight.size
}
