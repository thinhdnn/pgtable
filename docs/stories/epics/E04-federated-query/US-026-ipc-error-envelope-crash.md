# US-026 A failed db handler must not blank the app

## Status

in_progress

## Lane

normal

Risk flags: existing behavior (every `useDatabases.ts` hook changes its failure
contract), weak proof (nothing covered the renderer's IPC boundary). Two flags —
normal with stronger validation.

## Product Contract

Every handler in `db-handlers.ts` catches its own errors and **resolves** with
`{ error: string }`. It does not reject. The react-query hooks in
`useDatabases.ts` all declared the happy-path type (`invoke<string[]>`), so on
failure react-query put the envelope object into `data`.

Observed crash: opening a saved federated query whose connection is no longer
connected sets `row.connectionId` (by design — D3 flags a stale row rather than
blocking it), which enables `useDatabases(connectionId)`. `requirePool` throws
`Not connected`, the handler returns `{ error: 'Not connected' }`, and
`AttachRowEditor` runs `(dbs.data ?? []).map(...)` on it:

```
Uncaught TypeError: (dbs.data ?? []).map is not a function
    at AttachRowEditor (FederatedQueryTab.tsx:934)
```

The throw happens during render. The app has no error boundary, so React
unmounted the entire tree and the window went black — the `message.success`
toast from the completed `applySaved` was the only thing left on screen.

A handler failure must degrade to an empty control, never blank the app.

## Relevant Product Docs

- `docs/product/` — no federated-query doc exists yet.
- `docs/stories/epics/E04-federated-query/` — the saved-query Open path (D3)
  that surfaces this.

## Acceptance Criteria

- A hook in `useDatabases.ts` that receives `{ error }` leaves `data` as
  `undefined` and reports `isError`; it never hands the envelope to a consumer.
- Opening a saved federated query with a disconnected or deleted connection
  renders the row with its `disconnected` / `missing` tag and an empty Database
  select. The app stays up.
- A legitimate array result is never mistaken for an error envelope.
- `LinkedQueryTab`, which shares `useDatabases` / `useSchemas`, is fixed by the
  same change.

## Design Notes

- Commands: none.
- Queries: `invokeOrThrow` in `src/renderer/src/api.ts` rejects on the envelope
  so react-query routes it to `error`. All seven hooks in `useDatabases.ts` use
  it; none may call bare `invoke`.
- API: no IPC change. The handlers keep returning `{ error }` — call sites that
  deliberately branch on `'error' in res` (row update, export, query run) are
  untouched.
- Domain rules: `isErrorEnvelope` excludes arrays explicitly, so a `string[]`
  result can never be read as a failure.
- UI surfaces: none changed. The stale-row tags already existed.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | `src/renderer/src/api.test.ts`: envelope detected; arrays and `{rows,total_hint}` are not envelopes; `{ error: 500 }` is not; `invokeOrThrow` passes results through and rejects with the handler's message. |
| Integration | None (no DOM test environment; the hooks cannot be mounted). |
| E2E | None. |
| Platform | None. |
| Release | `npm run typecheck`, `npx vitest run`, `npm run build` exit 0. |

## Harness Delta

The app has **no React error boundary**. That is why a single bad `.map` blanked
the window instead of showing one broken pane. Fixing the envelope removes this
crash; it does not remove the class. An error boundary around the tab content is
proposed as follow-up work, not done here.

US-025 stays reserved for LinkedQueryTab troubleshoot (see
`.khuym/state.json` planning notes); this story took the next free id.
