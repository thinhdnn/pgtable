import { describe, it, expect } from 'vitest'
import type { ForeignKeyEdge } from '@shared/types'
import {
  buildJoinEdges,
  detectRequestTables,
  findAmbiguousPairs,
  renderPath,
  serializeAmbiguousPaths
} from './sql-graph'

// Helper to build a single-column FK row in the `public` schema.
function fk(
  constraint: string,
  srcTable: string,
  srcColumn: string,
  refTable: string,
  refColumn: string,
  keyOrdinal = 1
): ForeignKeyEdge {
  return {
    constraint_name: constraint,
    src_schema: 'public',
    src_table: srcTable,
    src_column: srcColumn,
    ref_schema: 'public',
    ref_table: refTable,
    ref_column: refColumn,
    key_ordinal: keyOrdinal
  }
}

// The scenario from the design discussion: a user reaches a role two ways —
// directly (users.role_id -> roles) and via group membership
// (users -> user_groups -> groups -> group_roles -> roles).
const userRoleSchema: ForeignKeyEdge[] = [
  fk('users_role_fk', 'users', 'role_id', 'roles', 'id'),
  fk('ug_user_fk', 'user_groups', 'user_id', 'users', 'id'),
  fk('ug_group_fk', 'user_groups', 'group_id', 'groups', 'id'),
  fk('gr_group_fk', 'group_roles', 'group_id', 'groups', 'id'),
  fk('gr_role_fk', 'group_roles', 'role_id', 'roles', 'id')
]

describe('buildJoinEdges', () => {
  it('collapses a composite FK into one edge with ordinal-aligned columns', () => {
    const edges: ForeignKeyEdge[] = [
      fk('ship_fk', 'shipments', 'region', 'warehouses', 'region', 1),
      fk('ship_fk', 'shipments', 'wh_code', 'warehouses', 'code', 2)
    ]
    const joins = buildJoinEdges(edges)
    expect(joins).toHaveLength(1)
    expect(joins[0].src.columns).toEqual(['region', 'wh_code'])
    expect(joins[0].ref.columns).toEqual(['region', 'code'])
  })
})

describe('findAmbiguousPairs', () => {
  it('finds the users <-> roles pair reachable by two distinct paths', () => {
    const pairs = findAmbiguousPairs(userRoleSchema)
    const userRole = pairs.find(
      (p) =>
        (p.a === 'public.users' && p.b === 'public.roles') ||
        (p.a === 'public.roles' && p.b === 'public.users')
    )
    expect(userRole).toBeDefined()
    expect(userRole!.paths.length).toBe(2)
    // Shortest route first: the direct FK is a single hop.
    expect(userRole!.paths[0]).toHaveLength(1)
    expect(userRole!.paths[1].length).toBeGreaterThan(1)
  })

  it('scopes to request tables so a cyclic schema does not flood with detours', () => {
    // All-pairs over this cycle reports every pair as ambiguous (detour routes).
    expect(findAmbiguousPairs(userRoleSchema).length).toBeGreaterThan(1)
    // Scoped to just the two tables the request names, only the genuine
    // users<->roles ambiguity remains.
    const scoped = findAmbiguousPairs(userRoleSchema, { includeTables: ['users', 'roles'] })
    expect(scoped).toHaveLength(1)
    expect(scoped[0].paths).toHaveLength(2)
  })

  it('reports no ambiguous pairs when only a single route exists', () => {
    const linear: ForeignKeyEdge[] = [
      fk('a_fk', 'a', 'b_id', 'b', 'id'),
      fk('b_fk', 'b', 'c_id', 'c', 'id')
    ]
    expect(findAmbiguousPairs(linear)).toEqual([])
  })
})

describe('detectRequestTables', () => {
  const names = ['users', 'roles', 'groups', 'user_groups', 'group_roles']

  it('matches singular request words to plural table names', () => {
    // "tìm user có role Admin"
    expect(detectRequestTables(names, 'tìm user có role Admin').sort()).toEqual(['roles', 'users'])
  })

  it('ignores short noise words and unmentioned tables', () => {
    expect(detectRequestTables(names, 'list all users')).toEqual(['users'])
  })
})

describe('renderPath / serializeAmbiguousPaths', () => {
  it('renders the direct route with an oriented join condition', () => {
    const pairs = findAmbiguousPairs(userRoleSchema)
    const userRole = pairs.find(
      (p) =>
        (p.a === 'public.users' && p.b === 'public.roles') ||
        (p.a === 'public.roles' && p.b === 'public.users')
    )!
    const direct = userRole.paths[0]
    // The single-hop join equates the two FK columns, whichever side is rendered
    // first (traversal order depends on node sort).
    const rendered = renderPath(direct)
    expect(rendered).toContain('users.role_id')
    expect(rendered).toContain('roles.id')
    expect(rendered).toMatch(/users\.role_id = roles\.id|roles\.id = users\.role_id/)
  })

  it('spells out every hop of the multi-hop route', () => {
    const pairs = findAmbiguousPairs(userRoleSchema)
    const userRole = pairs.find(
      (p) =>
        (p.a === 'public.users' && p.b === 'public.roles') ||
        (p.a === 'public.roles' && p.b === 'public.users')
    )!
    const viaGroup = userRole.paths[1]
    const rendered = renderPath(viaGroup)
    expect(rendered).toContain('user_groups')
    expect(rendered).toContain('groups')
    expect(rendered).toContain('group_roles')
  })

  it('produces an empty section when there is nothing to disambiguate', () => {
    expect(serializeAmbiguousPaths([])).toBe('')
  })
})
