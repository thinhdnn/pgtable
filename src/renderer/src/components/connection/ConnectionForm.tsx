import React, { useEffect } from 'react'
import { Modal, Form, Input, InputNumber, Select, Button, Space, message } from 'antd'
import type { Connection, ConnectionInput, SslMode } from '@shared/types'
import { useAddConnection, useUpdateConnection, useTestConnection } from '../../hooks/useConnections'

interface Props {
  open: boolean
  /** When set, the form edits this connection. */
  existing?: Connection
  /** When set (and no `existing`), the form opens in add mode prefilled with these
   *  values — used to clone an existing connection. */
  initialValues?: ConnectionInput
  onClose: () => void
}

const SSL_OPTIONS: SslMode[] = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']

const EMPTY: ConnectionInput = {
  name: '',
  host: 'localhost',
  port: 5432,
  username: '',
  password: '',
  ssl_mode: 'prefer',
  default_database: 'postgres',
  description: ''
}

export function ConnectionForm({ open, existing, initialValues, onClose }: Props) {
  const [form] = Form.useForm<ConnectionInput>()
  const add = useAddConnection()
  const update = useUpdateConnection()
  const test = useTestConnection()
  const [msg, msgCtx] = message.useMessage()

  const isClone = !existing && !!initialValues

  useEffect(() => {
    if (open) {
      form.setFieldsValue(existing ?? initialValues ?? EMPTY)
    }
  }, [open, existing, initialValues, form])

  async function handleSave() {
    const values = await form.validateFields()
    if (existing) {
      const result = await update.mutateAsync({ id: existing.id, ...values })
      if ('error' in result) {
        msg.error(result.error)
        return
      }
    } else {
      const result = await add.mutateAsync(values)
      if ('error' in result) {
        msg.error(result.error)
        return
      }
    }
    onClose()
  }

  async function handleTest() {
    const values = await form.validateFields()
    const result = await test.mutateAsync(values)
    if ('error' in result) {
      msg.error(`Connection failed: ${result.error}`)
    } else {
      msg.success(`Connected in ${result.latency_ms}ms`)
    }
  }

  return (
    <Modal
      open={open}
      title={existing ? 'Edit connection' : isClone ? 'Clone connection' : 'Add connection'}
      onCancel={onClose}
      footer={null}
      destroyOnClose
      width={520}
    >
      {msgCtx}
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item name="name" label="Name" rules={[{ required: true }]}>
          <Input placeholder="My Production DB" />
        </Form.Item>
        <Form.Item name="host" label="Host" rules={[{ required: true }]}>
          <Input placeholder="localhost" />
        </Form.Item>
        <Form.Item name="port" label="Port" rules={[{ required: true }]}>
          <InputNumber min={1} max={65535} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="username" label="Username" rules={[{ required: true }]}>
          <Input placeholder="postgres" />
        </Form.Item>
        <Form.Item name="password" label="Password">
          <Input.Password />
        </Form.Item>
        <Form.Item name="ssl_mode" label="SSL Mode" rules={[{ required: true }]}>
          <Select options={SSL_OPTIONS.map((v) => ({ label: v, value: v }))} />
        </Form.Item>
        <Form.Item name="default_database" label="Default Database">
          <Input placeholder="postgres" />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Space>
            <Button onClick={handleTest} loading={test.isPending}>
              Test
            </Button>
            <Button type="primary" onClick={handleSave} loading={add.isPending || update.isPending}>
              Save
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  )
}
