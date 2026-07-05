import { describe, it, expect } from 'vitest'
import type { SavedScript } from '@shared/types'
import { upsertScripts } from './script-store'

const NOW = '2026-07-03T00:00:00.000Z'
const EARLIER = '2026-07-01T00:00:00.000Z'

function script(overrides: Partial<SavedScript> = {}): SavedScript {
  return {
    id: 'id-1',
    name: 'Existing',
    sql: 'SELECT 1;',
    created_at: EARLIER,
    updated_at: EARLIER,
    ...overrides
  }
}

describe('upsertScripts', () => {
  it('appends a new script when the name is unused', () => {
    const start = [script()]
    const res = upsertScripts(start, { name: 'Fresh', sql: 'SELECT 2;' }, NOW)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.scripts).toHaveLength(2)
    expect(res.script.name).toBe('Fresh')
    expect(res.script.sql).toBe('SELECT 2;')
    expect(res.script.id).toBeTruthy()
    expect(res.script.created_at).toBe(NOW)
    expect(res.script.updated_at).toBe(NOW)
    // Original is untouched (pure).
    expect(start).toHaveLength(1)
  })

  it('trims the name before matching and storing', () => {
    const res = upsertScripts([], { name: '  Padded  ', sql: 'SELECT 1;' }, NOW)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.script.name).toBe('Padded')
  })

  it('reports a collision when the name exists and overwrite is not set', () => {
    const res = upsertScripts([script({ name: 'Dup' })], { name: 'Dup', sql: 'SELECT 9;' }, NOW)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.collision).toBe(true)
  })

  it('treats a trimmed name as colliding with an existing one', () => {
    const res = upsertScripts([script({ name: 'Dup' })], { name: '  Dup ', sql: 'X' }, NOW)
    expect(res.ok).toBe(false)
  })

  it('overwrites in place when overwrite is true, keeping id and created_at', () => {
    const start = [script({ id: 'keep-me', name: 'Dup', sql: 'OLD', created_at: EARLIER })]
    const res = upsertScripts(
      start,
      { name: 'Dup', sql: 'NEW', overwrite: true, connectionId: 'c-42' },
      NOW
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.scripts).toHaveLength(1)
    expect(res.script.id).toBe('keep-me')
    expect(res.script.sql).toBe('NEW')
    expect(res.script.connectionId).toBe('c-42')
    expect(res.script.created_at).toBe(EARLIER)
    expect(res.script.updated_at).toBe(NOW)
  })

  it('carries the optional connectionId tag onto a new script', () => {
    const res = upsertScripts([], { name: 'Tagged', sql: 'SELECT 1;', connectionId: 'c-7' }, NOW)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.script.connectionId).toBe('c-7')
  })
})
