import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
  type SortingState
} from '@tanstack/react-table'
import {
  Select,
  Button,
  Space,
  Alert,
  Typography,
  Tooltip,
  Segmented,
  Dropdown,
  message,
  theme
} from 'antd'
import {
  CaretUpOutlined,
  CaretDownOutlined,
  LeftOutlined,
  RightOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type {
  TableDataPayload,
  TableExportPayload,
  TableExportResult,
  IpcResult,
  ColumnFilter
} from '@shared/types'
import { IPC } from '@shared/ipc-channels'
import { invoke } from '../../api'
import { useTableData, usePrimaryKeys, useColumns } from '../../hooks/useDatabases'
import { LoadingPanel, LoadingOverlay } from '../Loading'
import { exportRowsToFile } from '../../utils/export-rows'
import { ExportMenu } from '../common/ExportMenu'
import { ColumnFilterButton } from './ColumnFilter'
import { FilterBar } from './FilterBar'
import { ColumnPicker } from './ColumnPicker'
import { AskRowModal } from '../common/AskRowModal'
import { useActiveConnection } from '../../store/active-connection'

// Stable string view of a cell value, for inputs and change detection.
function toStr(v: unknown): string {
  if (v == null) return ''
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

const { Text } = Typography

const PAGE_SIZES = [100, 500, 1000] as const
type PageSize = (typeof PAGE_SIZES)[number]

export interface GridApi {
  refresh: () => void
  copy: () => void
  /** Persist all dirty drafts. Returns true if every update succeeded. */
  saveAll: () => Promise<boolean>
}

/** 'horizontal' = classic grid; 'vertical' = one record at a time as field|value rows. */
export type Orientation = 'horizontal' | 'vertical'

interface Props {
  connectionId: string
  database: string
  schema: string
  table: string
  /** Whether the grid is in edit mode. Controlled by the parent toolbar. */
  editing?: boolean
  /** Layout mode. Defaults to horizontal grid. */
  orientation?: Orientation
  /** Report row/selection counts and edit-capability up so the parent can render the tab bar. */
  onMeta?: (meta: { total: number; selected: number; canEdit: boolean }) => void
  /** Expose refresh/copy/saveAll actions so the parent's tab-bar buttons can trigger them. */
  registerApi?: (api: GridApi) => void
}

export function DataGrid({
  connectionId,
  database,
  schema,
  table,
  editing = false,
  orientation = 'horizontal',
  onMeta,
  registerApi
}: Props) {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<PageSize>(100)
  const [sorting, setSorting] = useState<SortingState>([])
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({})
  // Which columns to show; null = show all. Driven by the ColumnPicker.
  const [visibleCols, setVisibleCols] = useState<string[] | null>(null)
  const [selectedRows, setSelectedRows] = useState<Record<string, unknown>[]>([])
  const [exporting, setExporting] = useState(false)
  // Right-click "Ask AI about this row". antd's contextMenu Dropdown positions the
  // menu at the cursor; we just record which row was right-clicked (set on the
  // row's onContextMenu, which bubbles to the Dropdown before the menu opens) and
  // the popup target. Null askRow = closed.
  const rightRowRef = useRef<Record<string, unknown> | null>(null)
  const [askRow, setAskRow] = useState<Record<string, unknown> | null>(null)
  const [msg, msgCtx] = message.useMessage()
  const { token } = theme.useToken()
  const { openQueryTab } = useActiveConnection()

  const scrollRef = useRef<HTMLDivElement>(null)
  const theadRef = useRef<HTMLTableSectionElement>(null)
  const tbodyRef = useRef<HTMLTableSectionElement>(null)
  const [fillerCount, setFillerCount] = useState(0)

  // Active record (vertical mode). Clamped via an effect below once data loads.
  const [recordIndex, setRecordIndex] = useState(0)

  const pkRes = usePrimaryKeys(connectionId, database, schema, table)
  const pkCols = Array.isArray(pkRes.data) ? pkRes.data : []
  const canEdit = pkCols.length > 0

  const colsRes = useColumns(connectionId, database, schema, table)

  // Per-row drafts keyed by tanstack row id. Only populated while editing.
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState(false)

  const sort = sorting[0]
  const filterList = React.useMemo(() => Object.values(filters), [filters])
  const params: TableDataPayload = {
    connectionId,
    database,
    schema,
    table,
    limit: pageSize,
    offset: page * pageSize,
    sortColumn: sort?.id,
    sortDir: sort ? (sort.desc ? 'desc' : 'asc') : undefined,
    filters: filterList.length ? filterList : undefined
  }

  const setColumnFilter = useCallback((column: string, next: ColumnFilter | null) => {
    setPage(0)
    setFilters((prev) => {
      const copy = { ...prev }
      if (!next) delete copy[column]
      else copy[column] = next
      return copy
    })
  }, [])

  const { data, isLoading, isFetching, error, refetch } = useTableData(params)

  // Stable column list for the filter bar, independent of the current (possibly
  // empty) result set. Falls back to the visible row's keys before it loads.
  const columnNames = React.useMemo(() => {
    if (Array.isArray(colsRes.data) && colsRes.data.length) return colsRes.data.map((c) => c.name)
    return data?.rows.length ? Object.keys(data.rows[0]) : []
  }, [colsRes.data, data])

  // Translate the picked-column list into TanStack's visibility map.
  // {} means every column is visible.
  const columnVisibility = React.useMemo<Record<string, boolean>>(() => {
    if (!visibleCols) return {}
    const set = new Set(visibleCols)
    return Object.fromEntries(columnNames.map((c) => [c, set.has(c)]))
  }, [visibleCols, columnNames])

  const columns = React.useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    if (!data?.rows.length) return []
    return Object.keys(data.rows[0]).map((key) => ({
      id: key,
      accessorKey: key,
      header: () => (
        <span className="pg-th-content">
          <span
            className="pg-th-label"
            onClick={() => {
              setSorting((prev) => {
                const existing = prev.find((s) => s.id === key)
                if (!existing) return [{ id: key, desc: false }]
                if (!existing.desc) return [{ id: key, desc: true }]
                return []
              })
            }}
          >
            {key}
            {sort?.id === key ? (
              sort.desc ? (
                <CaretDownOutlined style={{ marginLeft: 4, color: token.colorPrimary }} />
              ) : (
                <CaretUpOutlined style={{ marginLeft: 4, color: token.colorPrimary }} />
              )
            ) : null}
          </span>
          <ColumnFilterButton
            connectionId={connectionId}
            database={database}
            schema={schema}
            table={table}
            column={key}
            value={filters[key]}
            onChange={(next) => setColumnFilter(key, next)}
          />
        </span>
      ),
      cell: ({ getValue }) => {
        const val = getValue()
        if (val == null) return <span className="pg-null">NULL</span>
        const str = String(val)
        return (
          <Tooltip title={str.length > 80 ? str : undefined}>
            <span
              className="pg-cell"
              style={{ cursor: 'pointer' }}
              onClick={(e) => {
                // Cmd/Ctrl-click is row selection — let it bubble to the row.
                if (e.metaKey || e.ctrlKey) return
                e.stopPropagation()
                navigator.clipboard.writeText(str)
                msg.open({ type: 'success', content: 'Cell copied', key: 'pg-copy' })
              }}
            >
              {str}
            </span>
          </Tooltip>
        )
      }
    }))
  }, [
    data,
    sort,
    msg,
    token.colorPrimary,
    filters,
    setColumnFilter,
    connectionId,
    database,
    schema,
    table
  ])

  const tableInstance = useReactTable({
    data: data?.rows ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting
  })

  const copyRows = useCallback(
    (rows: Record<string, unknown>[]) => {
      navigator.clipboard.writeText(JSON.stringify(rows, null, 2))
      msg.open({
        type: 'success',
        content: `${rows.length} row${rows.length === 1 ? '' : 's'} copied`,
        key: 'pg-copy'
      })
    },
    [msg]
  )

  // Export every row matching the current filters/sort (not just the visible
  // page) to a downloaded file. Fetches server-side via TABLE_EXPORT, then runs
  // the rows through the same stringifying rules the query grid uses. Columns
  // follow the current ColumnPicker selection so the file matches the view.
  const exportRows = useCallback(
    async (key: string) => {
      const fields = visibleCols ?? columnNames
      setExporting(true)
      msg.open({ type: 'loading', content: 'Preparing export…', key: 'pg-export', duration: 0 })
      try {
        const res = await invoke<TableExportResult | { error: string }>(IPC.TABLE_EXPORT, {
          connectionId,
          database,
          schema,
          table,
          sortColumn: sort?.id,
          sortDir: sort ? (sort.desc ? 'desc' : 'asc') : undefined,
          filters: filterList.length ? filterList : undefined,
          columns: visibleCols ?? undefined
        } satisfies TableExportPayload)
        if ('error' in res) {
          msg.open({ type: 'error', content: res.error, key: 'pg-export' })
          return
        }
        const { rows, truncated } = res
        if (rows.length === 0) {
          msg.open({ type: 'info', content: 'No rows to export', key: 'pg-export' })
          return
        }
        exportRowsToFile(key, fields, rows)
        const n = rows.length.toLocaleString()
        msg.open({
          type: truncated ? 'warning' : 'success',
          content: truncated
            ? `Exported first ${n} rows (export cap reached)`
            : `${n} row${rows.length === 1 ? '' : 's'} exported`,
          key: 'pg-export'
        })
      } finally {
        setExporting(false)
      }
    },
    [connectionId, database, schema, table, sort, filterList, visibleCols, columnNames, msg]
  )

  const startEdit = useCallback(() => {
    if (!data?.rows.length) return
    // Snapshot every visible row's current values into drafts, keyed by the
    // tanstack row id (the row index as a string).
    const next: Record<string, Record<string, string>> = {}
    data.rows.forEach((row, idx) => {
      const r: Record<string, string> = {}
      for (const [k, v] of Object.entries(row)) r[k] = toStr(v)
      next[String(idx)] = r
    })
    setDrafts(next)
  }, [data])

  const setCell = useCallback((rowId: string, col: string, value: string) => {
    setDrafts((d) => ({ ...d, [rowId]: { ...(d[rowId] ?? {}), [col]: value } }))
  }, [])

  // Persist every row whose draft differs from the original. Sequential, so a
  // failure leaves the remaining rows untouched and the user sees the offender.
  const saveAll = useCallback(async (): Promise<boolean> => {
    if (!data?.rows.length) return true
    const dirty: Array<{ original: Record<string, unknown>; changes: Record<string, unknown> }> = []
    data.rows.forEach((row, idx) => {
      const d = drafts[String(idx)]
      if (!d) return
      const changes: Record<string, unknown> = {}
      for (const col of Object.keys(row)) {
        if ((d[col] ?? '') !== toStr(row[col])) changes[col] = d[col]
      }
      if (Object.keys(changes).length > 0) dirty.push({ original: row, changes })
    })
    if (dirty.length === 0) {
      setDrafts({})
      return true
    }
    if (!canEdit) {
      msg.error('Table has no primary key; cannot identify rows to update.')
      return false
    }

    setSaving(true)
    let okCount = 0
    for (const { original, changes } of dirty) {
      const pk: Record<string, unknown> = {}
      for (const c of pkCols) pk[c] = original[c]
      const res = await invoke<IpcResult<{ rowCount: number }>>(IPC.ROW_UPDATE, {
        connectionId,
        database,
        schema,
        table,
        pk,
        changes
      })
      if ('error' in res) {
        msg.error(res.error)
        setSaving(false)
        return false
      }
      okCount++
    }
    setSaving(false)
    msg.open({
      type: 'success',
      content: `Saved ${okCount} row${okCount === 1 ? '' : 's'}`,
      key: 'pg-copy'
    })
    setDrafts({})
    refetch()
    return true
  }, [data, drafts, canEdit, pkCols, connectionId, database, schema, table, msg, refetch])

  const totalHint = data?.total_hint ?? 0

  // Surface counts and edit-capability to the parent so the toolbar can render correctly.
  useEffect(() => {
    onMeta?.({ total: totalHint, selected: selectedRows.length, canEdit })
  }, [onMeta, totalHint, selectedRows.length, canEdit])

  useEffect(() => {
    registerApi?.({
      refresh: () => refetch(),
      copy: () => copyRows(selectedRows.length ? selectedRows : data?.rows ?? []),
      saveAll
    })
  }, [registerApi, refetch, copyRows, selectedRows, data, saveAll])

  // Sync drafts with the parent-controlled `editing` flag. Entering edit mode
  // snapshots the visible rows; leaving it clears drafts.
  useEffect(() => {
    if (editing) startEdit()
    else setDrafts({})
  }, [editing, startEdit])

  // Drop any in-flight drafts when the underlying data changes (page, sort, refresh).
  useEffect(() => {
    setDrafts({})
  }, [data])

  // Keep recordIndex inside the current page bounds when data changes.
  useEffect(() => {
    if (!data?.rows.length) {
      setRecordIndex(0)
      return
    }
    setRecordIndex((i) => (i >= data.rows.length ? data.rows.length - 1 : i))
  }, [data])

  // Pad short results with blank rows so the grid fills the viewport instead of
  // leaving a large empty area. Recomputed on data and container-size changes.
  const rowCount = data?.rows.length ?? 0
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const compute = () => {
      const firstRow = tbodyRef.current?.querySelector<HTMLElement>('tr.pg-row')
      if (!rowCount || !firstRow) {
        setFillerCount(0)
        return
      }
      const rowH = firstRow.offsetHeight || 28
      const headH = theadRef.current?.offsetHeight ?? 0
      const free = el.clientHeight - headH - rowCount * rowH
      setFillerCount(free > rowH ? Math.floor(free / rowH) : 0)
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rowCount, columns.length, pageSize])

  if (isLoading && !data) {
    return <LoadingPanel />
  }
  if (error) return <Alert type="error" message={String(error)} style={{ margin: 16 }} />

  const totalPages = pageSize > 0 ? Math.ceil(totalHint / pageSize) : 1
  const barBorder = `1px solid ${token.colorBorderSecondary}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      {msgCtx}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 12px 5px 4px',
          borderBottom: barBorder,
          flexShrink: 0
        }}
      >
        <ColumnPicker columns={columnNames} visible={visibleCols} onApply={setVisibleCols} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <FilterBar columns={columnNames} filters={filters} onChange={setColumnFilter} embedded />
        </div>
        <ExportMenu
          onSelect={exportRows}
          loading={exporting}
          tooltip="Export all rows matching the current filters & sort"
        />
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto' }}>
        {orientation === 'vertical' ? (
          <RecordView
            columns={visibleCols ?? columnNames}
            rows={data?.rows ?? []}
            recordIndex={recordIndex}
            setRecordIndex={setRecordIndex}
            editing={editing}
            saving={saving}
            drafts={drafts}
            setCell={setCell}
            msg={msg}
          />
        ) : (
          <Dropdown
            trigger={['contextMenu']}
            menu={{
              items: [
                { key: 'ask', icon: <ThunderboltOutlined />, label: 'Ask AI about this row' }
              ],
              onClick: () => {
                if (rightRowRef.current) setAskRow(rightRowRef.current)
              }
            }}
          >
          <table className="pg-grid">
          <thead ref={theadRef}>
            {tableInstance.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody ref={tbodyRef}>
            {tableInstance.getRowModel().rows.map((row) => {
              const isSelected = selectedRows.some((r) => r === row.original)
              const rowDraft = editing ? drafts[row.id] : undefined
              return (
                <tr
                  key={row.id}
                  className={isSelected ? 'pg-row pg-row-selected' : 'pg-row'}
                  onContextMenu={() => {
                    rightRowRef.current = row.original
                  }}
                  onClick={(e) => {
                    // Plain click copies the cell; only Cmd/Ctrl-click selects rows.
                    // Row selection is disabled while editing.
                    if (editing) return
                    if (!(e.metaKey || e.ctrlKey)) return
                    const rowData = row.original
                    setSelectedRows((prev) => {
                      const has = prev.some((r) => r === rowData)
                      return has ? prev.filter((r) => r !== rowData) : [...prev, rowData]
                    })
                  }}
                >
                  {row.getVisibleCells().map((cell) => {
                    const colId = cell.column.id
                    if (rowDraft) {
                      return (
                        <td key={cell.id}>
                          <input
                            className="pg-edit-input"
                            value={rowDraft[colId] ?? ''}
                            disabled={saving}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setCell(row.id, colId, e.target.value)}
                          />
                        </td>
                      )
                    }
                    return (
                      <td key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {/* Non-interactive blank rows to fill the remaining viewport height. */}
            {Array.from({ length: fillerCount }).map((_, i) => (
              <tr key={`filler-${i}`} className="pg-row-filler" aria-hidden>

                {tableInstance.getVisibleLeafColumns().map((c) => (
                  <td key={c.id}>{' '}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
          </Dropdown>
        )}
      </div>

      <div
        style={{
          padding: '6px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderTop: barBorder,
          flexShrink: 0
        }}
      >
        <Space>
          <Button size="small" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ‹ Prev
          </Button>
          <Text className="tabular" style={{ fontSize: 12 }}>
            Page {page + 1} {totalPages > 0 ? `/ ${totalPages}` : ''}
          </Text>
          <Button
            size="small"
            disabled={data ? data.rows.length < pageSize : true}
            onClick={() => setPage((p) => p + 1)}
          >
            Next ›
          </Button>
        </Space>
        <Select
          size="small"
          value={pageSize}
          onChange={(v) => {
            setPageSize(v)
            setPage(0)
          }}
          options={PAGE_SIZES.map((s) => ({ label: `${s} / page`, value: s }))}
          style={{ width: 120, marginLeft: 'auto' }}
        />
      </div>
      <AskRowModal
        open={askRow != null}
        onClose={() => setAskRow(null)}
        row={askRow}
        columns={visibleCols ?? columnNames}
        connectionId={connectionId}
        database={database}
        schema={schema}
        sourceTable={table}
        insertSqlLabel="Open in new SQL editor"
        onInsertSql={(sql) => openQueryTab(connectionId, database, { kind: 'sql', sql })}
      />
      {isFetching && <LoadingOverlay />}
    </div>
  )
}

// Vertical record view: one row at a time, shown as Field | Value pairs.
// Editing reuses the parent's `drafts` keyed by string(recordIndex), matching
// how the horizontal grid stores per-row drafts.
interface RecordViewProps {
  columns: string[]
  rows: Record<string, unknown>[]
  recordIndex: number
  setRecordIndex: React.Dispatch<React.SetStateAction<number>>
  editing: boolean
  saving: boolean
  drafts: Record<string, Record<string, string>>
  setCell: (rowId: string, col: string, value: string) => void
  msg: ReturnType<typeof message.useMessage>[0]
}

function RecordView({
  columns,
  rows,
  recordIndex,
  setRecordIndex,
  editing,
  saving,
  drafts,
  setCell,
  msg
}: RecordViewProps): React.ReactElement {
  const [mode, setMode] = useState<'single' | 'all'>('single')

  if (!rows.length) {
    return (
      <div style={{ padding: 24, opacity: 0.6, fontSize: 13 }}>No rows in current page.</div>
    )
  }
  // Respect the parent's visible-column selection (falls back to all columns).
  const cols = columns

  const renderValueCell = (rowIdx: number, col: string, raw: unknown) => {
    const rowDraft = editing ? drafts[String(rowIdx)] : undefined
    const str = raw == null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
    if (rowDraft) {
      return (
        <input
          className="pg-edit-input"
          value={rowDraft[col] ?? ''}
          disabled={saving}
          onChange={(e) => setCell(String(rowIdx), col, e.target.value)}
        />
      )
    }
    if (raw == null) return <span className="pg-null">NULL</span>
    return (
      <Tooltip title={str.length > 80 ? str : undefined}>
        <span
          className="pg-cell"
          style={{ cursor: 'pointer' }}
          onClick={() => {
            navigator.clipboard.writeText(str)
            msg.open({ type: 'success', content: 'Cell copied', key: 'pg-copy' })
          }}
        >
          {str}
        </span>
      </Tooltip>
    )
  }

  const i = Math.min(recordIndex, rows.length - 1)

  return (
    <div style={{ padding: '8px 12px' }}>
      <Space size={8} style={{ marginBottom: 8 }} wrap>
        <Segmented<'single' | 'all'>
          size="small"
          value={mode}
          onChange={(v) => setMode(v)}
          options={[
            { label: 'Single', value: 'single' },
            { label: 'All', value: 'all' }
          ]}
        />
        {mode === 'single' && (
          <Space size={4}>
            <Button
              size="small"
              icon={<LeftOutlined />}
              disabled={i === 0}
              onClick={() => setRecordIndex((v) => Math.max(0, v - 1))}
            />
            <Typography.Text className="tabular" style={{ fontSize: 12 }}>
              Row {i + 1} / {rows.length}
            </Typography.Text>
            <Button
              size="small"
              icon={<RightOutlined />}
              disabled={i >= rows.length - 1}
              onClick={() => setRecordIndex((v) => Math.min(rows.length - 1, v + 1))}
            />
          </Space>
        )}
        {mode === 'all' && (
          <Typography.Text className="tabular" style={{ fontSize: 12 }}>
            {rows.length} row{rows.length === 1 ? '' : 's'} · scroll →
          </Typography.Text>
        )}
      </Space>
      {mode === 'single' ? (
        <table className="pg-grid pg-record-grid">
          <tbody>
            {cols.map((col) => (
              <tr key={col} className="pg-row">
                <th className="pg-record-field">{col}</th>
                <td>{renderValueCell(i, col, rows[i][col])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="pg-grid pg-record-grid pg-record-grid-all">
          <thead>
            <tr>
              <th className="pg-record-field pg-record-field-head">Field</th>
              {rows.map((_, idx) => (
                <th key={idx} className="pg-record-col-head">
                  Row {idx + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cols.map((col) => (
              <tr key={col} className="pg-row">
                <th className="pg-record-field">{col}</th>
                {rows.map((r, idx) => (
                  <td key={idx}>{renderValueCell(idx, col, r[col])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
