// Postgres reserved keywords — these cannot be used as an unquoted identifier
// or alias (`user`, `order`, `or`, `as`, ...), so a name matching one is always
// double-quoted even though it looks like a plain lowercase word. Sourced from
// the Postgres SQL key words appendix ("reserved" column).
const RESERVED_IDENTS = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc',
  'asymmetric', 'both', 'case', 'cast', 'check', 'collate', 'column',
  'constraint', 'create', 'current_catalog', 'current_date', 'current_role',
  'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable',
  'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for',
  'foreign', 'from', 'grant', 'group', 'having', 'in', 'initially', 'intersect',
  'into', 'lateral', 'leading', 'limit', 'localtime', 'localtimestamp', 'not',
  'null', 'offset', 'on', 'only', 'or', 'order', 'placing', 'primary',
  'references', 'returning', 'select', 'session_user', 'some', 'symmetric',
  'table', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'user', 'using',
  'variadic', 'when', 'where', 'window', 'with'
])

// Quote a Postgres identifier only when it isn't a safe lowercase name.
// Postgres folds unquoted identifiers to lowercase, so `public`/`users` stay
// bare while mixed-case, reserved words (`user`, `order`), or names with
// special chars get double-quoted (with any embedded quote doubled).
export function qualifyIdent(id: string): string {
  const safe = /^[a-z_][a-z0-9_$]*$/.test(id) && !RESERVED_IDENTS.has(id)
  return safe ? id : `"${id.replace(/"/g, '""')}"`
}
