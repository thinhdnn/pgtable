import React, { useState, useEffect, useMemo } from 'react'
import { Popover, Select, AutoComplete, Button, Space, Spin } from 'antd'
import { FilterFilled, FilterOutlined } from '@ant-design/icons'
import type { FilterOp, ColumnFilter } from '@shared/types'
import { useColumnDistinct } from '../../hooks/useDatabases'

const OP_OPTIONS: Array<{ value: FilterOp; label: string }> = [
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'is_null', label: 'is NULL' },
  { value: 'is_not_null', label: 'is not NULL' }
]

interface Props {
  connectionId: string
  database: string
  schema: string
  table: string
  column: string
  value?: ColumnFilter
  onChange: (next: ColumnFilter | null) => void
}

export function ColumnFilterButton({
  connectionId,
  database,
  schema,
  table,
  column,
  value,
  onChange
}: Props) {
  const [open, setOpen] = useState(false)
  const [op, setOp] = useState<FilterOp>(value?.op ?? 'contains')
  const [text, setText] = useState(value?.value ?? '')

  // Re-sync local state whenever the popover (re)opens.
  useEffect(() => {
    if (open) {
      setOp(value?.op ?? 'contains')
      setText(value?.value ?? '')
    }
  }, [open, value])

  const needsValue = op !== 'is_null' && op !== 'is_not_null'
  const active = !!value

  // Lazily fetch distinct values once the popover opens.
  const distinctRes = useColumnDistinct(connectionId, database, schema, table, column, open)

  const allOptions = useMemo(() => {
    const list = Array.isArray(distinctRes.data) ? distinctRes.data : []
    const out: Array<{ value: string; label: string }> = []
    const seen = new Set<string>()
    for (const v of list) {
      if (v == null) continue
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
      if (seen.has(s)) continue
      seen.add(s)
      out.push({ value: s, label: s })
    }
    return out
  }, [distinctRes.data])

  // Client-side filter so the dropdown narrows as the user types.
  const visibleOptions = useMemo(() => {
    if (!text) return allOptions.slice(0, 50)
    const q = text.toLowerCase()
    return allOptions.filter((o) => o.value.toLowerCase().includes(q)).slice(0, 50)
  }, [allOptions, text])

  const apply = () => {
    if (!needsValue) {
      onChange({ column, op })
    } else if (text === '') {
      onChange(null)
    } else {
      onChange({ column, op, value: text })
    }
    setOpen(false)
  }
  const clear = () => {
    onChange(null)
    setOpen(false)
  }

  const content = (
    <div style={{ width: 280 }} onClick={(e) => e.stopPropagation()}>
      <Space.Compact style={{ width: '100%' }}>
        <Select
          size="small"
          value={op}
          onChange={(v) => setOp(v)}
          options={OP_OPTIONS}
          style={{ width: 110, flexShrink: 0 }}
        />
        <AutoComplete
          size="small"
          value={text}
          disabled={!needsValue}
          onChange={(v) => setText(v ?? '')}
          options={visibleOptions}
          placeholder={needsValue ? 'value' : ''}
          style={{ flex: 1, minWidth: 0 }}
          notFoundContent={
            distinctRes.isLoading ? <Spin size="small" /> : 'No suggestions'
          }
          // We do our own filtering above (substring, case-insensitive).
          filterOption={false}
          autoFocus
          onInputKeyDown={(e) => {
            if (e.key === 'Enter') apply()
          }}
        />
      </Space.Compact>
      {needsValue && distinctRes.data && Array.isArray(distinctRes.data) && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: 'var(--ant-color-text-tertiary, #999)'
          }}
        >
          {allOptions.length === 0
            ? 'No distinct values'
            : `${allOptions.length} suggestion${allOptions.length === 1 ? '' : 's'}${
                allOptions.length >= 200 ? ' (first 200)' : ''
              }`}
        </div>
      )}
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <Button size="small" onClick={clear} disabled={!active}>
          Clear
        </Button>
        <Button size="small" type="primary" onClick={apply}>
          Apply
        </Button>
      </div>
    </div>
  )

  const Icon = active ? FilterFilled : FilterOutlined

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomLeft"
      destroyTooltipOnHide
      content={content}
    >
      <span
        className={active ? 'pg-filter-icon pg-filter-icon-active' : 'pg-filter-icon'}
        role="button"
        aria-label={`Filter ${column}`}
      >
        <Icon />
      </span>
    </Popover>
  )
}
