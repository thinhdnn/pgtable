import { sql, PostgreSQL } from '@codemirror/lang-sql'
import type { CompletionSource } from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'

export interface SchemaPayload {
  tables: Array<{ schema: string; name: string; columns: string[] }>
}

// Pull the table references out of a statement's FROM / JOIN clauses so we can
// offer their columns at a bare cursor position. Captures `schema.table`,
// `table`, and `table alias` / `table AS alias` forms. Good enough for the
// single-statement editors without dragging in the full parse tree.
function extractFromTables(sql: string): string[] {
  const re = /\b(?:from|join)\s+([a-zA-Z_][\w$]*(?:\s*\.\s*[a-zA-Z_][\w$]*)?)/gi
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) out.push(m[1].replace(/\s+/g, ''))
  return out
}

// Completion source that fills the gap in @codemirror/lang-sql: at a bare
// (non-qualified) identifier position it doesn't infer columns from the FROM
// clause, so you only get keywords + table names. This looks up the tables in
// scope and offers their columns directly. Qualified `table.` completions are
// left to the built-in schema source.
function fromColumnCompletionSource(schema: SchemaPayload | null): CompletionSource {
  const byName = new Map<string, string[]>()
  if (schema) {
    for (const t of schema.tables) {
      byName.set(`${t.schema}.${t.name}`.toLowerCase(), t.columns)
      const bare = t.name.toLowerCase()
      if (!byName.has(bare)) byName.set(bare, t.columns)
    }
  }
  return (ctx) => {
    if (byName.size === 0) return null
    const word = ctx.matchBefore(/[\w$]*/)
    if (!word) return null
    // Skip qualified positions (`x.` / `x.y`) — the schema source owns those.
    if (ctx.state.sliceDoc(Math.max(0, word.from - 1), word.from) === '.') return null
    if (!ctx.explicit && word.from === word.to) return null
    const cols = new Set<string>()
    for (const ref of extractFromTables(ctx.state.doc.toString())) {
      const found = byName.get(ref.toLowerCase())
      if (found) for (const c of found) cols.add(c)
    }
    if (cols.size === 0) return null
    return {
      from: word.from,
      // boost keeps columns above same-prefix SQL keywords in the popup.
      options: [...cols].map((label) => ({ label, type: 'property', boost: 1 })),
      validFor: /^[\w$]*$/
    }
  }
}

// Build the CodeMirror SQL extension with schema-aware completion. Feeds real
// table/column names to lang-sql (so `table.` and `alias.` complete columns)
// and adds a FROM-aware source so columns also surface at bare positions.
// Pass `schema = null` before introspection resolves — you get plain keyword
// completion until it does.
export function buildSqlExtension(schema: SchemaPayload | null): Extension {
  const schemaMap: Record<string, string[]> = {}
  const tablesList: Array<{ label: string; type?: string }> = []
  if (schema) {
    for (const t of schema.tables) {
      const qualified = `${t.schema}.${t.name}`
      schemaMap[qualified] = t.columns
      // Also let `t.name` complete on its own (covers public-schema cases
      // and anything in the user's search_path).
      if (!schemaMap[t.name]) schemaMap[t.name] = t.columns
      tablesList.push({ label: qualified, type: 'table' })
    }
  }
  const base = sql({
    dialect: PostgreSQL,
    schema: schemaMap,
    tables: tablesList,
    upperCaseKeywords: true
  })
  return [base, PostgreSQL.language.data.of({ autocomplete: fromColumnCompletionSource(schema) })]
}
