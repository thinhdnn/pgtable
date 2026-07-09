import { describe, it, expect } from 'vitest'
import { formatSqlText } from './format-sql'

// `formatSqlInView` needs a live EditorView (DOM), so these cover the pure core.
// The point is not to pin sql-formatter's exact whitespace — that would break on
// every upgrade — but to pin the properties the editors actually rely on.
describe('formatSqlText', () => {
  it('pretty-prints and upper-cases keywords', () => {
    expect(formatSqlText('select a from t')).toBe('SELECT\n  a\nFROM\n  t')
  })

  it('returns null on SQL the formatter cannot parse', () => {
    // An unterminated string literal: sql-formatter throws rather than guessing.
    expect(formatSqlText("SELECT 'unterminated")).toBeNull()
  })

  describe('Linked Query placeholders survive a round trip', () => {
    // sql-formatter reads `:step1` as a named parameter. A version that split
    // `.id` off it would silently corrupt every linked step's IN-list.
    it('keeps :stepN.<col> intact', () => {
      const out = formatSqlText('SELECT id FROM tasks WHERE user_id IN (:step1.id);')
      expect(out).not.toBeNull()
      expect(out).toContain(':step1.id')
    })

    it('keeps multi-digit and multiple placeholders intact', () => {
      const out = formatSqlText(
        'select * from t where a in (:step10.user_id) and b in (:step2.x)'
      )
      expect(out).not.toBeNull()
      expect(out).toContain(':step10.user_id')
      expect(out).toContain(':step2.x')
    })
  })

  describe('Federated DuckDB syntax survives a round trip', () => {
    it('keeps catalog.schema.table and :: casts intact', () => {
      const out = formatSqlText(
        "SELECT a::varchar FROM qa_2.public.rl_referral_reports WHERE x = DATE '2026-06-01';"
      )
      expect(out).not.toBeNull()
      expect(out).toContain('qa_2.public.rl_referral_reports')
      expect(out).toContain('a::varchar')
    })

    it('leaves a dollar-quoted postgres_query body verbatim', () => {
      const body = "SELECT 1 FROM t WHERE a = 'x'"
      const out = formatSqlText(`SELECT * FROM postgres_query('qa', $$ ${body} $$) s;`)
      expect(out).not.toBeNull()
      expect(out).toContain(`$$ ${body} $$`)
    })
  })
})
