// Linked-query executor: pure functions with no `pg`, no React, no IPC.
// CONTEXT decisions: D2 (single-column key, :step1.<col> → parameterised
// IN($1..$n)), D4 (empty keyset short-circuit). Validation constraints:
// C1 (SELECT/WITH only, no TABLE/VALUES), C2 (scan sanitised copy, splice
// original), C4 (unit-testable in isolation).

// Wire types live in `@shared/types` so the renderer can import them without
// pulling in main-only code. Re-exported here for convenience of nearby
// handler code.
export type {
  LinkedStepRunPayload,
  LinkedStepRunResult,
  LinkedStepRunOutcome,
  LinkedUpstreamResult,
  LinkedUpstreamResults
} from '@shared/types'

import { stripCommentsAndStrings } from '@shared/sql-statement'

/** Discriminator codes for LinkedRewriteError so handlers can map to user copy
 * without string-matching messages. */
export type LinkedRewriteCode =
  | 'UNKNOWN_STEP'
  | 'UNKNOWN_COL'
  | 'NO_PLACEHOLDER'
  | 'TOO_MANY_KEYS'

export class LinkedRewriteError extends Error {
  code: LinkedRewriteCode
  constructor(code: LinkedRewriteCode, message: string) {
    super(message)
    this.name = 'LinkedRewriteError'
    this.code = code
  }
}

// The sanitiser now lives in `@shared/sql-statement` so the renderer can use it
// too. Re-exported here because `executor.test.ts` and the rewriter below have
// always reached for it under this name.
export { stripCommentsAndStrings }

// Read-only guard for Step SQL. Narrowed to SELECT / WITH per constraint C1 —
// TABLE and VALUES are legal on their own but rare in this feature and
// broaden the accept surface without benefit. Strips comments/strings first
// so a keyword hidden in text can't fool the classifier.
//
// NOT the same as `isNonMutatingStatement` in `@shared/sql-statement`, which
// accepts TABLE/VALUES because they read data. That one decides whether to warn
// a user; this one decides what the runner will execute at all. Widening this to
// match it would loosen the guard `duck-runner.ts` depends on.
export function isReadOnlyStatement(sql: string): boolean {
  const sanitized = stripCommentsAndStrings(sql.replace(/;\s*$/, '').trim()).trim()
  return /^(SELECT|WITH)\b/i.test(sanitized)
}

// Appends `LIMIT n` to a bare SELECT so a user can't accidentally pull ten
// million rows. Copied from src/renderer/src/components/query/QueryEditor.tsx
// and kept in sync — the renderer copy stays for now to avoid touching
// unrelated stories.
export function applyAutoLimit(
  raw: string,
  limit: number
): { sql: string; appended: boolean } {
  const trimmed = raw.replace(/;\s*$/, '').replace(/\s+$/, '')
  if (!trimmed) return { sql: raw, appended: false }
  const sanitized = stripCommentsAndStrings(trimmed).trim()
  const lead = sanitized.slice(0, 16).toUpperCase()
  const isSelect = /^(SELECT|WITH|TABLE|VALUES)\b/.test(lead)
  if (!isSelect) return { sql: raw, appended: false }
  if (/\blimit\b/i.test(sanitized)) return { sql: raw, appended: false }
  if (/\bfetch\s+(first|next)\b/i.test(sanitized)) return { sql: raw, appended: false }
  return { sql: `${trimmed}\nLIMIT ${limit};`, appended: true }
}

/** Hard upper bound on the Step 1 → Step 2 IN-list size (CONTEXT D2). */
export const MAX_KEY_VALUES = 5000

export type KeyBoundsResult = { ok: true } | { ok: false; message: string }

export function checkKeyBounds(
  keyValues: unknown[],
  max: number = MAX_KEY_VALUES
): KeyBoundsResult {
  if (keyValues.length > max) {
    return {
      ok: false,
      message: `Step 1 returned ${keyValues.length} rows — narrow it below ${max} keys`
    }
  }
  return { ok: true }
}

export type RewriteResult = {
  sql: string
  params: unknown[]
  /** Distinct `stepN.col` references that were substituted (echoed for logging). */
  usedColumns: string[]
  /** True when null-drop or an empty upstream keyset collapsed a referenced
   * column to zero values. The handler should follow D4 (skip pg call) when
   * this is set. */
  emptyKeyset: boolean
}

/** One upstream step's result set, as seen by the placeholder rewriter. */
export type UpstreamStepResult = { fields: string[]; rows: Record<string, unknown>[] }

/** Result sets of already-run earlier steps, keyed by 1-based step number. */
export type UpstreamResults = Record<number, UpstreamStepResult>

// Regex for `:stepN.<ident>` tokens, run on the sanitised copy so it can't
// match tokens embedded inside string literals or comments.
const PLACEHOLDER_RE = /:step(\d+)\.([A-Za-z_][A-Za-z0-9_]*)/g

