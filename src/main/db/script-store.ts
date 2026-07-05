import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'
import type { SavedScript, SavedScriptInput } from '@shared/types'

interface StoreSchema {
  scripts: SavedScript[]
}

// Own store file, kept separate from the connection list and settings — mirrors
// settings-store.ts (`pgtable-settings`) vs connection-store.ts (`pgtable`).
// Lazily constructed so this module can be imported in a plain Node (vitest)
// context to unit-test `upsertScripts` without electron's userData path.
let _store: Store<StoreSchema> | null = null
function store(): Store<StoreSchema> {
  if (!_store) {
    _store = new Store<StoreSchema>({ name: 'pgtable-scripts', defaults: { scripts: [] } })
  }
  return _store
}

// Outcome of a name-unique upsert (D3). `collision` means a script with the same
// name already exists and the caller did not confirm overwrite — the renderer
// should prompt Overwrite / Rename.
export type UpsertResult =
  | { ok: true; scripts: SavedScript[]; script: SavedScript }
  | { ok: false; collision: true }

// Pure upsert enforcing unique names (D3). Extracted from the store so it can be
// unit-tested without electron-store:
//   - no same-name match            -> append a new script (fresh id/timestamps)
//   - same-name match + overwrite    -> replace in place, keep id + created_at
//   - same-name match, no overwrite  -> report a collision (no mutation)
export function upsertScripts(
  scripts: SavedScript[],
  input: SavedScriptInput,
  now: string
): UpsertResult {
  const name = input.name.trim()
  const idx = scripts.findIndex((s) => s.name === name)
  if (idx !== -1) {
    if (!input.overwrite) return { ok: false, collision: true }
    const script: SavedScript = {
      ...scripts[idx],
      name,
      sql: input.sql,
      connectionId: input.connectionId,
      updated_at: now
    }
    const next = [...scripts]
    next[idx] = script
    return { ok: true, scripts: next, script }
  }
  const script: SavedScript = {
    id: uuidv4(),
    name,
    sql: input.sql,
    connectionId: input.connectionId,
    created_at: now,
    updated_at: now
  }
  return { ok: true, scripts: [...scripts, script], script }
}

export function listScripts(): SavedScript[] {
  return store().get('scripts')
}

export function saveScript(input: SavedScriptInput): UpsertResult {
  const result = upsertScripts(store().get('scripts'), input, new Date().toISOString())
  if (result.ok) store().set('scripts', result.scripts)
  return result
}

export function deleteScript(id: string): void {
  store().set(
    'scripts',
    store()
      .get('scripts')
      .filter((s) => s.id !== id)
  )
}
