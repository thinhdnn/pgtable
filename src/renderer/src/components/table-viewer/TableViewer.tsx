import React, { useCallback, useRef, useState } from 'react'
import { Tabs, Button, Space, Tooltip, Typography } from 'antd'
import {
  ReloadOutlined,
  CopyOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
  TableOutlined,
  ProfileOutlined
} from '@ant-design/icons'
import type { TableTab } from '@shared/types'
import { DataGrid, type GridApi, type Orientation } from './DataGrid'
import { ColumnViewer } from './ColumnViewer'

const { Text } = Typography

interface Props {
  tab: TableTab
}

export function TableViewer({ tab }: Props) {
  const { connectionId, database, schema, table } = tab

  const [activeKey, setActiveKey] = useState('data')
  const [meta, setMeta] = useState({ total: 0, selected: 0, canEdit: false })
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [orientation, setOrientation] = useState<Orientation>('horizontal')
  const apiRef = useRef<GridApi | null>(null)

  const registerApi = useCallback((api: GridApi) => {
    apiRef.current = api
  }, [])

  const handleSave = useCallback(async () => {
    if (!apiRef.current) return
    setSaving(true)
    const ok = await apiRef.current.saveAll()
    setSaving(false)
    if (ok) setEditing(false)
  }, [])

  // Data-tab actions live inline with the tabs (icon-only, tooltip on hover).
  const extra =
    activeKey === 'data' ? (
      <Space size={2} style={{ paddingRight: 4 }}>
        <Text type="secondary" className="tabular" style={{ fontSize: 12, marginRight: 4 }}>
          {editing
            ? 'Editing'
            : meta.selected > 0
              ? `${meta.selected} selected`
              : `~${meta.total.toLocaleString()} rows`}
        </Text>
        {editing ? (
          <>
            <Tooltip title="Save changes">
              <Button
                type="text"
                size="small"
                loading={saving}
                icon={<CheckOutlined />}
                onClick={handleSave}
              />
            </Tooltip>
            <Tooltip title="Cancel">
              <Button
                type="text"
                size="small"
                disabled={saving}
                icon={<CloseOutlined />}
                onClick={() => setEditing(false)}
              />
            </Tooltip>
          </>
        ) : (
          <>
            <Tooltip title={meta.selected > 0 ? `Copy ${meta.selected} selected` : 'Copy all'}>
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                onClick={() => apiRef.current?.copy()}
              />
            </Tooltip>
            <Tooltip title="Refresh">
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => apiRef.current?.refresh()}
              />
            </Tooltip>
            <Tooltip
              title={orientation === 'horizontal' ? 'Switch to record view' : 'Switch to grid view'}
            >
              <Button
                type="text"
                size="small"
                icon={orientation === 'horizontal' ? <ProfileOutlined /> : <TableOutlined />}
                onClick={() =>
                  setOrientation((o) => (o === 'horizontal' ? 'vertical' : 'horizontal'))
                }
              />
            </Tooltip>
            <Tooltip
              title={meta.canEdit ? 'Edit rows' : 'Cannot edit: table has no primary key'}
            >
              <Button
                type="text"
                size="small"
                disabled={!meta.canEdit}
                icon={<EditOutlined />}
                onClick={() => setEditing(true)}
              />
            </Tooltip>
          </>
        )}
      </Space>
    ) : null

  return (
    <Tabs
      className="pg-fill-tabs"
      activeKey={activeKey}
      onChange={setActiveKey}
      size="small"
      style={{ padding: '0 12px', height: '100%' }}
      tabBarExtraContent={{ right: extra }}
      items={[
        {
          key: 'data',
          label: 'Data',
          children: (
            <DataGrid
              connectionId={connectionId}
              database={database}
              schema={schema}
              table={table}
              editing={editing}
              orientation={orientation}
              onMeta={setMeta}
              registerApi={registerApi}
            />
          )
        },
        {
          key: 'columns',
          label: 'Columns',
          children: (
            <ColumnViewer
              connectionId={connectionId}
              database={database}
              schema={schema}
              table={table}
            />
          )
        }
      ]}
    />
  )
}
