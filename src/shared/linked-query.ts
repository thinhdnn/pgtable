// Shared linked-query helpers usable from both the renderer (to label the
// per-step auto-LIMIT toggle) and the main-process handler. Keep this
// dependency-free so it stays importable on both sides of the IPC boundary.

/** Safety cap on a step's result when the step's auto-LIMIT toggle is on.
 *
 * Numerically equal to `MAX_KEY_VALUES` in src/main/linked-query/executor.ts,
 * and that is not a coincidence: a step's rows can feed the next step's IN-list,
 * so capping below the keyset bound would silently drop downstream keys. Change
 * one and you must change the other — `linked-query.test.ts` guards the pair. */
export const LINKED_STEP_ROW_LIMIT = 5000

/**
 * True when any of `laterSqls` references step `stepNumber` through a
 * `:stepN.<col>` placeholder — i.e. this step's rows become a later step's
 * IN-list, which stays bounded by `MAX_KEY_VALUES` however the step's own
 * auto-LIMIT toggle is set.
 *
 * Drives tooltip copy only, so unlike the main-process rewriter this does not
 * strip comments or string literals first: a placeholder mentioned in a comment
 * yields a false positive, which costs a slightly over-cautious tooltip and
 * nothing else.
 */
export function feedsLaterStep(laterSqls: string[], stepNumber: number): boolean {
  // `\.` after the digits keeps `:step1.` from matching `:step10.`.
  const ref = new RegExp(`:step${stepNumber}\\.`)
  return laterSqls.some((sql) => ref.test(sql))
}
