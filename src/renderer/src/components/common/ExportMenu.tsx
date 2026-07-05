import React from 'react'
import { Button, Dropdown, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'

// The one place the export format set is defined. Every result grid renders
// this menu, so adding a format (e.g. Markdown, Parquet) here reaches all of
// them. Keys are matched by exportRowsToFile in utils/export-rows.
const EXPORT_MENU_ITEMS: MenuProps['items'] = [
  { key: 'comma', label: 'CSV (comma)' },
  { key: 'semicolon', label: 'CSV (semicolon)' },
  { key: 'tab', label: 'TSV (tab)' },
  { key: 'excel', label: 'CSV for Excel (keep leading zeros)' },
  { type: 'divider' },
  { key: 'json', label: 'JSON' }
]

interface Props {
  /** Called with the chosen menu key ('comma' | 'semicolon' | 'tab' | 'excel' | 'json'). */
  onSelect: (key: string) => void
  /** Spinner + disabled trigger while an async export is in flight. */
  loading?: boolean
  /** Tooltip on the trigger button. */
  tooltip?: string
}

// Shared export dropdown: a download button that opens the CSV/TSV/JSON menu.
// The caller owns *how* rows are obtained (already in memory, or fetched); this
// component only surfaces the format choice.
export function ExportMenu({
  onSelect,
  loading = false,
  tooltip = 'Export rows'
}: Props): React.ReactElement {
  return (
    <Dropdown
      trigger={['click']}
      disabled={loading}
      menu={{ items: EXPORT_MENU_ITEMS, onClick: ({ key }) => onSelect(key) }}
    >
      <Tooltip title={tooltip}>
        <Button size="small" type="text" icon={<DownloadOutlined />} loading={loading} />
      </Tooltip>
    </Dropdown>
  )
}
