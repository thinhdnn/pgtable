import React, { useEffect, useState } from 'react'
import {
  Modal,
  Form,
  Input,
  Typography,
  Alert,
  Radio,
  AutoComplete,
  Space,
  Button,
  message
} from 'antd'
import { IPC } from '@shared/ipc-channels'
import {
  AI_PROVIDERS,
  AI_PROVIDER_SPECS,
  DEFAULT_PROVIDER,
  checkAiConfig,
  type AiProviderId,
  type AiProviderStatus
} from '@shared/ai-providers'
import { invoke } from '../../api'

const { Text, Link } = Typography

interface Props {
  open: boolean
  onClose: () => void
  /** Fired after a successful save so callers can refresh the key-set flag. */
  onSaved?: (hasApiKey: boolean) => void
}

type SettingsStatus = {
  activeProvider: AiProviderId
  providers: Record<AiProviderId, AiProviderStatus>
}

function emptyStatus(): SettingsStatus {
  return {
    activeProvider: DEFAULT_PROVIDER,
    providers: Object.fromEntries(
      AI_PROVIDERS.map((p) => [p, { hasApiKey: false, model: '', baseUrl: '' }])
    ) as Record<AiProviderId, AiProviderStatus>
  }
}

// Settings screen for the AI provider (CONTEXT D5). The renderer never receives
// a raw key back — only whether one is configured — so the key field starts
// blank on every open and shows a status line instead. Model and base URL are
// not secret, so they round-trip normally.
export function SettingsModal({ open, onClose, onSaved }: Props): React.ReactElement {
  const [status, setStatus] = useState<SettingsStatus>(emptyStatus)
  const [provider, setProvider] = useState<AiProviderId>(DEFAULT_PROVIDER)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, msgCtx] = message.useMessage()

  const spec = AI_PROVIDER_SPECS[provider]
  const saved = status.providers[provider]

  // Load on open, and re-seed the editable fields whenever the selected provider
  // changes so each provider shows its own saved model / base URL.
  useEffect(() => {
    if (!open) return
    invoke<SettingsStatus>(IPC.SETTINGS_GET).then((r) => {
      if (!r?.providers) return
      setStatus(r)
      setProvider(r.activeProvider)
    })
  }, [open])

  useEffect(() => {
    setApiKey('')
    setModel(saved.model)
    setBaseUrl(saved.baseUrl)
  }, [provider, saved.model, saved.baseUrl])

  // Whether the config *as it would be saved* can be called. A blank key field
  // means "keep the stored one", so an already-saved key still counts.
  const configReady = checkAiConfig(provider, {
    apiKey: apiKey.trim() || (saved.hasApiKey ? 'stored' : ''),
    model,
    baseUrl
  }).ok

  // Persist the edited provider and make it active. Sends apiKey only when the
  // user typed one, so a blank field keeps the stored key rather than clearing
  // it. Returns the refreshed status, or null on failure.
  const persist = async (): Promise<SettingsStatus | null> => {
    const res = await invoke<
      { ok?: boolean; error?: string } & Partial<SettingsStatus>
    >(IPC.SETTINGS_SET, {
      provider,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      model,
      baseUrl,
      setActive: true
    })
    if (res?.error || !res?.providers) {
      msg.error(res?.error ?? 'Could not save settings')
      return null
    }
    const next: SettingsStatus = {
      activeProvider: res.activeProvider ?? provider,
      providers: res.providers
    }
    setStatus(next)
    setApiKey('')
    return next
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await persist()
      if (!next) return
      onSaved?.(next.providers[next.activeProvider].hasApiKey)
      msg.success(`${spec.label} saved`)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  // Test hits the *saved* config, so save first — otherwise a key the user just
  // typed wouldn't be tested and a wrong one would appear to pass.
  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      if (!(await persist())) return
      const res = await invoke<{ ok: boolean; model?: string; error?: string }>(
        IPC.SETTINGS_TEST,
        { provider }
      )
      if (res?.ok) msg.success(`${spec.label} replied — model ${res.model}`)
      else msg.error(res?.error ?? 'The provider did not reply')
    } finally {
      setTesting(false)
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
      width={560}
    >
      {msgCtx}
      <Form layout="vertical">
        <Form.Item
          label="AI provider"
          help={
            <Text type="secondary" style={{ fontSize: 12 }}>
              Used for AI SQL generation, review, and Ask-about-row. Each provider keeps its own
              settings, so switching back doesn&apos;t lose a key.
            </Text>
          }
        >
          <Radio.Group
            value={provider}
            onChange={(e) => setProvider(e.target.value as AiProviderId)}
            optionType="button"
            buttonStyle="solid"
            options={AI_PROVIDERS.map((p) => ({
              label: AI_PROVIDER_SPECS[p].label,
              value: p
            }))}
          />
        </Form.Item>

        {spec.requiresBaseUrl && (
          <Form.Item
            label="Base URL"
            help={
              <Text type="secondary" style={{ fontSize: 12 }}>
                Any OpenAI-compatible endpoint — Ollama, LM Studio, vLLM, OpenRouter. Include the
                version path, e.g. <code>http://localhost:11434/v1</code>.
              </Text>
            }
          >
            <Input
              placeholder="http://localhost:11434/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              autoComplete="off"
            />
          </Form.Item>
        )}

        <Form.Item
          label={spec.requiresApiKey ? 'API key' : 'API key (optional)'}
          help={
            <Text type="secondary" style={{ fontSize: 12 }}>
              Stored locally on this machine.
              {spec.keysUrl && (
                <>
                  {' '}
                  Get one at{' '}
                  <Link href={spec.keysUrl} target="_blank">
                    {new URL(spec.keysUrl).host}
                  </Link>
                  .
                </>
              )}
            </Text>
          }
        >
          <Input.Password
            placeholder={saved.hasApiKey ? '•••••••• (a key is already saved)' : spec.keyPlaceholder}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </Form.Item>

        <Form.Item
          label="Model"
          help={
            <Text type="secondary" style={{ fontSize: 12 }}>
              {spec.defaultModel ? `Leave blank to use ${spec.defaultModel}.` : spec.modelHelp}
            </Text>
          }
        >
          {/* AutoComplete, not Select: the suggestions are a convenience, but a
              compatible endpoint can serve any model name and the hosted
              providers ship new ids faster than we can list them. */}
          <AutoComplete
            allowClear
            placeholder={spec.defaultModel || spec.modelPlaceholder}
            value={model}
            onChange={(v) => setModel(v ?? '')}
            options={spec.suggestedModels.map((m) => ({ label: m, value: m }))}
            filterOption={(input, option) =>
              (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Button onClick={test} loading={testing} disabled={!configReady}>
            Test connection
          </Button>
          {saved.hasApiKey && (
            <Alert
              type="success"
              showIcon
              message={`A key is saved for ${spec.label}.`}
              description="Leave the field blank to keep it, or paste a new key to replace it."
            />
          )}
        </Space>
      </Form>
    </Modal>
  )
}
