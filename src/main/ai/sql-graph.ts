import type { ForeignKeyEdge } from '@shared/types'

// The FK graph, built from the raw ForeignKeyEdge rows. Approach 2 (code finds
// the join paths, the model only picks the semantics): rather than hand Claude a
// flat FK list and hope it discovers every route between two tables, we collapse
// composite constraints into single undirected edges, enumerate ALL simple join
// paths between table pairs, and surface the pairs that have more than one path
// so the prompt can spell them out. That removes the model's pathfinding burden
// and its main failure mode — silently choosing one route when several exist.

// A node key is `schema.table`, unique across the scoped schema(s).
function nodeKey(schema: string, table: string): string {
  return `${schema}.${table}`
}

// One FK constraint collapsed into a single undirected edge. `src`/`ref` keep the
// original direction (src references ref) so we can render join conditions with
// the right column on each side; `columns` on each end are ordinal-aligned to
// support composite keys.
export interface JoinEdge {
  constraint: string
  src: { schema: string; table: string; columns: string[] }
  ref: { schema: string; table: string; columns: string[] }
}

// One step along a path: the edge plus which node we entered it from, so the
// renderer knows which side is the "from" table and which columns map to which.
interface PathStep {
  edge: JoinEdge
  fromKey: string
  toKey: string
}

export type JoinPath = PathStep[]

// A pair of tables reachable by more than one distinct join path — the ambiguous
// case the model must not resolve by guessing.
export interface AmbiguousPair {
  a: string // `schema.table`
  b: string // `schema.table`
  paths: JoinPath[]
}

// Collapse ForeignKeyEdge rows (one row per FK column) into JoinEdges (one per
// constraint), grouping composite columns by constraint_name and ordering by
// key_ordinal — the same grouping serializeForeignKeys uses.
export function buildJoinEdges(edges: ForeignKeyEdge[]): JoinEdge[] {
  const byConstraint = new Map<string, ForeignKeyEdge[]>()
  for (const e of edges) {
    const list = byConstraint.get(e.constraint_name) ?? []
    list.push(e)
    byConstraint.set(e.constraint_name, list)
  }
  const out: JoinEdge[] = []
  for (const cols of byConstraint.values()) {
    cols.sort((a, b) => a.key_ordinal - b.key_ordinal)
    const first = cols[0]
    out.push({
      constraint: first.constraint_name,
      src: {
        schema: first.src_schema,
        table: first.src_table,
        columns: cols.map((c) => c.src_column)
      },
      ref: {
        schema: first.ref_schema,
        table: first.ref_table,
        columns: cols.map((c) => c.ref_column)
      }
    })
  }
  return out
}

// Undirected adjacency list keyed by `schema.table`. A self-referential FK (a
// table that references itself) is skipped: it never contributes a *new* route
// between two distinct tables and would only create trivial cycles.
type Adjacency = Map<string, PathStep[]>

function buildAdjacency(joinEdges: JoinEdge[]): Adjacency {
  const adj: Adjacency = new Map()
  const link = (fromKey: string, toKey: string, edge: JoinEdge): void => {
    const list = adj.get(fromKey) ?? []
    list.push({ edge, fromKey, toKey })
    adj.set(fromKey, list)
  }
  for (const edge of joinEdges) {
    const srcKey = nodeKey(edge.src.schema, edge.src.table)
    const refKey = nodeKey(edge.ref.schema, edge.ref.table)
    if (srcKey === refKey) continue // self-reference: no cross-table route
    link(srcKey, refKey, edge)
    link(refKey, srcKey, edge)
  }
  return adj
}

const DEFAULT_MAX_HOPS = 4
const DEFAULT_MAX_PATHS_PER_PAIR = 6

// All simple (no repeated table) join paths between two nodes, shortest first,
// bounded by hop count and path count so a densely linked schema can't blow up
// the search or the prompt.
export function findAllPaths(
  adj: Adjacency,
  fromKey: string,
  toKey: string,
  maxHops = DEFAULT_MAX_HOPS,
  maxPaths = DEFAULT_MAX_PATHS_PER_PAIR
): JoinPath[] {
  const results: JoinPath[] = []
  const visited = new Set<string>([fromKey])
  const path: PathStep[] = []

  const dfs = (node: string): void => {
    if (results.length >= maxPaths) return
    if (node === toKey && path.length > 0) {
      results.push([...path])
      return
    }
    if (path.length >= maxHops) return
    for (const step of adj.get(node) ?? []) {
      if (visited.has(step.toKey)) continue
      visited.add(step.toKey)
      path.push(step)
      dfs(step.toKey)
      path.pop()
      visited.delete(step.toKey)
    }
  }

  dfs(fromKey)
  return results.sort((a, b) => a.length - b.length)
}

