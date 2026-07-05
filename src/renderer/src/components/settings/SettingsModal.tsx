import React, { useEffect, useState } from 'react'
import { Modal, Form, Input, Typography, Alert, message } from 'antd'
import { IPC } from '@shared/ipc-channels'
import { invoke } from '../../api'

const { Text, Link } = Typography

interface Props {
  open: boolean
  onClose: () => void
  /** Fired after a successful save so callers can refresh the key-set flag. */
  onSaved?: (hasApiKey: boolean) => void
}

// Settings screen for the Claude API key (CONTEXT D5). The renderer never
// receives the raw key back — only whether one is configured — so the field
// starts blank and shows a status line instead.
export function SettingsModal({ open, onClose, onSaved }: Props): React.ReactElement {
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, msgCtx] = message.useMessage()

  useEffect(() => {
    if (!open) return
    setApiKey('')
    invoke<{ hasApiKey: boolean }>(IPC.SETTINGS_GET).then((r) => setHasKey(!!r?.hasApiKey))
  }, [open])

  const save = async (): Promise<void> => {
    if (!apiKey.trim()) {
      onClose()
      return
    }
    setSaving(true)
    try {
      const res = await invoke<{ ok?: boolean; hasApiKey?: boolean; error?: string }>(
        IPC.SETTINGS_SET,
        { apiKey: apiKey.trim() }
      )
      if (res?.error) {
        msg.error(res.error)
        return
      }
      setHasKey(!!res?.hasApiKey)
      onSaved?.(!!res?.hasApiKey)
      msg.success('API key saved')
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Settings"
      open={open}
      onOk={save}
      onCancel={onClose}
      okText="Save"
      confirmLoading={saving}
      destroyOnClose
    >
      {msgCtx}
      <Form layout="vertical">
        <Form.Item
          label="Claude API key"
          help={
            <Text type="secondary" style={{ fontSize: 12 }}>
              Used for AI SQL generation. Stored locally on this machine. Get one at{' '}
              <Link href="https://console.anthropic.com/settings/keys" target="_blank">
                console.anthropic.com
              </Link>
              .
            </Text>
          }
        >
          <Input.Password
            placeholder={hasKey ? '•••••••• (a key is already saved)' : 'sk-ant-...'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </Form.Item>
        {hasKey && (
          <Alert
            type="success"
            showIcon
            message="A Claude API key is configured."
            description="Leave the field blank to keep it, or paste a new key to replace it."
          />
        )}
      </Form>
    </Modal>
  )
}
