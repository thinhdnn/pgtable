# US-023 Cancel a running federated query

## Status

in_progress

## Lane

normal

Risk flags: public contracts (`FederatedRunPayload` gains `runId`,
`FederatedRunOutcome` widens, a new `federated:cancel` channel appears), existing
behavior (every federated run now flows through a cancellation registry), weak
proof (no test covers `duck-runner.ts` at all). Three flags — normal with
stronger validation.

## Product Contract

A federated run has no exit. `runFederatedQuery` copies whole tables out of
Postgres into DuckDB whenever the postgres scanner cannot push a filter down, so
a query over an unfiltered large table can run for many minutes. The tab tracks
`running` but exposes no way to stop; the only escape is to quit the app.

A user must be able to stop an in-flight federated run and get the tab back,
without killing the app and without seeing the abort reported as a query error.

## Relevant Product Docs

- `docs/product/` — no federated-query doc exists yet; behavior is defined here
  and in `src/main/duck/duck-runner.ts`.

## Acceptance Criteria

- While a federated run is in flight the toolbar shows a Stop button; pressing it
  ends the run.
- A cancelled run leaves the tab idle with an informational notice — not the red
  error alert, and not a stale result from the previous run.
- A cancel that lands between two internal statements (ATTACH, SET search_path)
  still stops the run rather than waiting for the main query to begin.
- A cancel for a run that already finished is a no-op and reports that nothing
  was cancelled.
- Two concurrent runs are independently cancellable; cancelling one never
  interrupts the other.
- Every run releases its registry entry, whether it succeeded, failed validation,
  errored inside DuckDB, or was cancelled.
- The DuckDB instance is closed when a run ends. It previously leaked one
  in-memory instance per run, contrary to the file's own header comment.

## Design Notes

- Commands: `cancelRun(runId)` interrupts the DuckDB connection bound to that run.
- Queries: unchanged. Cancellation does not alter the SQL that gets executed.
- API: `FederatedRunPayload` gains `runId: string`; a run reports abort as
  `{ cancelled: true }` rather than `{ error }`. New channel `federated:cancel`
  takes `{ runId }` and answers `{ cancelled: boolean }` — `false` means the run
  had already ended.
- Tables: none.
- Domain rules: cancellation state lives in `src/main/duck/run-registry.ts`, a
  DuckDB-free module keyed by `runId`. `DuckDBConnection.interrupt()` only aborts
  a statement that is *currently* executing, so the registry also carries a
  `cancelled` flag that the runner checks at each `await` boundary. Without that
  flag a cancel arriving during `INSTALL postgres` or `ATTACH` would be lost.
- UI surfaces: a danger-styled Stop button in `FederatedQueryTab`, rendered only
  while `running`.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | `run-registry.test.ts`: cancel sets the flag and calls `interrupt()`; cancel before a connection is attached still arms the flag; `throwIfCancelled` throws only when armed; cancel of an unknown/ended run returns false; `endRun` releases; concurrent runs are isolated; a duplicate `runId` is rejected. |
| Integration | Not added — exercising `duck-runner.ts` needs a live Postgres and the DuckDB postgres extension. Covered by the registry unit tests plus manual UAT. |
| E2E | Not added. |
| Platform | N/A. |
| Release | N/A. |

## Harness Delta

None.

## Evidence

Filled in after validation runs.
