import { describe, it, expect } from 'vitest'
import {
  stripCommentsAndStrings,
  isReadOnlyStatement,
  applyAutoLimit,
  checkKeyBounds,
  rewritePlaceholder,
  rewritePlaceholders,
  LinkedRewriteError,
  MAX_KEY_VALUES,
  type UpstreamResults
} from './executor'
import { LINKED_STEP_ROW_LIMIT } from '@shared/linked-query'
import { isNonMutatingStatement } from '@shared/sql-statement'

describe('MAX_KEY_VALUES', () => {
  // The keyset bound and the per-step row cap must stay equal: a step's rows
  // feed the next step's IN-list, so a cap below the bound would silently drop
  // downstream keys, and a cap above it would let a step produce a keyset the
  // rewriter then rejects. Either drift is a bug.
  it('equals LINKED_STEP_ROW_LIMIT', () => {
    expect(MAX_KEY_VALUES).toBe(LINKED_STEP_ROW_LIMIT)
  })
})

describe('isReadOnlyStatement', () => {
  it('accepts SELECT and WITH', () => {
    expect(isReadOnlyStatement('SELECT 1')).toBe(true)
    expect(isReadOnlyStatement('  select * from t')).toBe(true)
    expect(isReadOnlyStatement('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true)
  })

  it('rejects DML/DDL', () => {
    expect(isReadOnlyStatement('INSERT INTO t VALUES (1)')).toBe(false)
    expect(isReadOnlyStatement('UPDATE t SET x = 1')).toBe(false)
    expect(isReadOnlyStatement('DELETE FROM t')).toBe(false)
    expect(isReadOnlyStatement('DROP TABLE t')).toBe(false)
    expect(isReadOnlyStatement('ALTER TABLE t ADD COLUMN x int')).toBe(false)
    expect(isReadOnlyStatement('TRUNCATE t')).toBe(false)
    expect(isReadOnlyStatement('TABLE t')).toBe(false) // narrowed per C1
    expect(isReadOnlyStatement('VALUES (1)')).toBe(false) // narrowed per C1
  })

  it('is not fooled by keywords inside comments or literals', () => {
    expect(isReadOnlyStatement('-- DELETE FROM x\nSELECT 1')).toBe(true)
    expect(isReadOnlyStatement("SELECT 'INSERT'")).toBe(true)
    expect(isReadOnlyStatement("/* UPDATE */ SELECT 1")).toBe(true)
  })
})

// These two functions look like duplicates and are not. `isReadOnlyStatement` is
// the *execution guard* (what the linked-query and DuckDB runners will let run,
// narrowed per C1). `isNonMutatingStatement` is the *warning classifier* (does
// this AI-authored statement change data?). TABLE and VALUES read data, so the
// classifier accepts them while the guard still refuses to run them.
//
// Collapsing the two would either widen the guard duck-runner.ts depends on, or
// make the editor warn about harmless reads. This test fails if anyone tries.
describe('read-only guard vs non-mutating classifier', () => {
  it('diverge on TABLE and VALUES, on purpose', () => {
    for (const sql of ['TABLE t', 'VALUES (1)']) {
      expect(isReadOnlyStatement(sql)).toBe(false)
      expect(isNonMutatingStatement(sql)).toBe(true)
    }
  })

  it('agree everywhere else that matters', () => {
    for (const sql of ['SELECT 1', 'WITH cte AS (SELECT 1) SELECT * FROM cte']) {
      expect(isReadOnlyStatement(sql)).toBe(true)
      expect(isNonMutatingStatement(sql)).toBe(true)
    }
    for (const sql of ['INSERT INTO t VALUES (1)', 'UPDATE t SET x = 1', 'DROP TABLE t']) {
      expect(isReadOnlyStatement(sql)).toBe(false)
      expect(isNonMutatingStatement(sql)).toBe(false)
    }
  })
})

describe('applyAutoLimit', () => {
  it('appends LIMIT to a bare SELECT', () => {
    const r = applyAutoLimit('SELECT * FROM users', 1000)
    expect(r.appended).toBe(true)
    expect(r.sql).toBe('SELECT * FROM users\nLIMIT 1000;')
  })

  it('leaves LIMIT-bearing SQL alone', () => {
    const r = applyAutoLimit('SELECT * FROM users LIMIT 10', 1000)
    expect(r.appended).toBe(false)
    expect(r.sql).toBe('SELECT * FROM users LIMIT 10')
  })

  it('leaves FETCH FIRST alone', () => {
    const r = applyAutoLimit('SELECT * FROM users FETCH FIRST 10 ROWS ONLY', 1000)
    expect(r.appended).toBe(false)
  })

  it('does not touch DML', () => {
    const r = applyAutoLimit('UPDATE users SET x = 1', 1000)
    expect(r.appended).toBe(false)
    expect(r.sql).toBe('UPDATE users SET x = 1')
  })
})

describe('checkKeyBounds', () => {
  it('accepts at the boundary', () => {
    expect(checkKeyBounds(new Array(MAX_KEY_VALUES).fill(1))).toEqual({ ok: true })
  })

  it('rejects above the boundary', () => {
    const r = checkKeyBounds(new Array(MAX_KEY_VALUES + 1).fill(1))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toBe(
        `Step 1 returned ${MAX_KEY_VALUES + 1} rows — narrow it below ${MAX_KEY_VALUES} keys`
      )
    }
  })
})

describe('rewritePlaceholder', () => {
  it('rewrites a single :step1.<col> to a $1..$n param list', () => {
    const r = rewritePlaceholder(
      'SELECT task FROM tasks WHERE user_id IN (:step1.uuid)',
      'uuid',
      ['a', 'b', 'c']
    )
    expect(r.sql).toBe('SELECT task FROM tasks WHERE user_id IN ($1, $2, $3)')
    expect(r.params).toEqual(['a', 'b', 'c'])
    expect(r.emptyKeyset).toBe(false)
    expect(r.usedColumns).toEqual(['step1.uuid'])
  })

  it('does not rewrite tokens inside string literals', () => {
    expect(() =>
      rewritePlaceholder("SELECT 'not :step1.uuid'", 'uuid', ['a'])
    ).toThrow(LinkedRewriteError)
  })

  it('does not rewrite tokens inside comments', () => {
    expect(() =>
      rewritePlaceholder('-- :step1.uuid\nSELECT 1', 'uuid', ['a'])
    ).toThrow(LinkedRewriteError)
  })

  it('drops nulls silently (VQ4)', () => {
    const r = rewritePlaceholder(
      'SELECT * FROM t WHERE id IN (:step1.uuid)',
      'uuid',
      ['a', null, 'b', undefined, 'c']
    )
    expect(r.params).toEqual(['a', 'b', 'c'])
    expect(r.sql).toBe('SELECT * FROM t WHERE id IN ($1, $2, $3)')
  })

  it('collapses all-null keysets to emptyKeyset for the D4 path', () => {
    const r = rewritePlaceholder(
      'SELECT * FROM t WHERE id IN (:step1.uuid)',
      'uuid',
      [null, null, undefined]
    )
    expect(r.emptyKeyset).toBe(true)
    expect(r.params).toEqual([])
    // SQL left untouched so the caller can short-circuit before any pg call.
    expect(r.sql).toBe('SELECT * FROM t WHERE id IN (:step1.uuid)')
  })

  it('collapses an empty input to emptyKeyset', () => {
    const r = rewritePlaceholder(
      'SELECT * FROM t WHERE id IN (:step1.uuid)',
      'uuid',
      []
    )
    expect(r.emptyKeyset).toBe(true)
    expect(r.params).toEqual([])
  })

  it('throws UNKNOWN_STEP for :step2.<col>', () => {
    try {
      rewritePlaceholder(
        'SELECT * FROM t WHERE id = :step2.uuid',
        'uuid',
        ['a']
      )
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LinkedRewriteError)
      expect((err as LinkedRewriteError).code).toBe('UNKNOWN_STEP')
    }
  })

  it('throws UNKNOWN_COL when placeholder column mismatches keyColumn', () => {
    try {
      rewritePlaceholder(
        'SELECT * FROM t WHERE id = :step1.foo',
        'uuid',
        ['a']
      )
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LinkedRewriteError)
      expect((err as LinkedRewriteError).code).toBe('UNKNOWN_COL')
    }
  })

  it('throws NO_PLACEHOLDER when SQL has no :step1.<col>', () => {
    try {
      rewritePlaceholder('SELECT 1', 'uuid', ['a'])
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(LinkedRewriteError)
      expect((err as LinkedRewriteError).code).toBe('NO_PLACEHOLDER')
    }
  })

  it('rewrites multiple occurrences consistently', () => {
    const r = rewritePlaceholder(
      'SELECT * FROM t WHERE a IN (:step1.uuid) OR b IN (:step1.uuid)',
      'uuid',
      ['x', 'y']
    )
    expect(r.sql).toBe(
      'SELECT * FROM t WHERE a IN ($1, $2) OR b IN ($1, $2)'
    )
    expect(r.params).toEqual(['x', 'y'])
  })
})

