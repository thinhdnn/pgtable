// Pure SQL statement classification, shared by the main process and the renderer.
// No Node, no Electron, no React — `@shared/*` is imported from both sides.
//
// Two functions live here that look interchangeable and are NOT:
//
//   isNonMutatingStatement  SELECT | WITH | TABLE | VALUES   (this file)
//   isReadOnlyStatement     SELECT | WITH                    (linked-query/executor.ts)
//
// The first answers "would applying this statement change data?" and drives the
// non-SELECT warning shown before a user runs AI-authored SQL. `TABLE t` and
// `VALUES (1)` read data, so they are *not* mutations and must not warn.
//
// The second is an execution guard: it decides what the linked-query runner and
// the DuckDB federated runner will let through at all. It is deliberately
// narrowed to SELECT/WITH per linked-query constraint C1 — TABLE and VALUES are
// legal but rare, and accepting them widens the guard for no benefit.
//
// Widening the guard to match the classifier would be a safety regression.
// Narrowing the classifier to match the guard would warn about harmless reads.
// Keep them apart. `sql-statement.test.ts` and `executor.test.ts` both pin this.

/**
 * Replaces line/block comments and string bodies with spaces of the same length
 * so byte offsets stay aligned with the original SQL. That alignment is what
 * lets `rewritePlaceholder` scan the sanitised copy for tokens and then splice
 * into the *original* text (linked-query constraint C2).
 *
 * Handles `-- line`, `/* block *\/`, `'quoted'` (with `''` escapes), and
 * `$tag$ dollar quoted $tag$` bodies.
 */
export function stripCommentsAndStrings(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const start = i
      while (i < sql.length && sql[i] !== '\n') i++
      out += ' '.repeat(i - start)
      continue
    }
    if (ch === '/' && next === '*') {
      const start = i
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      if (i < sql.length) i += 2
      out += ' '.repeat(i - start)
      continue
    }
    if (ch === "'") {
      const start = i
      i++
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i++; break }
        i++
      }
      out += ' '.repeat(i - start)
      continue
    }
    if (ch === '$') {
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)
      if (m) {
        const start = i
        const tag = m[0]
        i += tag.length
        const end = sql.indexOf(tag, i)
        i = end === -1 ? sql.length : end + tag.length
        out += ' '.repeat(i - start)
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

/**
 * True when the statement only reads data (SELECT / WITH / TABLE / VALUES).
 *
 * Used to decide whether AI-authored SQL needs the non-SELECT warning before the
 * user runs it. Comments and string bodies are stripped first so a keyword
 * hidden in text (`SELECT 'DROP TABLE users'`) can't fool it, and a leading
 * comment can't hide the real verb.
 *
 * This is NOT the runner's read-only guard. See the note at the top of the file.
 */
export function isNonMutatingStatement(sql: string): boolean {
  const sanitized = stripCommentsAndStrings(sql.replace(/;\s*$/, '').trim()).trim()
  return /^(SELECT|WITH|TABLE|VALUES)\b/i.test(sanitized)
}
