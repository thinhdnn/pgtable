// Shared federated-query helpers usable from both the renderer (to show aliases
// in the attach UI) and tests. Keep this dependency-free so it stays importable
// on both sides of the IPC boundary.

/** Default safety cap on a federated result's row count. Applied to bare
 * SELECTs unless the user turns the limit off or writes their own LIMIT. Higher
 * than the query editor's preview limit (500) because a federated run is a
 * deliberate, heavier query. */
export const FEDERATED_ROW_LIMIT = 10000

/**
 * Derive a DuckDB catalog alias from a connection name: lowercase, non-word
 * characters collapsed to `_`, and a `db_` prefix when the result is empty or
 * starts with a digit (DuckDB catalog identifiers shouldn't lead with one). A
 * collision against `taken` is resolved with a `_2`, `_3`, … suffix. The chosen
 * alias is added to `taken` so repeated calls stay unique.
 */
export function deriveAlias(name: string, taken: Set<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (base === '' || /^[0-9]/.test(base)) base = `db_${base}`.replace(/_+$/, '')

  let alias = base
  let n = 1
  while (taken.has(alias)) {
    n += 1
    alias = `${base}_${n}`
  }
  taken.add(alias)
  return alias
}
