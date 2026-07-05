import React, { useState, useEffect, useMemo } from 'react'
import { Popover, Input, Checkbox, Button, Empty } from 'antd'
import { TableOutlined } from '@ant-design/icons'

interface Props {
  /** All column names, in their natural order. */
  columns: string[]
  /** Currently visible columns; null = show all. */
  visible: string[] | null
  /** Commit a new visible set. null = show all. */
  onApply: (cols: string[] | null) => void
}

// A search-and-pick popover that drives which columns the grid shows. Selection
// is drafted locally and only committed on Apply, mirroring ColumnFilterButton.
export function ColumnPicker({ columns, visible, onApply }: Props): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<Set<string>>(new Set())

  // Seed the draft from the current state each time the popover opens.
  // null (all visible) seeds every column as checked.
  useEffect(() => {
    if (open) {
      setDraft(new Set(visible ?? columns))
      setSearch('')
    }
  }, [open, visible, columns])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? columns.filter((c) => c.toLowerCase().includes(q)) : columns
  }, [columns, search])

  const toggle = (col: string): void =>
    setDraft((prev) => {
      const next = new Set(prev)
      if (next.has(col)) next.delete(col)
      else next.add(col)
      return next
    })

  // Bulk toggles operate on the currently searched subset, so typing narrows
  // what "select all" affects.
  const selectAll = (): void =>
    setDraft((prev) => {
      const next = new Set(prev)
      for (const c of filtered) next.add(c)
      return next
    })

  const deselectAll = (): void =>
    setDraft((prev) => {
      const next = new Set(prev)
      for (const c of filtered) next.delete(c)
      return next
    })

  const apply = (): void => {
    // Keep the original column order; picking all (or none) means "show all".
    const picked = columns.filter((c) => draft.has(c))
    onApply(picked.length === 0 || picked.length === columns.length ? null : picked)
    setOpen(false)
  }

  const clear = (): void => {
    onApply(null)
    setOpen(false)
  }

  const active = visible != null && visible.length < columns.length

  const content = (
    <div style={{ width: 240 }} onClick={(e) => e.stopPropagation()}>
      <Input
        size="small"
        placeholder="Search columns…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onPressEnter={apply}
        autoFocus
        allowClear
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 8
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary, #999)' }}>
          {draft.size}/{columns.length} selected
        </span>
        <div>
          <Button type="link" size="small" style={{ padding: '0 4px' }} onClick={selectAll}>
            Select all
          </Button>
          <Button type="link" size="small" style={{ padding: '0 4px' }} onClick={deselectAll}>
            Deselect all
          </Button>
        </div>
      </div>
      <div style={{ maxHeight: 260, overflow: 'auto', margin: '8px 0' }}>
        {filtered.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No columns" />
        ) : (
          filtered.map((col) => (
            <div key={col} style={{ padding: '2px 0' }}>
              <Checkbox checked={draft.has(col)} onChange={() => toggle(col)}>
                {col}
              </Checkbox>
            </div>
          ))
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <Button size="small" onClick={clear} disabled={!active}>
          Clear
        </Button>
        <Button size="small" type="primary" onClick={apply}>
          Apply
        </Button>
      </div>
    </div>
  )

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomLeft"
      destroyTooltipOnHide
      content={content}
    >
      <Button size="small" type="text" icon={<TableOutlined />}>
        Columns{active ? ` (${visible!.length})` : ''}
      </Button>
    </Popover>
  )
}
