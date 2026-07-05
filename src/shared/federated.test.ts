import { describe, it, expect } from 'vitest'
import { deriveAlias } from './federated'

describe('deriveAlias', () => {
  it('sanitizes to lowercase word characters', () => {
    expect(deriveAlias('Prod DB', new Set())).toBe('prod_db')
    expect(deriveAlias('YAS-Prod (EU)', new Set())).toBe('yas_prod_eu')
  })

  it('prefixes when empty or starting with a digit', () => {
    expect(deriveAlias('123', new Set())).toBe('db_123')
    expect(deriveAlias('!!!', new Set())).toBe('db')
  })

  it('resolves collisions with numeric suffixes and records them', () => {
    const taken = new Set<string>()
    expect(deriveAlias('DB', taken)).toBe('db')
    expect(deriveAlias('db', taken)).toBe('db_2')
    expect(deriveAlias('Db', taken)).toBe('db_3')
  })
})
