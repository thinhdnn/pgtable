import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal, Input, Alert, Button, Typography, theme } from 'antd'
import { ThunderboltOutlined, AlignLeftOutlined } from '@ant-design/icons'
import type { AiAskRowResult } from '@shared/types'
import { IPC } from '@shared/ipc-channels'
import { invoke } from '../../api'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
  // The row to ask about, and the field order to show/send it in.
  row: Record<string, unknown> | null
  columns: string[]
  connectionId: string
  database: string
  schema: string
  // The row's source table, when known (table viewer). Forwarded so the backend
  // can anchor the ambiguous-join-paths hint for drill-down questions.
  sourceTable?: string
  // When set, an embedded ```sql answer offers a button that hands it back to the
  // host (e.g. insert into the current editor, or open a new one). Omit where
  // there is nowhere to put SQL.
  onInsertSql?: (sql: string) => void
  // Label for that button. Defaults to inserting into the current editor; the
  // table viewer overrides it to "Open in new SQL editor".
  insertSqlLabel?: string
  // Called on NO_API_KEY so the host can open its settings UI if it has one.
  onNeedApiKey?: () => void
}

// The exact JSON that will be sent to the provider, field order matching what the
// user saw. Shown in the popup so nothing is sent blind.
function orderedRowJson(columns: string[], row: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {}
  const keys = columns.length ? columns : Object.keys(row)
  for (const k of keys) ordered[k] = row[k] ?? null
  return JSON.stringify(ordered, null, 2)
}

// Shared "ask AI about this row" popup. This is the only AI path that sends actual
// data values to the provider, so the send is gated: the exact JSON is shown and
// nothing leaves the machine until the user clicks Send. Reused by the SQL editor
// result grid and the table viewer's right-click menu.
export function AskRowModal({
  open,
  onClose,
  row,
  columns,
  connectionId,
  database,
  schema,
  sourceTable,
  onInsertSql,
  insertSqlLabel = 'Insert SQL into editor',
  onNeedApiKey
}: Props): React.ReactElement {
  const { token } = theme.useToken()
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [answer, setAnswer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Start a fresh conversation each time the popup opens for a (new) row.
  useEffect(() => {
    if (open) {
      setQuestion('')
      setAnswer(null)
      setError(null)
    }
  }, [open, row])

  const submit = useCallback(async () => {
    const q = question.trim()
    if (!q || !row || loading) return
    setLoading(true)
    setError(null)
    setAnswer(null)
    try {
      const res = await invoke<AiAskRowResult | { error: string }>(IPC.AI_ASK_ROW, {
        connectionId,
        database,
        schema,
        columns: columns.length ? columns : Object.keys(row),
        row,
        question: q,
        sourceTable
      })
      if ('error' in res) {
        if (res.error === 'NO_API_KEY') {
          setError('No Claude API key configured. Add one in Settings.')
          onNeedApiKey?.()
        } else {
          setError(res.error)
        }
        return
      }
      setAnswer(res.answer)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [question, row, loading, columns, connectionId, database, schema, sourceTable, onNeedApiKey])

  // Pull a single ```sql block out of the answer so we can offer to use it.
  const answerSql = useMemo(() => {
    if (!answer) return null
    const m = answer.match(/```sql\s*\n?([\s\S]*?)```/i)
    return m ? m[1].trim() : null
  }, [answer])

  const barBorder = `1px solid ${token.colorBorderSecondary}`
  const preStyle: React.CSSProperties = {
    margin: '4px 0 0',
    padding: 8,
    overflow: 'auto',
    fontSize: 12,
    borderRadius: 6,
    background: token.colorFillTertiary,
    border: barBorder,
    whiteSpace: 'pre-wrap'
  }

  return (
    <Modal
      title="Ask AI about this row"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="Send to AI"
      okButtonProps={{ icon: <ThunderboltOutlined />, disabled: !question.trim() }}
      confirmLoading={loading}
      width={620}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Alert
          type="warning"
          showIcon
          message="This sends the row's actual values to Claude"
          description="Unlike the other AI features, this leaves your machine. Review the data below before sending."
        />
        {row && (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Row that will be sent:
            </Text>
            <pre style={{ ...preStyle, maxHeight: 180 }}>{orderedRowJson(columns, row)}</pre>
          </div>
        )}
        <Input.TextArea
          autoFocus
          autoSize={{ minRows: 2, maxRows: 6 }}
          placeholder="Ask anything about this row — e.g. “what does this record mean?”, “find related orders”, “is this user active?”. ⌘/Ctrl + Enter to send."
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          disabled={loading}
        />
        {error && <Alert type="error" showIcon message={error} />}
        {answer && (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Answer:
            </Text>
            <pre style={{ ...preStyle, maxHeight: 260, fontSize: 13 }}>{answer}</pre>
            {answerSql && onInsertSql && (
              <Button
                size="small"
                type="primary"
                ghost
                style={{ marginTop: 8 }}
                icon={<AlignLeftOutlined />}
                onClick={() => {
                  onInsertSql(answerSql)
                  onClose()
                }}
              >
                {insertSqlLabel}
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
