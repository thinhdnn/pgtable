// Post-processes pg error messages to surface actionable hints when the raw
// error is misleading. Pure functions — safe to unit-test and to import from
// any renderer surface (QueryEditor, LinkedQueryTab, TableViewer, etc.).

/**
 * Postgres reserved words that, when used **bare** as a table name, silently
 * resolve to a builtin function or value expression instead of raising a
 * "relation does not exist" error. The user then sees a confusing
 * "column X does not exist" instead — because pg happily returned a
 * single-column result from the builtin (e.g. `SELECT * FROM user` becomes
 * `SELECT * FROM current_user` which is a text scalar with no columns
 * beyond the anonymous one).
 *
 * Quoting the identifier (`FROM "user"`) escapes the trap.
 */
const RESERVED_TABLE_TRAPS: Record<string, string> = {
  user: 'current_user',
  session_user: 'session_user',
  current_user: 'current_user',
  current_catalog: 'current_catalog',
  current_schema: 'current_schema',
  current_date: 'current_date',
  current_time: 'current_time',
  current_timestamp: 'current_timestamp',
  localtime: 'localtime',
  localtimestamp: 'localtimestamp'
}

/**
 * Look at the SQL and pg error message together. Return a short human hint
 * if the failure matches a known trap, otherwise null.
 *
 * The hint text is plain UI copy — the caller wraps it in whatever alert or
 * banner is appropriate for the surface.
 */
export function deriveSqlHint(sql: string, errorMessage: string | null | undefined): string | null {
  if (!sql || !errorMessage) return null

  // Trigger only for "column ... does not exist" (pg SQLSTATE 42703). Other
  // errors are unambiguous and don't need a hint.
  if (!/column .* does not exist/i.test(errorMessage)) return null

  // Find every bare (unquoted, non-schema-qualified) identifier that follows
  // FROM/JOIN/UPDATE/INTO and matches a reserved-word trap.
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    const raw = m[1]
    const key = raw.toLowerCase()
    if (RESERVED_TABLE_TRAPS[key]) {
      const builtin = RESERVED_TABLE_TRAPS[key]
      return (
        `"${raw}" is a Postgres reserved keyword — used bare it resolves to the builtin \`${builtin}\`, ` +
        `not your table. If you meant a table named "${raw}", quote it: FROM "${raw}".`
      )
    }
  }

  return null
}
