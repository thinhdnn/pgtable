import React from 'react'
import { Alert, Button, Tag, Tooltip } from 'antd'
import { ToolOutlined } from '@ant-design/icons'
import type { AiTroubleshootResult } from '@shared/types'

// The button that sits on a surface's error alert. `BugOutlined` is deliberately
// avoided — it already means "Check SQL" in the query toolbar, a different verb.
export function TroubleshootButton({
  loading,
  disabled,
  onClick
}: {
  loading: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip title="Ask AI why this failed and how to fix it (does not run anything)">
      <Button size="small" icon={<ToolOutlined />} loading={loading} disabled={disabled} onClick={onClick}>
        Troubleshoot
      </Button>
    </Tooltip>
  )
}

/**
 * Renders one troubleshoot result.
 *
 * `onApply` is offered if and only if `result.fixedSql` is present. That is the
 * whole mechanism behind "a connection error gets a diagnosis, not a fix": the
 * prompt returns an empty `fixedSql` for failures that rewriting cannot cure,
 * and `parseCheckResponse` turns that into `undefined`. There is no error
 * classification in this component, and there should never be one — a hardcoded
 * list of connection-error strings would misclassify.
 *
 * Applying never runs the statement. The caller writes it into the editor and
 * the user presses Run themselves.
 */
export function TroubleshootPanel({
  result,
  onApply,
  onClose
}: {
  result: AiTroubleshootResult
  onApply: (fixedSql: string) => void
  onClose: () => void
}): React.JSX.Element {
  const fixable = !!result.fixedSql
  return (
    <Alert
      type={fixable ? 'info' : 'warning'}
      showIcon
      closable
      onClose={onClose}
      message={result.summary || 'No diagnosis returned.'}
      description={
        result.issues.length > 0 || fixable ? (
          <div>
            {result.issues.length > 0 && (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {result.issues.map((iss, idx) => (
                  <li key={idx} style={{ marginBottom: 4 }}>
                    <Tag
                      color={
                        iss.severity === 'error'
                          ? 'error'
                          : iss.severity === 'warning'
                            ? 'warning'
                            : 'processing'
                      }
                      style={{ marginRight: 6 }}
                    >
                      {iss.severity}
                    </Tag>
                    {iss.message}
                    {iss.suggestion && (
                      <div style={{ opacity: 0.75, marginTop: 2 }}>→ {iss.suggestion}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {fixable && (
              <>
                <pre
                  style={{
                    margin: '8px 0 0',
                    padding: 8,
                    borderRadius: 4,
                    background: 'rgba(127,127,127,0.12)',
                    whiteSpace: 'pre-wrap',
                    fontSize: 12
                  }}
                >
                  {result.fixedSql}
                </pre>
                <Button
                  size="small"
                  type="primary"
                  ghost
                  style={{ marginTop: 8 }}
                  onClick={() => onApply(result.fixedSql as string)}
                >
                  Apply suggested fix
                </Button>
              </>
            )}
          </div>
        ) : null
      }
      style={{ margin: '0 12px 12px' }}
    />
  )
}
