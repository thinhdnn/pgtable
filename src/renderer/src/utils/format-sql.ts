// Shared "Format SQL" action for every CodeMirror SQL editor in the app.
// Extracted from QueryEditor so the Linked and Federated editors format
// identically rather than drifting into three near-copies.
import type { EditorView } from '@codemirror/view'
import { format } from 'sql-formatter'

export type FormatOutcome =
  /** The document (or selection) was rewritten. */
  | 'formatted'
  /** Already formatted — nothing dispatched, so undo history stays clean. */
  | 'unchanged'
  /** Nothing but whitespace to format. */
  | 'empty'
  /** sql-formatter threw: the statement is incomplete or not valid SQL. */
  | 'invalid'

/**
 * Pretty-print one SQL string (PostgreSQL dialect, upper-cased keywords), or
 * `null` when sql-formatter can't parse it. Pure — split out from
 * `formatSqlInView` so the dialect choice is unit-testable without a DOM.
 *
 * Two properties the callers depend on, both covered by format-sql.test.ts:
 *
 * - Linked Query's `:stepN.<col>` placeholders survive a round trip. The
 *   formatter treats `:step1` as a named parameter, and a version that split
 *   `.id` off it would silently corrupt every linked step.
 * - The DuckDB dialect the Federated tab writes (`cat.schema.table`, `::cast`,
 *   `$$…$$`) round-trips too. `postgresql` is close enough: both are
 *   Postgres-flavoured and the formatter only tokenises, never resolves names.
 */
export function formatSqlText(source: string): string | null {
  try {
    return format(source, {
      language: 'postgresql',
      keywordCase: 'upper',
      tabWidth: 2
    })
  } catch {
    return null
  }
}

/**
 * Pretty-print the editor's SQL in place. Formats the selection when there is
 * one, otherwise the whole buffer.
 *
 * Dispatched through the live view so undo history and cursor stay sane; the
 * caller's `onChange` keeps its own state in sync. Never throws — a statement
 * the formatter can't parse comes back as `'invalid'` for the caller to surface.
 */
export function formatSqlInView(view: EditorView): FormatOutcome {
  const { from, to } = view.state.selection.main
  const hasSelection = from !== to
  const source = hasSelection ? view.state.sliceDoc(from, to) : view.state.doc.toString()
  if (!source.trim()) return 'empty'

  const formatted = formatSqlText(source)
  if (formatted === null) return 'invalid'
  // Don't dispatch a no-op change: it would push an empty undo step.
  if (formatted === source) return 'unchanged'
  view.dispatch(
    hasSelection
      ? { changes: { from, to, insert: formatted } }
      : { changes: { from: 0, to: view.state.doc.length, insert: formatted } }
  )
  return 'formatted'
}
