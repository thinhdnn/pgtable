import React, { useEffect, useMemo, useState } from 'react'
import { App, Button, Pagination, Tooltip } from 'antd'
import { CopyOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { exportRowsToFile } from '../../utils/export-rows'
import { ExportMenu } from './ExportMenu'

interface Props {
  fields: string[]
  rows: Record<string, unknown>[]
  // Left side of the toolbar — meta text, a key-column selector, etc. The copy
  // button sits before it; the pager (when shown) is pushed to the right.
  toolbarLeft?: React.ReactNode
  // Rows per page. The pager only appears when the row count exceeds it.
  pageSize?: number
  // When set, the table body scrolls inside this height instead of relying on
  // an outer scroll container.
  maxBodyHeight?: number
  // When provided, each row gets a leading "Ask AI" action that hands the row
  // (as a plain object) to the caller. Omitted everywhere except the SQL editor,
  // so other result grids are unchanged.
  onAskRow?: (row: Record<string, unknown>) => void
}

// Read-only result grid shared by the SQL editor and the linked-query steps.
// Uses pg-grid styling so it matches the table viewer, copies a cell on click
// (and all rows as JSON from the toolbar), and pages client-side.
//
// Memoised: the hosting tabs keep the SQL buffer in their own state, so every
// keystroke re-renders them. A page of rows is thousands of cells, and without
// this the grid rebuilt all of them on each character. Callers must pass stable
// `toolbarLeft` / `onAskRow` identities for the memo to hold.
export const QueryResultTable = React.memo(function QueryResultTable({
  fields,
  rows,
  toolbarLeft,
  pageSize = 100,
  maxBodyHeight,
  onAskRow
}: Props): React.ReactElement {
  const { message } = App.useApp()
  const [page, setPage] = useState(1)
  // A fresh result set replaces `rows`; snap back to page 1 so the controlled
  // pager never points past the new data.
  useEffect(() => setPage(1), [rows])

  // Prefer `fields` (preserves the server's column order). Fall back to the
  // first row's keys if pg didn't provide field metadata.
  const cols = fields.length > 0 ? fields : Object.keys(rows[0] ?? {})
  const start = (page - 1) * pageSize
  const paged = useMemo(() => rows.slice(start, start + pageSize), [rows, start, pageSize])

  const copyCell = (s: string): void => {
    navigator.clipboard.writeText(s)
    message.open({ type: 'success', content: 'Cell copied', key: 'pg-copy' })
  }
  const copyAll = (): void => {
    navigator.clipboard.writeText(JSON.stringify(rows, null, 2))
    message.open({ type: 'success', content: `${rows.length} rows copied`, key: 'pg-copy' })
  }

  // Export the full result set (not just the current page) to a downloaded
  // file. CSV/TSV use the server's column order via `cols`.
  const exportAs = (key: string): void => {
    if (rows.length === 0) {
      message.open({ type: 'info', content: 'No rows to export', key: 'pg-export' })
      return
    }
    exportRowsToFile(key, cols, rows)
    message.open({ type: 'success', content: `${rows.length} rows exported`, key: 'pg-export' })
  }

  const table = (
    <table className="pg-grid">
      <thead>
        <tr>
          {onAskRow && <th aria-label="Ask AI" style={{ width: 1 }} />}
          {cols.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {paged.map((row, ri) => (
          <tr key={start + ri} className="pg-row">
            {onAskRow && (
              <td style={{ width: 1, whiteSpace: 'nowrap', textAlign: 'center' }}>
                <Tooltip title="Ask AI about this row (sends the row values to your AI provider)">
                  <Button
                    size="small"
                    type="text"
                    icon={<ThunderboltOutlined />}
                    onClick={() => onAskRow(row)}
                  />
                </Tooltip>
              </td>
            )}
            {cols.map((c) => {
              const raw = row[c]
              if (raw == null) {
                return (
                  <td key={c}>
                    <span className="pg-null">NULL</span>
                  </td>
                )
              }
              const str = typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
              const cell = (
                <span className="pg-cell" style={{ cursor: 'pointer' }} onClick={() => copyCell(str)}>
                  {str}
                </span>
              )
              // Only long values get a Tooltip. antd renders the full rc-trigger
              // even when `title` is undefined, so wrapping every cell cost one
              // trigger per cell for nothing.
              return (
                <td key={c}>{str.length > 80 ? <Tooltip title={str}>{cell}</Tooltip> : cell}</td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )

  // Toolbar stays fixed while the table body scrolls beneath it. Without an
  // explicit maxBodyHeight the component fills its parent (e.g. the SQL editor's
  // result pane) and scrolls internally, so the sticky <thead> anchors to the
  // top of the body scroll — not shared with the toolbar, which is what let the
  // column header slide under the toolbar before.
  const bodyStyle: React.CSSProperties =
    maxBodyHeight != null
      ? { overflow: 'auto', maxHeight: maxBodyHeight }
      : { flex: 1, minHeight: 0, overflow: 'auto' }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        ...(maxBodyHeight != null ? {} : { height: '100%' })
      }}
    >
      <div
        style={{
          padding: '4px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          flexShrink: 0,
          background: 'var(--ant-color-bg-container)',
          borderBottom: '1px solid var(--ant-color-border-secondary)'
        }}
      >
        <Tooltip title="Copy all rows as JSON">
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={copyAll} />
        </Tooltip>
        <ExportMenu onSelect={exportAs} tooltip="Export all rows" />
        {toolbarLeft}
        {rows.length > pageSize && (
          <Pagination
            style={{ marginLeft: 'auto' }}
            size="small"
            current={page}
            pageSize={pageSize}
            total={rows.length}
            showSizeChanger={false}
            onChange={setPage}
          />
        )}
      </div>
      <div style={bodyStyle}>{table}</div>
    </div>
  )
})
