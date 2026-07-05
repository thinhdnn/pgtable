# 0009 Linked Query N-step linear chain

Date: 2026-07-02

## Status

Accepted

## Context

Linked Query shipped as a fixed two-step pipeline (Step 1 source → Step 2
lookup), encoded by two IPC channels (`LINKED_STEP_RUN` preview,
`LINKED_FINAL_RUN` rewrite) and a rewriter that only accepted `:step1.<col>`
matched against a single selected key column (decisions D1–D5 in
`history/linked-query/CONTEXT.md`). Users asked to chain more than two steps —
run a SELECT, key a second SELECT off it, then key a third off either earlier
result, across possibly different (connection, database) pairs.

This changes an accepted feature's IPC shape and placeholder contract, so it is
recorded as a durable decision (D6).

## Decision

Generalise Linked Query to an **N-step linear chain**:

- **Chaining is linear.** Step K becomes runnable only once every earlier step
  has produced a result (extends the D1 iterative flow). A step may reference
  any earlier step, never itself or a later one.
- **Placeholder syntax is unchanged and backward compatible:** `:stepN.<col>`,
  1-based. A step's SQL may reference multiple earlier steps and multiple
  columns; repeated references to the same `stepN.col` reuse the same params.
- **The key-column dropdown is removed.** Bridging is free-form: the renderer
  ships every earlier step's full result set as `upstream`, and the main-side
  rewriter extracts whichever columns the SQL references. A helper select
  inserts `:stepN.col` tokens.
- **IPC collapses to a single channel.** `LINKED_STEP_RUN` runs any step;
  `LINKED_FINAL_RUN` is removed. Payload gains `stepIndex` (1-based) and
  `upstream: Record<number, {fields, rows}>`; `keyColumn`/`keyValues` are gone.
- **Add/remove operate on the tail only,** so `:stepN` numbering stays stable
  for placeholders the user already wrote.
- D2 bound (`MAX_KEY_VALUES` = 5000) is applied per referenced column; D4
  empty-keyset short-circuit fires when any referenced column resolves to zero
  values. Every step's rows are capped at 5000 (aligned with the bound, since a
  step's rows can feed the next step's IN-list).

## Alternatives Considered

1. **Free DAG** (a step runs as soon as the steps it actually references are
   ready). Rejected for v1: requires parsing placeholders to compute
   enablement, more UI/edge-case surface, no clear demand over the linear model.
2. **Keep per-step key-column dropdown.** Rejected: limits a step to one source
   column and does not express references to multiple earlier steps.
3. **Keep two channels, add a third for middle steps.** Rejected: middle steps
   both consume and produce keys, so the preview/final split no longer holds.

## Consequences

Positive:

- Arbitrary-length pipelines; each step can join keys from several ancestors.
- Simpler main process — one code path instead of preview vs. final.
- `:step1.<col>` definitions keep working unchanged.

Tradeoffs:

- Renderer holds every step's result set in memory (still VQ2: renderer-only,
  no persistence, no main-side cache).
- Positional `:stepN` numbering means tail-only add/remove; reordering or
  deleting a middle step is intentionally not offered in v1.

## Follow-Up

- Composite/multi-column keys as a single reference remain deferred (D2 v1).
- Consider cursor-aware placeholder insertion (current helper appends the token).
