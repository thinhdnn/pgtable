import { describe, it, expect } from 'vitest'
import { stripCommentsAndStrings, isNonMutatingStatement } from './sql-statement'

describe('stripCommentsAndStrings', () => {
  it('blanks comments and string bodies while preserving length', () => {
    const sql = "SELECT 'abc' -- note\nFROM t"
    const out = stripCommentsAndStrings(sql)
    expect(out.length).toBe(sql.length)
    expect(out).not.toContain('abc')
    expect(out).not.toContain('note')
    expect(out).toContain('SELECT')
    expect(out).toContain('FROM t')
  })

  it('blanks block comments and dollar-quoted bodies', () => {
    expect(stripCommentsAndStrings('/* DROP */ SELECT 1').trim()).toBe('SELECT 1')
    expect(stripCommentsAndStrings('SELECT $$ DELETE FROM t $$').trim()).toBe('SELECT')
  })

  it('handles doubled single quotes inside a literal', () => {
    const out = stripCommentsAndStrings("SELECT 'it''s' FROM t")
    expect(out).not.toContain('it')
    expect(out).toContain('FROM t')
  })
})

describe('isNonMutatingStatement', () => {
  it('accepts reads', () => {
    expect(isNonMutatingStatement('SELECT 1')).toBe(true)
    expect(isNonMutatingStatement('  select * from t')).toBe(true)
    expect(isNonMutatingStatement('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true)
    expect(isNonMutatingStatement('SELECT 1;')).toBe(true)
    expect(isNonMutatingStatement('-- lead comment\nSELECT 1')).toBe(true)
  })

  it('accepts TABLE and VALUES — they read data, so they must not warn', () => {
    expect(isNonMutatingStatement('TABLE t')).toBe(true)
    expect(isNonMutatingStatement('VALUES (1)')).toBe(true)
  })

  it('rejects DML and DDL', () => {
    expect(isNonMutatingStatement('INSERT INTO t VALUES (1)')).toBe(false)
    expect(isNonMutatingStatement('UPDATE t SET x = 1')).toBe(false)
    expect(isNonMutatingStatement('DELETE FROM t')).toBe(false)
    expect(isNonMutatingStatement('DROP TABLE t')).toBe(false)
    expect(isNonMutatingStatement('TRUNCATE t')).toBe(false)
    expect(isNonMutatingStatement('ALTER TABLE t ADD COLUMN x int')).toBe(false)
  })

  it('is not fooled by a keyword hidden in a string or comment', () => {
    expect(isNonMutatingStatement("SELECT 'DROP TABLE users'")).toBe(true)
    expect(isNonMutatingStatement('/* SELECT */ DELETE FROM t')).toBe(false)
  })
})