/** Non-null values of `col` across `rows`, preserving order (VQ4 null-drop). */
function pickColumn(rows: Record<string, unknown>[], col: string): unknown[] {
  const out: unknown[] = []
  for (const r of rows) {
    const v = r[col]
    if (v === null || v === undefined) continue
    out.push(v)
  }
  return out
}

/**
 * Rewrites every `:stepN.<col>` in a step's SQL to a parameter list
 * `$k, ..., $m` (the caller supplies the surrounding `IN (...)`) and returns the
 * SQL alongside the accumulated parameter array. Generalises the v0 two-step
 * rule to an N-step linear chain. Constraints:
 *
 * - Detection runs on the sanitised copy (C2), but the splice happens on the
 *   *original* SQL so the caller's whitespace/comments/casing survive.
 * - A step may only reference *earlier* steps: `1 ≤ N < currentStep` (D6). A
 *   forward/self reference or an unknown column throws `LinkedRewriteError`.
 * - `null` values are dropped silently (VQ4). Postgres `IN` never matches
 *   `NULL`, so dropping is observationally equivalent.
 * - Repeated references to the same `stepN.col` reuse the same `$k` params.
 * - If any referenced column resolves to zero values, returns
 *   `emptyKeyset: true` with untouched SQL; the caller short-circuits the pg
 *   call per D4.
 */
export function rewritePlaceholders(
  sql: string,
  currentStep: number,
  upstream: UpstreamResults
): RewriteResult {
  const sanitized = stripCommentsAndStrings(sql)
  const tokens: Array<{ start: number; end: number; step: number; col: string }> = []
  let m: RegExpExecArray | null
  PLACEHOLDER_RE.lastIndex = 0
  while ((m = PLACEHOLDER_RE.exec(sanitized)) !== null) {
    const step = parseInt(m[1], 10)
    const col = m[2]
    if (step < 1 || step >= currentStep) {
      throw new LinkedRewriteError(
        'UNKNOWN_STEP',
        `Placeholder :step${step}.${col} — Step ${currentStep} can only reference earlier steps (:step1..:step${currentStep - 1})`
      )
    }
    const up = upstream[step]
    if (!up) {
      throw new LinkedRewriteError(
        'UNKNOWN_STEP',
        `Placeholder :step${step}.${col} — Step ${step} has not produced a result yet`
      )
    }
    if (!up.fields.includes(col)) {
      throw new LinkedRewriteError(
        'UNKNOWN_COL',
        `Placeholder :step${step}.${col} — column "${col}" is not in Step ${step}'s result`
      )
    }
    tokens.push({ start: m.index, end: m.index + m[0].length, step, col })
  }

  if (tokens.length === 0) {
    throw new LinkedRewriteError(
      'NO_PLACEHOLDER',
      `Step ${currentStep} SQL contains no :stepN.<col> placeholder`
    )
  }

  // Resolve each distinct (step, col) once: null-drop (VQ4) and bound each list
  // (D2). Keyed by `stepN.col` so repeated references share one param list.
  const values = new Map<string, unknown[]>()
  for (const t of tokens) {
    const key = `step${t.step}.${t.col}`
    if (values.has(key)) continue
    const vals = pickColumn(upstream[t.step].rows, t.col)
    const bounds = checkKeyBounds(vals)
    if (!bounds.ok) throw new LinkedRewriteError('TOO_MANY_KEYS', bounds.message)
    values.set(key, vals)
  }

  // If any referenced column resolves to zero keys, the whole step collapses to
  // "no work" — Postgres `IN ()` is a syntax error, so the caller skips the pg
  // call (D4, generalised across steps). SQL is left untouched.
  for (const vals of values.values()) {
    if (vals.length === 0) {
      return { sql, params: [], usedColumns: [...values.keys()], emptyKeyset: true }
    }
  }

  // Assign a contiguous `$k` list per distinct (step, col).
  const params: unknown[] = []
  const listByKey = new Map<string, string>()
  for (const [key, vals] of values) {
    const start = params.length
    for (const v of vals) params.push(v)
    listByKey.set(key, vals.map((_, i) => `$${start + i + 1}`).join(', '))
  }

  // Splice tokens back-to-front so earlier offsets stay valid.
  let rewritten = sql
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    const list = listByKey.get(`step${t.step}.${t.col}`)!
    rewritten = rewritten.slice(0, t.start) + list + rewritten.slice(t.end)
  }

  return { sql: rewritten, params, usedColumns: [...values.keys()], emptyKeyset: false }
}

/**
 * Back-compat single-key wrapper (v0 `:step1.<keyColumn>`): models the flat
 * value array as Step 1's result set and delegates to `rewritePlaceholders`.
 * Kept so existing callers/tests keep the exact two-step contract.
 */
export function rewritePlaceholder(
  sql: string,
  keyColumn: string,
  keyValues: unknown[]
): RewriteResult {
  return rewritePlaceholders(sql, 2, {
    1: { fields: [keyColumn], rows: keyValues.map((v) => ({ [keyColumn]: v })) }
  })
}
