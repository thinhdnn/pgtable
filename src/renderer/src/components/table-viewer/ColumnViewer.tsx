import React from 'react'
import { Table, Alert, Tag, Typography } from 'antd'
import { useColumns } from '../../hooks/useDatabases'
import { LoadingPanel } from '../Loading'

const { Text } = Typography

interface Props {
  connectionId: string
  database: string
  schema: string
  table: string
}

export function ColumnViewer({ connectionId, database, schema, table }: Props) {
  const { data, isLoading, error } = useColumns(connectionId, database, schema, table)

  if (isLoading) return <LoadingPanel />
  if (error) return <Alert type="error" message={String(error)} style={{ margin: 16 }} />

  return (
    <Table
      dataSource={data}
      rowKey="name"
      size="small"
      pagination={false}
      style={{ paddingTop: 8 }}
      columns={[
        {
          title: 'Column',
          dataIndex: 'name',
          key: 'name',
          width: 220,
          render: (v: string) => (
            <Text strong style={{ fontFamily: 'var(--ant-font-family-code)' }}>
              {v}
            </Text>
          )
        },
        {
          title: 'Type',
          dataIndex: 'data_type',
          key: 'data_type',
          width: 180,
          render: (v: string) => (
            <Text style={{ fontFamily: 'var(--ant-font-family-code)' }} type="secondary">
              {v}
            </Text>
          )
        },
        {
          title: 'Nullable',
          dataIndex: 'is_nullable',
          key: 'is_nullable',
          width: 110,
          render: (v: string) =>
            v === 'YES' ? <Tag>nullable</Tag> : <Tag color="default">not null</Tag>
        },
        {
          title: 'Default',
          dataIndex: 'column_default',
          key: 'column_default',
          render: (v: string | null) =>
            v ? (
              <Text style={{ fontFamily: 'var(--ant-font-family-code)' }}>{v}</Text>
            ) : (
              <span className="pg-null">NULL</span>
            )
        }
      ]}
    />
  )
}
