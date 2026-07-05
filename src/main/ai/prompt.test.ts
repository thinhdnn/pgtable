import { describe, it, expect } from 'vitest'
import type { ForeignKeyEdge } from '@shared/types'
import {
  buildUserMessage,
  buildUserMessageParts,
  buildAskRowMessage,
  buildAskRowMessageParts,
  buildFederatedUserMessage,
  buildFederatedUserMessageParts,
  type SchemaTable,
  type FederatedSchemaContext
} from './prompt'

const tables: SchemaTable[] = [
  { name: 'users', columns: [{ name: 'id', data_type: 'int4' }, { name: 'role_id', data_type: 'int4' }] },
  { name: 'roles', columns: [{ name: 'id', data_type: 'int4' }, { name: 'name', data_type: 'text' }] }
]
function fkRow(
  constraint: string,
  srcTable: string,
  srcColumn: string,
  refTable: string,
  refColumn: string
): ForeignKeyEdge {
  return {
    constraint_name: constraint,
    src_schema: 'public',
    src_table: srcTable,
    src_column: srcColumn,
    ref_schema: 'public',
    ref_table: refTable,
    ref_column: refColumn,
    key_ordinal: 1
  }
}

const edges: ForeignKeyEdge[] = [fkRow('users_role_fk', 'users', 'role_id', 'roles', 'id')]

describe('buildUserMessage', () => {
  it('frames a from-scratch request without a base query', () => {
    const msg = buildUserMessage('public', tables, edges, 'find users with role Admin')
    expect(msg).toContain('Request: find users with role Admin')
    expect(msg).not.toContain('Existing query to modify')
    expect(msg).not.toContain('Change requested')
  })

  it('frames a refine request with the base query and asks for the full result', () => {
    const base = 'SELECT * FROM public.users;'
    const msg = buildUserMessage('public', tables, edges, 'only active users', base)
    expect(msg).toContain('Existing query to modify')
    expect(msg).toContain(base)
    expect(msg).toContain('return the FULL updated query')
    expect(msg).toContain('Change requested: only active users')
  })
})

// The cacheable-prefix split feeds prompt caching (see client.ts): schemaContext
// is the stable cached block, request is the per-call tail. Two invariants must
// hold or caching silently breaks or leaks: concatenation must reproduce the old
// single-string prompt byte-for-byte, and the per-request wording (the ask, the
// refine base, ambiguous paths, the row) must live ONLY in request so the schema
// prefix stays byte-identical across calls against the same database.
describe('user-message parts (cacheable prefix split)', () => {
  it('generate: parts concatenate to the full string and isolate the request', () => {
    const base = 'SELECT * FROM public.users;'
    const parts = buildUserMessageParts('public', tables, edges, 'only active users', base)
    expect(parts.schemaContext + parts.request).toBe(
      buildUserMessage('public', tables, edges, 'only active users', base)
    )
    expect(parts.schemaContext).toContain('Foreign keys')
    expect(parts.schemaContext).not.toContain('only active users')
    expect(parts.schemaContext).not.toContain('Existing query to modify')
    expect(parts.request).toContain('Change requested: only active users')
  })

  it('ask-row: the row values and question stay out of the cached prefix', () => {
    const parts = buildAskRowMessageParts(
      'public',
      tables,
      edges,
      ['id', 'name'],
      { id: 7, name: 'Ada' },
      'who reports to this user',
      'users'
    )
    expect(parts.schemaContext + parts.request).toBe(
      buildAskRowMessage(
        'public',
        tables,
        edges,
        ['id', 'name'],
        { id: 7, name: 'Ada' },
        'who reports to this user',
        'users'
      )
    )
    expect(parts.schemaContext).not.toContain('Ada')
    expect(parts.schemaContext).not.toContain('who reports to this user')
    expect(parts.request).toContain('who reports to this user')
  })

  it('federated: the attached-schema block is the prefix, the ask is the tail', () => {
    const contexts: FederatedSchemaContext[] = [
      { alias: 'db1', schema: 'public', tables, edges }
    ]
    const parts = buildFederatedUserMessageParts(contexts, 'orders per customer')
    expect(parts.schemaContext + parts.request).toBe(
      buildFederatedUserMessage(contexts, 'orders per customer')
    )
    expect(parts.schemaContext).toContain('Attached databases')
    expect(parts.schemaContext).not.toContain('orders per customer')
    expect(parts.request).toBe('Request: orders per customer')
  })
})