describe('rewritePlaceholders (N-step chain)', () => {
  const upstream: UpstreamResults = {
    1: { fields: ['id', 'org_id'], rows: [{ id: 1, org_id: 10 }, { id: 2, org_id: 20 }] },
    2: { fields: ['task_id'], rows: [{ task_id: 'a' }, { task_id: 'b' }, { task_id: 'c' }] }
  }

  it('rewrites references to multiple earlier steps in one statement', () => {
    const r = rewritePlaceholders(
      'SELECT * FROM t WHERE u IN (:step1.id) AND k IN (:step2.task_id)',
      3,
      upstream
    )
    expect(r.sql).toBe('SELECT * FROM t WHERE u IN ($1, $2) AND k IN ($3, $4, $5)')
    expect(r.params).toEqual([1, 2, 'a', 'b', 'c'])
    expect(r.usedColumns).toEqual(['step1.id', 'step2.task_id'])
    expect(r.emptyKeyset).toBe(false)
  })

  it('rewrites two different columns of the same step', () => {
    const r = rewritePlaceholders(
      'SELECT * FROM t WHERE a IN (:step1.id) OR b IN (:step1.org_id)',
      2,
      upstream
    )
    expect(r.sql).toBe('SELECT * FROM t WHERE a IN ($1, $2) OR b IN ($3, $4)')
    expect(r.params).toEqual([1, 2, 10, 20])
  })

  it('reuses params for repeated references to the same step.col', () => {
    const r = rewritePlaceholders(
      'SELECT * FROM t WHERE a IN (:step1.id) OR b IN (:step1.id)',
      2,
      upstream
    )
    expect(r.sql).toBe('SELECT * FROM t WHERE a IN ($1, $2) OR b IN ($1, $2)')
    expect(r.params).toEqual([1, 2])
  })

  it('throws UNKNOWN_STEP for a forward or self reference', () => {
    const forward = () =>
      rewritePlaceholders('SELECT * FROM t WHERE x IN (:step3.id)', 3, upstream)
    expect(forward).toThrow(LinkedRewriteError)
    try {
      forward()
    } catch (err) {
      expect((err as LinkedRewriteError).code).toBe('UNKNOWN_STEP')
    }
  })

  it('throws UNKNOWN_STEP when the referenced step has no result yet', () => {
    try {
      rewritePlaceholders('SELECT * FROM t WHERE x IN (:step1.id)', 3, {
        2: upstream[2]
      })
      throw new Error('expected throw')
    } catch (err) {
      expect((err as LinkedRewriteError).code).toBe('UNKNOWN_STEP')
    }
  })

  it('throws UNKNOWN_COL when the column is not in the referenced result', () => {
    try {
      rewritePlaceholders('SELECT * FROM t WHERE x IN (:step1.missing)', 2, upstream)
      throw new Error('expected throw')
    } catch (err) {
      expect((err as LinkedRewriteError).code).toBe('UNKNOWN_COL')
    }
  })

  it('short-circuits to emptyKeyset when a referenced column is all-null', () => {
    const r = rewritePlaceholders('SELECT * FROM t WHERE x IN (:step1.id)', 2, {
      1: { fields: ['id'], rows: [{ id: null }, { id: undefined }] }
    })
    expect(r.emptyKeyset).toBe(true)
    expect(r.params).toEqual([])
    expect(r.sql).toBe('SELECT * FROM t WHERE x IN (:step1.id)')
  })

  it('throws TOO_MANY_KEYS when a referenced column exceeds the bound', () => {
    const big: UpstreamResults = {
      1: {
        fields: ['id'],
        rows: Array.from({ length: MAX_KEY_VALUES + 1 }, (_, i) => ({ id: i }))
      }
    }
    try {
      rewritePlaceholders('SELECT * FROM t WHERE x IN (:step1.id)', 2, big)
      throw new Error('expected throw')
    } catch (err) {
      expect((err as LinkedRewriteError).code).toBe('TOO_MANY_KEYS')
    }
  })
})

describe('stripCommentsAndStrings offset preservation (C2)', () => {
  it('keeps byte offsets aligned with the original for splicing', () => {
    const src = "SELECT 'x' FROM t -- comment\nWHERE 1=1"
    const sanitized = stripCommentsAndStrings(src)
    expect(sanitized.length).toBe(src.length)
  })
})