// Every unordered table pair that has more than one distinct join path. These are
// the routes the model would otherwise have to disambiguate on its own.
//
// IMPORTANT: on a cyclic schema (roles -> group_roles -> groups -> user_groups ->
// users -> roles), EVERY pair is technically multi-path, because the long way
// around the cycle is always a second simple path. Pure topology cannot tell a
// meaningful alternate route (users->roles direct vs via group) from a pointless
// detour (group_roles->groups direct vs the long way round) — they are
// structurally identical. So `includeTables` scopes the search to the tables the
// request actually mentions: with 2-3 endpoints the alternatives are all
// genuinely between the tables in question, and the all-pairs flood disappears.
export function findAmbiguousPairs(
  edges: ForeignKeyEdge[],
  opts: {
    maxHops?: number
    maxPathsPerPair?: number
    maxPairs?: number
    // Bare table names to restrict pair endpoints to. When set, only pairs whose
    // BOTH endpoints are in this set are considered. Omit for all-pairs.
    includeTables?: string[]
  } = {}
): AmbiguousPair[] {
  const { maxHops = DEFAULT_MAX_HOPS, maxPathsPerPair = DEFAULT_MAX_PATHS_PER_PAIR, maxPairs = 20 } =
    opts
  const adj = buildAdjacency(buildJoinEdges(edges))
  let nodes = [...adj.keys()].sort()
  if (opts.includeTables) {
    const wanted = new Set(opts.includeTables.map((t) => t.toLowerCase()))
    nodes = nodes.filter((key) => wanted.has(bareTable(key).toLowerCase()))
  }
  const pairs: AmbiguousPair[] = []

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const paths = findAllPaths(adj, nodes[i], nodes[j], maxHops, maxPathsPerPair)
      if (paths.length >= 2) pairs.push({ a: nodes[i], b: nodes[j], paths })
    }
  }

  // Surface the shortest, most-connected ambiguities first, then cap.
  pairs.sort((p, q) => p.paths[0].length - q.paths[0].length || p.a.localeCompare(q.a))
  return pairs.slice(0, maxPairs)
}

// Guess which tables a natural-language request refers to, by matching request
// words against table names (case-insensitive, with naive singular/plural
// folding so "user"/"role" match "users"/"roles"). Deliberately conservative:
// this only scopes the ambiguous-paths hint, so a miss just means the model falls
// back to the raw FK list — no wrong SQL, only a missed hint.
export function detectRequestTables(tableNames: string[], request: string): string[] {
  const tokens = new Set(
    request
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 3)
  )
  // Naive plural folding: strip a trailing "s" so "role"/"roles" and
  // "user"/"users" both stem to the same token. Enough for typical table names;
  // irregular plurals just miss the hint (harmless — falls back to the FK list).
  const singular = (s: string): string => s.replace(/s$/, '')
  const matched: string[] = []
  for (const name of tableNames) {
    const n = name.toLowerCase()
    const nStem = singular(n)
    let hit = false
    for (const tok of tokens) {
      if (tok === n || singular(tok) === nStem) {
        hit = true
        break
      }
    }
    if (hit) matched.push(name)
  }
  return matched
}

// The (fromCols, toCols) for a step, oriented by which node we entered from, so a
// join condition reads `toTable.col = fromTable.col` with matching ordinals.
function orientedColumns(step: PathStep): { fromCols: string[]; toCols: string[] } {
  const { edge, fromKey } = step
  const srcKey = nodeKey(edge.src.schema, edge.src.table)
  return fromKey === srcKey
    ? { fromCols: edge.src.columns, toCols: edge.ref.columns }
    : { fromCols: edge.ref.columns, toCols: edge.src.columns }
}

function bareTable(key: string): string {
  return key.slice(key.indexOf('.') + 1)
}

// Render one path for the prompt: an arrow chain of tables plus the explicit join
// equalities, e.g.
//   users -> user_groups -> groups -> group_roles -> roles
//     [user_groups.user_id = users.id; user_groups.group_id = groups.id; ...]
export function renderPath(path: JoinPath): string {
  if (path.length === 0) return ''
  const chain = [bareTable(path[0].fromKey), ...path.map((s) => bareTable(s.toKey))].join(' -> ')
  const conds = path.map((step) => {
    const { fromCols, toCols } = orientedColumns(step)
    const from = bareTable(step.fromKey)
    const to = bareTable(step.toKey)
    return fromCols
      .map((fc, k) => `${to}.${toCols[k]} = ${from}.${fc}`)
      .join(' AND ')
  })
  return `${chain}  [${conds.join('; ')}]`
}

// The "Ambiguous join paths" prompt section, or '' when the schema has no
// multi-path pairs (nothing for the model to disambiguate).
export function serializeAmbiguousPaths(pairs: AmbiguousPair[]): string {
  if (pairs.length === 0) return ''
  const blocks = pairs.map((pair) => {
    const routes = pair.paths
      .map((p, idx) => `    path ${idx + 1}: ${renderPath(p)}`)
      .join('\n')
    return `- ${bareTable(pair.a)} <-> ${bareTable(pair.b)}:\n${routes}`
  })
  return blocks.join('\n')
}
