import { qualifyIdent } from './sql-ident'

// Short table alias from the initials of a snake_case / camelCase name:
// `session_history` → `sh`, `declaration_case` → `dc`, `users` → `u`. Falls
// back to the first character so it's always a non-empty lowercase identifier.
// Quoted through qualifyIdent so a reserved-word initial (e.g. `order_records`
// → `or`) stays valid.
export function deriveTableAlias(table: string): string {
  const parts = table
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // split camelCase boundaries
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
  const initials = parts.map((p) => p[0]).join('').toLowerCase()
  return qualifyIdent(initials || table.slice(0, 1).toLowerCase() || 't')
}

// Starter query for a table: `SELECT <alias>.* FROM <schema>.<table> AS <alias>;`.
// The alias keeps column references short once the user starts adding a WHERE
// clause, and the editor's auto-LIMIT safety net still caps bare SELECTs.
export function buildSelectSql(schema: string, table: string): string {
  const alias = deriveTableAlias(table)
  return `SELECT ${alias}.* FROM ${qualifyIdent(schema)}.${qualifyIdent(table)} AS ${alias};`
}
