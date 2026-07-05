import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'
import type { SavedFederatedQuery, SavedFederatedQueryInput } from '@shared/types'

interface StoreSchema {
  queries: SavedFederatedQuery[]
}

// Own store file, separate from the saved-script store (`pgtable-scripts`) and
// the connection/settings stores (D1) — a saved federated query's payload is
// structured (multi-attachment), not plain SQL, so it lives on its own.
// Lazily constructed so this module can be imported in a plain Node (vitest)
// context to unit-test `upsertFederatedQueries` without electron's userData path.
let _store: Store<StoreSchema> | null = null
function store(): Store<StoreSchema> {
  if (!_store) {
    _store = new Store<StoreSchema>({
      name: 'pgtable-federated-scripts',
      defaults: { queries: [] }
    })
  }
  return _store
}

// Outcome of a name-unique upsert (D4). `collision` means a query with the same
// name already exists and the caller did not confirm overwrite — the renderer
// should prompt Overwrite / Rename.
export type UpsertResult =
  | { ok: true; queries: SavedFederatedQuery[]; query: SavedFederatedQuery }
  | { ok: false; collision: true }

// Pure upsert enforcing unique names (D4). Extracted from the store so it can be
// unit-tested without electron-store:
//   - no same-name match            -> append a new query (fresh id/timestamps)
//   - same-name match + overwrite    -> replace in place, keep id + created_at
//   - same-name match, no overwrite  -> report a collision (no mutation)
export function upsertFederatedQueries(
  queries: SavedFederatedQuery[],
  input: SavedFederatedQueryInput,
  now: string
): UpsertResult {
  const name = input.name.trim()
  const idx = queries.findIndex((q) => q.name === name)
  if (idx !== -1) {
    if (!input.overwrite) return { ok: false, collision: true }
    const query: SavedFederatedQuery = {
      ...queries[idx],
      name,
      attachments: input.attachments,
      sql: input.sql,
      autoLimit: input.autoLimit,
      updated_at: now
    }
    const next = [...queries]
    next[idx] = query
    return { ok: true, queries: next, query }
  }
  const query: SavedFederatedQuery = {
    id: uuidv4(),
    name,
    attachments: input.attachments,
    sql: input.sql,
    autoLimit: input.autoLimit,
    created_at: now,
    updated_at: now
  }
  return { ok: true, queries: [...queries, query], query }
}

export function listFederatedQueries(): SavedFederatedQuery[] {
  return store().get('queries')
}

export function saveFederatedQuery(input: SavedFederatedQueryInput): UpsertResult {
  const result = upsertFederatedQueries(store().get('queries'), input, new Date().toISOString())
  if (result.ok) store().set('queries', result.queries)
  return result
}

export function deleteFederatedQuery(id: string): void {
  store().set(
    'queries',
    store()
      .get('queries')
      .filter((q) => q.id !== id)
  )
}
