import { describe, it, expect } from 'vitest'
import type { SavedFederatedQuery, SavedFederatedAttachment } from '@shared/types'
import { upsertFederatedQueries } from './federated-script-store'

const NOW = '2026-07-05T00:00:00.000Z'
const EARLIER = '2026-07-01T00:00:00.000Z'

const ATT: SavedFederatedAttachment[] = [
  { connectionId: 'c-1', database: 'crm', schema: 'public' },
  { connectionId: 'c-2', database: 'sales', schema: 'public' }
]

function query(overrides: Partial<SavedFederatedQuery> = {}): SavedFederatedQuery {
  return {
    id: 'id-1',
    name: 'Existing',
    attachments: ATT,
    sql: 'SELECT 1;',
    autoLimit: true,
    created_at: EARLIER,
    updated_at: EARLIER,
    ...overrides
  }
}

describe('upsertFederatedQueries', () => {
  it('appends a new query when the name is unused', () => {
    const start = [query()]
    const res = upsertFederatedQueries(
      start,
      { name: 'Fresh', attachments: ATT, sql: 'SELECT 2;', autoLimit: false },
      NOW
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.queries).toHaveLength(2)
    expect(res.query.name).toBe('Fresh')
    expect(res.query.sql).toBe('SELECT 2;')
    expect(res.query.attachments).toEqual(ATT)
    expect(res.query.autoLimit).toBe(false)
    expect(res.query.id).toBeTruthy()
    expect(res.query.created_at).toBe(NOW)
    expect(res.query.updated_at).toBe(NOW)
    // Original is untouched (pure).
    expect(start).toHaveLength(1)
  })

  it('trims the name before matching and storing', () => {
    const res = upsertFederatedQueries(
      [],
      { name: '  Padded  ', attachments: ATT, sql: 'SELECT 1;', autoLimit: true },
      NOW
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.query.name).toBe('Padded')
  })

  it('reports a collision when the name exists and overwrite is not set', () => {
    const res = upsertFederatedQueries(
      [query({ name: 'Dup' })],
      { name: 'Dup', attachments: ATT, sql: 'SELECT 9;', autoLimit: true },
      NOW
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.collision).toBe(true)
  })

  it('treats a trimmed name as colliding with an existing one', () => {
    const res = upsertFederatedQueries(
      [query({ name: 'Dup' })],
      { name: '  Dup ', attachments: ATT, sql: 'X', autoLimit: true },
      NOW
    )
    expect(res.ok).toBe(false)
  })

  it('overwrites in place when overwrite is true, keeping id and created_at', () => {
    const start = [
      query({ id: 'keep-me', name: 'Dup', sql: 'OLD', autoLimit: true, created_at: EARLIER })
    ]
    const nextAtt: SavedFederatedAttachment[] = [
      { connectionId: 'c-9', database: 'analytics', schema: 'reporting' }
    ]
    const res = upsertFederatedQueries(
      start,
      { name: 'Dup', attachments: nextAtt, sql: 'NEW', autoLimit: false, overwrite: true },
      NOW
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.queries).toHaveLength(1)
    expect(res.query.id).toBe('keep-me')
    expect(res.query.sql).toBe('NEW')
    expect(res.query.attachments).toEqual(nextAtt)
    expect(res.query.autoLimit).toBe(false)
    expect(res.query.created_at).toBe(EARLIER)
    expect(res.query.updated_at).toBe(NOW)
  })

  it('persists the full ordered attachment list on a new query', () => {
    const res = upsertFederatedQueries(
      [],
      { name: 'Multi', attachments: ATT, sql: 'SELECT 1;', autoLimit: true },
      NOW
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.query.attachments).toHaveLength(2)
    expect(res.query.attachments[0].connectionId).toBe('c-1')
    expect(res.query.attachments[1].database).toBe('sales')
  })
})
