// Client-side export of a result set (the rows/fields a query returns) to a
// downloadable file. Shared by every result grid, so the cell-stringifying
// rules here must match how QueryResultTable renders a cell: objects become
// JSON, everything else is `String(value)`, and null/undefined is empty.

// Render one cell value the way the grid does, minus the NULL badge — a CSV
// cell for a null value is just empty.
function cellToString(value: unknown): string {
  if (value == null) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

// Field delimiter for a CSV/TSV export. Comma is the RFC 4180 default;
// semicolon is common in locales where comma is the decimal separator, and tab
// gives a TSV.
export type CsvDelimiter = ',' | ';' | '\t'

// Quote a field only when it needs it (contains the delimiter, a quote, or a
// newline), doubling embedded quotes per RFC 4180.
function csvEscape(value: string, delimiter: CsvDelimiter): string {
  const needsQuote = value.includes(delimiter) || /["\n\r]/.test(value)
  return needsQuote ? `"${value.replace(/"/g, '""')}"` : value
}

// A text value Excel would silently coerce on open — losing leading zeros
// ("08023303" → 8023303) or rendering long digit strings as scientific
// notation. Only JS strings qualify: a real number column arrives as a JS
// `number` and Excel handles it correctly, so we never guard those. Dates like
// "3-4" or "1/2" are also risky but left alone for now.
const EXCEL_NUMERIC_LIKE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

// Wrap a text cell in Excel's `="..."` formula syntax so Excel keeps it as
// text. Non-Excel parsers see the literal `="..."`, which is why this is opt-in
// (the "CSV for Excel" export only). Two layers of quoting: Excel doubles the
// quotes inside its formula string, then the whole `="..."` token is run back
// through csvEscape so the outer CSV field is wrapped correctly.
function excelTextGuard(value: string, delimiter: CsvDelimiter): string {
  const formula = `="${value.replace(/"/g, '""')}"`
  return csvEscape(formula, delimiter)
}

export function rowsToCsv(
  fields: string[],
  rows: Record<string, unknown>[],
  delimiter: CsvDelimiter = ',',
  excelSafe = false
): string {
  const cols = fields.length > 0 ? fields : Object.keys(rows[0] ?? {})
  const cell = (raw: unknown): string => {
    const str = cellToString(raw)
    if (excelSafe && typeof raw === 'string' && EXCEL_NUMERIC_LIKE.test(str)) {
      return excelTextGuard(str, delimiter)
    }
    return csvEscape(str, delimiter)
  }
  const header = cols.map((c) => csvEscape(c, delimiter)).join(delimiter)
  const body = rows.map((row) => cols.map((c) => cell(row[c])).join(delimiter))
  return [header, ...body].join('\r\n')
}

export function rowsToJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2)
}

// Trigger a browser download of `content` as a file. Uses a transient object
// URL + anchor click, which works inside Electron's renderer without touching
// the main process.
export function downloadTextFile(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// `query-2026-07-02T14-30-05.csv` — a filesystem-safe timestamped name so
// successive exports don't collide.
export function exportFilename(ext: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `query-${stamp}.${ext}`
}

// Export-menu key → CSV field delimiter. Kept private: callers go through
// exportRowsToFile so every grid maps the same menu keys to the same output.
const EXPORT_DELIMITERS: Record<string, CsvDelimiter> = {
  comma: ',',
  semicolon: ';',
  tab: '\t'
}

// Turn one export-menu key ('comma' | 'semicolon' | 'tab' | 'excel' | 'json')
// into a downloaded file. `fields` fixes the column order for CSV/TSV; `rows`
// is the already-fetched result set. Shared by every result grid so the format
// set and file naming stay identical across the app.
export function exportRowsToFile(
  key: string,
  fields: string[],
  rows: Record<string, unknown>[]
): void {
  if (key === 'json') {
    downloadTextFile(exportFilename('json'), 'application/json', rowsToJson(rows))
    return
  }
  if (key === 'excel') {
    // Comma-delimited with the Excel text-guard (keeps leading zeros / long
    // digit strings from being coerced on open).
    downloadTextFile(exportFilename('csv'), 'text/csv', rowsToCsv(fields, rows, ',', true))
    return
  }
  const delimiter = EXPORT_DELIMITERS[key] ?? ','
  // Tab gives a TSV; comma/semicolon are both `.csv`.
  const ext = key === 'tab' ? 'tsv' : 'csv'
  downloadTextFile(exportFilename(ext), 'text/csv', rowsToCsv(fields, rows, delimiter))
}