describe('buildAskRowMessage', () => {
  it('embeds the row as ordered JSON plus the question and schema context', () => {
    const msg = buildAskRowMessage(
      'public',
      tables,
      edges,
      ['id', 'role_id'],
      { role_id: 3, id: 42 },
      'what does this row mean?'
    )
    expect(msg).toContain('Selected row (JSON):')
    // Field order follows `columns`, not the object's key order.
    expect(msg.indexOf('"id"')).toBeLessThan(msg.indexOf('"role_id"'))
    expect(msg).toContain('42')
    expect(msg).toContain('Question: what does this row mean?')
    // Schema/FK context is included so the model can relate the row.
    expect(msg).toContain('Foreign keys:')
  })

  it('renders missing values as null', () => {
    const msg = buildAskRowMessage('public', tables, edges, ['id', 'name'], { id: 1 }, 'explain')
    expect(msg).toContain('"name": null')
  })

  it('labels the source table when known', () => {
    const msg = buildAskRowMessage('public', tables, edges, ['id'], { id: 1 }, 'explain', 'user')
    expect(msg).toContain('Selected row (from public.user, JSON)')
  })

  it('adds ambiguous join paths for a drill-down anchored on the source table', () => {
    // A cyclic user/role schema: direct users.role_id and via-group both exist.
    const cyclic: ForeignKeyEdge[] = [
      fkRow('users_role_fk', 'users', 'role_id', 'roles', 'id'),
      fkRow('ug_user_fk', 'user_groups', 'user_id', 'users', 'id'),
      fkRow('ug_group_fk', 'user_groups', 'group_id', 'groups', 'id'),
      fkRow('gr_group_fk', 'group_roles', 'group_id', 'groups', 'id'),
      fkRow('gr_role_fk', 'group_roles', 'role_id', 'roles', 'id')
    ]
    const cyclicTables: SchemaTable[] = ['users', 'roles', 'groups', 'user_groups', 'group_roles'].map(
      (name) => ({ name, columns: [{ name: 'id', data_type: 'int4' }] })
    )
    // Row from `roles`, question drills down to users → the users<->roles pair.
    const msg = buildAskRowMessage(
      'public',
      cyclicTables,
      cyclic,
      ['id'],
      { id: 3 },
      'which users have this role?',
      'roles'
    )
    expect(msg).toContain('Ambiguous join paths')
    expect(msg).toContain('user_groups') // the via-group route is spelled out
  })

  it('omits ambiguous paths for a plain explain question (single endpoint)', () => {
    const msg = buildAskRowMessage('public', tables, edges, ['id'], { id: 1 }, 'explain', 'users')
    expect(msg).not.toContain('Ambiguous join paths')
  })
})

describe('buildFederatedUserMessage', () => {
  it('prefixes every attached database with its alias.schema and keeps FKs per-DB', () => {
    const contexts: FederatedSchemaContext[] = [
      {
        alias: 'crm',
        schema: 'public',
        tables: [{ name: 'customers', columns: [{ name: 'id', data_type: 'int4' }] }],
        edges: []
      },
      {
        alias: 'sales',
        schema: 'public',
        tables: [
          { name: 'orders', columns: [{ name: 'id', data_type: 'int4' }, { name: 'customer_id', data_type: 'int4' }] }
        ],
        edges: [
          {
            constraint_name: 'orders_cust_fk',
            src_schema: 'public',
            src_table: 'orders',
            src_column: 'customer_id',
            ref_schema: 'public',
            ref_table: 'customers',
            ref_column: 'id',
            key_ordinal: 1
          }
        ]
      }
    ]
    const msg = buildFederatedUserMessage(contexts, 'orders per customer')
    expect(msg).toContain('crm.public.customers')
    expect(msg).toContain('sales.public.orders')
    // FK is rendered with the owning database's alias on both ends.
    expect(msg).toContain('sales.public.orders.customer_id -> sales.public.customers.id')
    expect(msg).toContain('Request: orders per customer')
  })
})
