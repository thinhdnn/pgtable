import { describe, it, expect } from 'vitest'
import { feedsLaterStep } from './linked-query'

// The LINKED_STEP_ROW_LIMIT === MAX_KEY_VALUES invariant is asserted in
// src/main/linked-query/executor.test.ts, not here: `src/shared` belongs to the
// web tsconfig project and must not import from `src/main`.

describe('feedsLaterStep', () => {
  it('detects a later step referencing this one', () => {
    expect(feedsLaterStep(['SELECT * FROM t WHERE id IN (:step1.id)'], 1)).toBe(true)
  })

  it('is false when no later step references it', () => {
    expect(feedsLaterStep(['SELECT * FROM t WHERE id IN (:step2.id)'], 1)).toBe(false)
  })

  it('is false with no later steps at all (the last step)', () => {
    expect(feedsLaterStep([], 3)).toBe(false)
  })

  it('does not let :step1 match :step10 or :step11', () => {
    const later = ['SELECT * FROM t WHERE a IN (:step10.id) AND b IN (:step11.id)']
    expect(feedsLaterStep(later, 1)).toBe(false)
    expect(feedsLaterStep(later, 10)).toBe(true)
    expect(feedsLaterStep(later, 11)).toBe(true)
  })

  it('scans every later step, not just the next one', () => {
    const later = ['SELECT 1', 'SELECT * FROM t WHERE id IN (:step1.id)']
    expect(feedsLaterStep(later, 1)).toBe(true)
  })

  it('matches a reference to any column of the step', () => {
    expect(feedsLaterStep(['SELECT * FROM t WHERE u IN (:step2.user_id)'], 2)).toBe(true)
  })
})
