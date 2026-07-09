# US-016 Per-step No limit toggle for Linked Query

## Status

in_progress

## Lane

normal

Risk flags: existing behavior (the step row cap is test-covered via
`executor.test.ts`), weak proof (no handler-level test exists for
`linked-query-handlers.ts`). Two flags — normal with stronger validation.

## Product Contract

The Federated Query tab and the SQL editor already default their auto-LIMIT
safety net off, so a run returns every row. A Linked Query step cannot: it
appends `LIMIT 5000` unconditionally and offers no way out.

A step must be able to run with no row cap, chosen per step.

The cap is not purely cosmetic on a step whose keys feed a later step. The
rewriter emits one bind parameter per key value, and the Postgres wire protocol
caps a statement at 65535 bind parameters. `MAX_KEY_VALUES` (5000) therefore
stays enforced on any keyset a placeholder consumes. Turning a step's cap off and
then referencing it downstream must fail loudly with `TOO_MANY_KEYS`, never
truncate silently.

## Relevant Product Docs

- `docs/product/` — no linked-query doc exists yet; behavior is defined here and
  in `src/main/linked-query/executor.ts`.

## Acceptance Criteria

- Each Linked Query step carries its own auto-LIMIT toggle, defaulting on.
- With the toggle on, a bare SELECT still gets `LIMIT 5000` appended and the
  result is badged `auto LIMIT`.
- With the toggle off, no LIMIT is appended and the step returns every row.
- A step whose result feeds a later step's `:stepN.<col>` placeholder is still
  bounded by `MAX_KEY_VALUES`; over the bound the later step returns a
  `TOO_MANY_KEYS` error.
- A user-written explicit `LIMIT` is never overridden, either way.
- The federated `autoLimit` doc comments describe actual behavior: the UI
  defaults the net off; the IPC boundary keeps it on when the field is absent.

## Design Notes

- Commands: none.
- Queries: `applyAutoLimit(sql, LINKED_STEP_ROW_LIMIT)` becomes conditional on
  the payload's `autoLimit`.
- API: `LinkedStepRunPayload` gains `autoLimit: boolean`. The handler keeps a
  defensive `?? true` so an older caller that omits it gets the safety net.
- Tables: none.
- Domain rules: `LINKED_STEP_ROW_LIMIT` moves to `src/shared/linked-query.ts` so
  the renderer can label the toggle without importing main-process code. It
  stays numerically equal to `MAX_KEY_VALUES` and the coupling is documented at
  both sites.
- UI surfaces: a clickable `Limit 5000` / `No limit` tag in each step's Collapse
  `extra`, mirroring `QueryEditor` and `FederatedQueryTab`.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | `applyAutoLimit` skipped when `autoLimit` is false; applied when true; explicit LIMIT untouched. `checkKeyBounds` still rejects >5000 keys. |
| Integration | Not added — the handler needs a live pool; covered by the executor unit tests plus manual UAT. |
| E2E | Not added. |
| Platform | N/A. |
| Release | N/A. |

## Harness Delta

None.

## Evidence

Filled in after validation runs.
