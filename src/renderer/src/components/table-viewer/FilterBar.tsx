import React, { useEffect, useState } from 'react'
import { Select, Input, Button, Tooltip, theme } from 'antd'
import type { ColumnFilter, FilterOp } from '@shared/types'

interface Props {
  /** Column names to choose from. */
  columns: string[]
  /** Current filters keyed by column, so the bar can reflect an existing one. */
  filters: Record<string, ColumnFilter>
  /** Set or clear the filter for a column. */
  onChange: (column: string, next: ColumnFilter | null) => void
  /** When embedded in another toolbar, drop the outer padding/border so the
   *  host controls row chrome. Defaults to standalone (bordered). */
  embedded?: boolean
}

// Strip a single pair of matching surrounding quotes, if present.
function stripQuotes(s: string): string {
  const t = s.trim()
  if (t.length >= 2) {
    const q = t[0]
    if ((q === "'" || q === '"') && t[t.length - 1] === q) {
      return t.slice(1, -1)
    }
  }
  return t
}

// Symbolic operators, longest-first so '>=' wins over '>'.
const SYMBOL_OPS: Array<[string, FilterOp]> = [
  ['>=', 'gte'],
  ['<=', 'lte'],
  ['<>', 'neq'],
  ['!=', 'neq'],
  ['=', 'eq'],
  ['>', 'gt'],
  ['<', 'lt']
]

// Parse a typed condition ("= 'ag'", "like '%a'", "> 5", "is null") into a
// structured, parameterizable filter. Returns null for empty input. The value
// is always bound as a query parameter downstream — never spliced into SQL.
export function parseExpression(input: string): { op: FilterOp; value?: string } | null {
  const s = input.trim()
  if (!s) return null
  const lower = s.toLowerCase()

  if (lower === 'is null') return { op: 'is_null' }
  if (lower === 'is not null') return { op: 'is_not_null' }

  const ilike = s.match(/^ilike\s+(.*)$/i)
  if (ilike) return { op: 'ilike', value: stripQuotes(ilike[1]) }
  const like = s.match(/^like\s+(.*)$/i)
  if (like) return { op: 'like', value: stripQuotes(like[1]) }

  for (const [sym, op] of SYMBOL_OPS) {
    if (s.startsWith(sym)) return { op, value: stripQuotes(s.slice(sym.length)) }
  }

  // No recognised operator: treat the whole thing as a "contains" search.
  return { op: 'contains', value: stripQuotes(s) }
}

// Render an existing filter back into an editable expression string.
function filterToExpr(f: ColumnFilter): string {
  switch (f.op) {
    case 'is_null':
      return 'is null'
    case 'is_not_null':
      return 'is not null'
    case 'eq':
      return `= '${f.value ?? ''}'`
    case 'neq':
      return `<> '${f.value ?? ''}'`
    case 'gt':
      return `> ${f.value ?? ''}`
    case 'gte':
      return `>= ${f.value ?? ''}`
    case 'lt':
      return `< ${f.value ?? ''}`
    case 'lte':
      return `<= ${f.value ?? ''}`
    case 'like':
      return `like '${f.value ?? ''}'`
    case 'ilike':
      return `ilike '${f.value ?? ''}'`
    case 'starts_with':
      return `like '${f.value ?? ''}%'`
    case 'contains':
    default:
      return f.value ?? ''
  }
}

export function FilterBar({ columns, filters, onChange, embedded = false }: Props): React.ReactElement {
  const { token } = theme.useToken()
  const [column, setColumn] = useState<string | undefined>(undefined)
  const [expr, setExpr] = useState('')

  // Default to the first column once data arrives; keep the choice otherwise.
  useEffect(() => {
    if (!column && columns.length) setColumn(columns[0])
  }, [columns, column])

  // When switching columns, seed the input with that column's active filter.
  useEffect(() => {
    if (!column) return
    const f = filters[column]
    setExpr(f ? filterToExpr(f) : '')
  }, [column, filters])

  const apply = (): void => {
    if (!column) return
    const parsed = parseExpression(expr)
    if (!parsed) {
      onChange(column, null)
      return
    }
    onChange(column, { column, op: parsed.op, ...(parsed.value != null ? { value: parsed.value } : {}) })
  }

  const clear = (): void => {
    if (column) onChange(column, null)
    setExpr('')
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: embedded ? 0 : '5px 12px',
        borderBottom: embedded ? undefined : `1px solid ${token.colorBorderSecondary}`,
        flexShrink: 0
      }}
    >
      <Select
        size="small"
        showSearch
        value={column}
        onChange={setColumn}
        options={columns.map((c) => ({ label: c, value: c }))}
        placeholder="field"
        style={{ width: 160, flexShrink: 0 }}
        popupMatchSelectWidth={false}
      />
      <Tooltip title="e.g.  = 'ag'   ·   like '%a'   ·   > 5   ·   is null" placement="topLeft">
        <Input
          size="small"
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          onPressEnter={apply}
          placeholder="= 'ag'   or   like '%a'"
          style={{ flex: 1, minWidth: 0 }}
        />
      </Tooltip>
      <Button size="small" type="primary" onClick={apply} disabled={!column}>
        Apply
      </Button>
      <Button size="small" onClick={clear} disabled={!column || !filters[column ?? '']}>
        Clear
      </Button>
    </div>
  )
}
