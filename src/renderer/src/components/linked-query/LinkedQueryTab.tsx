import React, { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Collapse, Select, Space, Tag, Typography, theme } from 'antd'
import { PlayCircleOutlined, LinkOutlined, PlusOutlined, MinusOutlined } from '@ant-design/icons'
import type {
  LinkedQueryTab as LinkedQueryTabModel,
  LinkedStepRunResult,
  LinkedStepRunOutcome,
  LinkedUpstreamResults,
  Connection
} from '@shared/types'
import { IPC } from '@shared/ipc-channels'
import { invoke } from '../../api'
import { useConnections } from '../../hooks/useConnections'
import { useDatabases, useSchemas, useTables } from '../../hooks/useDatabases'
import { useActiveConnection } from '../../store/active-connection'
import { deriveSqlHint } from '../../utils/sql-hints'
import { type SchemaPayload } from '../../utils/sql-completion'
import { buildSelectSql } from '../../utils/sql-builders'
import { SqlEditor } from '../common/SqlEditor'
import { QueryResultTable } from '../common/QueryResultTable'

const { Text } = Typography

interface Props {
  tab: LinkedQueryTabModel
}

// One step's config + last run outcome. Steps live in renderer state only
// (VQ2 — no persistence, no main-side cache). `result` is the last successful
// run; `skipped` marks the D4 empty-keyset short-circuit.
interface StepState {
  connectionId: string | null
  database: string | null
  sql: string
  result: LinkedStepRunResult | null
  skipped: boolean
  error: string | null
  running: boolean
}

const STEP1_STARTER = '-- Step 1: SELECT the key column you want to push down\nSELECT id FROM users;'

// Starter for a step that references an earlier one. `n` is the new step's
// 1-based number, so it points the placeholder at the immediately prior step.
function laterStepStarter(n: number): string {
  const prev = n - 1
  return (
    `-- Step ${n}: reference an earlier step via :stepN.<column> in a WHERE ... IN (...)\n` +
    `SELECT id, name FROM tasks WHERE user_id IN (:step${prev}.id);`
  )
}

function emptyStep(sql: string): StepState {
  return {
    connectionId: null,
    database: null,
    sql,
    result: null,
    skipped: false,
    error: null,
    running: false
  }
}

function toOptions(list: string[]) {
  return list.map((v) => ({ label: v, value: v }))
}

// Introspect a (connection, database) so the step editor can complete real
// table/column names. Each step can point at a different connection/database,
// so this runs per step. Returns null while introspection is pending or unset
// (the editor still works with plain keyword completion until it resolves).
function useIntrospectSchema(
  connectionId: string | null,
  database: string | null
): SchemaPayload | null {
  const [schema, setSchema] = useState<SchemaPayload | null>(null)
  useEffect(() => {
    let cancelled = false
    setSchema(null)
    if (!connectionId || !database) return
    invoke<SchemaPayload | { error: string }>(IPC.SCHEMA_INTROSPECT, {
      connectionId,
      database
    }).then((res) => {
      if (cancelled) return
      if ('tables' in res) setSchema(res)
    })
    return () => {
      cancelled = true
    }
  }, [connectionId, database])
  return schema
}

export function LinkedQueryTab({ tab }: Props) {
  const { token } = theme.useToken()
  const { data: connections = [] } = useConnections()
  const { connectionStates } = useActiveConnection()

  // Only offer connections that are currently open — Step SQL would fail
  // otherwise. Mirrors what the sidebar shows as "connected".
  const readyConnections = useMemo<Connection[]>(
    () => connections.filter((c) => connectionStates[c.id] === 'connected'),
    [connections, connectionStates]
  )
  const connOptions = readyConnections.map((c) => ({ label: c.name, value: c.id }))

  // The chain starts with two steps (source + linked lookup), the smallest
  // useful shape. Add/remove operate on the tail so `:stepN` numbering stays
  // stable for placeholders the user already wrote (D6).
  const [steps, setSteps] = useState<StepState[]>(() => [
    emptyStep(STEP1_STARTER),
    emptyStep(laterStepStarter(2))
  ])

  // Which step panels are expanded. Both start open; collapsing is entirely
  // user-driven (a run never gaps a panel shut). A failed run re-opens its own
  // panel so the error is visible, and adding a step opens the new one.
  const [activeKeys, setActiveKeys] = useState<string[]>(['0', '1'])

  const patchStep = (i: number, patch: Partial<StepState>) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))

  // A step's result invalidates every downstream step (its keys changed), so
  // clear their outcomes and force a re-run.
  const clearDownstream = (i: number) =>
    setSteps((prev) =>
      prev.map((s, idx) =>
        idx > i ? { ...s, result: null, skipped: false, error: null } : s
      )
    )

  const addStep = () => {
    const newIndex = steps.length
    setSteps((prev) => [...prev, emptyStep(laterStepStarter(prev.length + 1))])
    setActiveKeys((prev) => [...prev, String(newIndex)])
  }

  const removeLastStep = () => {
    if (steps.length <= 1) return
    const lastKey = String(steps.length - 1)
    setSteps((prev) => prev.slice(0, -1))
    setActiveKeys((prev) => prev.filter((k) => k !== lastKey))
  }

  // Linear enable rule: a step can run only once every earlier step has a
  // result to key off (D1 iterative flow, generalised across the chain).
  const stepEnabled = (i: number) => i === 0 || steps.slice(0, i).every((s) => s.result !== null)

  async function runStep(i: number) {
    const step = steps[i]
    if (!step.connectionId || !step.database || !stepEnabled(i)) return

    const upstream: LinkedUpstreamResults = {}
    for (let j = 0; j < i; j++) {
      const r = steps[j].result
      if (r) upstream[j + 1] = { fields: r.fields, rows: r.rows }
    }

    patchStep(i, { running: true, error: null })
    try {
      const res = await invoke<LinkedStepRunOutcome | { error: string }>(IPC.LINKED_STEP_RUN, {
        connectionId: step.connectionId,
        database: step.database,
        sql: step.sql,
        stepIndex: i + 1,
        upstream
      })
      if ('error' in res) {
        patchStep(i, { result: null, skipped: false, error: res.error, running: false })
        // Keep a failed step open so the user sees the error.
        setActiveKeys((prev) => (prev.includes(String(i)) ? prev : [...prev, String(i)]))
        return
      }
      if ('skipped' in res && res.skipped) {
        patchStep(i, { result: null, skipped: true, error: null, running: false })
        clearDownstream(i)
        return
      }
      patchStep(i, { result: res, skipped: false, error: null, running: false })
      clearDownstream(i)
      // Leave panel expand/collapse to the user — running a step must not gap
      // it shut under them.
    } catch (err) {
      patchStep(i, {
        result: null,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
        running: false
      })
      setActiveKeys((prev) => (prev.includes(String(i)) ? prev : [...prev, String(i)]))
    }
  }

  const items = steps.map((step, i) => {
    const enabled = stepEnabled(i)
    return {
      key: String(i),
      label: <StepHeader index={i} step={step} enabled={enabled} />,
      extra: (
        <Button
          type="primary"
          size="small"
          icon={<PlayCircleOutlined />}
          loading={step.running}
          disabled={!enabled || !step.connectionId || !step.database}
          onClick={() => runStep(i)}
        >
          Run Step {i + 1}
        </Button>
      ),
      style: { background: token.colorFillQuaternary },
      children: (
        <StepBody
          index={i}
          step={step}
          steps={steps}
          enabled={enabled}
          connOptions={connOptions}
          onPatch={(patch) => patchStep(i, patch)}
          onScopeInvalidate={() => clearDownstream(i)}
        />
      )
    }
  })

  return (
    <div style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', padding: 16 }}>
      <Space direction="vertical" size={12} style={{ width: '100%', minWidth: 0 }}>
        <Space align="center" wrap>
          <LinkOutlined style={{ color: token.colorPrimary }} />
          <Text strong>{tab.title}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Chain SELECTs across databases: each step pushes its keys into a later
            step&apos;s WHERE IN. Placeholder: <code>:stepN.&lt;column&gt;</code>.
          </Text>
        </Space>

        {/* `collapsible="header"` keeps the Run button in `extra` from toggling
            the panel; only the header text expands/collapses. */}
        <Collapse
          collapsible="header"
          activeKey={activeKeys}
          onChange={(keys) => setActiveKeys(keys as string[])}
          items={items}
        />

        <Space>
          <Button icon={<PlusOutlined />} onClick={addStep}>
            Add step
          </Button>
          <Button icon={<MinusOutlined />} disabled={steps.length <= 1} onClick={removeLastStep}>
            Remove last step
          </Button>
        </Space>
      </Space>
    </div>
  )
}

const PAGE_SIZE = 25

// Collapsed-panel header: step tag, purpose, and a one-line status summary so a
// gapped-shut step still tells the user what it produced.
function StepHeader({
  index,
  step,
  enabled
}: {
  index: number
  step: StepState
  enabled: boolean
}) {
  const stepNo = index + 1
  const color = !enabled ? 'default' : step.error ? 'red' : stepNo === 1 ? 'blue' : 'green'
  return (
    <Space wrap size={8}>
      <Tag color={color}>Step {stepNo}</Tag>
      <span>{stepNo === 1 ? 'Select the key values' : 'Query with earlier keys'}</span>
      <StepStatus step={step} enabled={enabled} />
    </Space>
  )
}

function StepStatus({ step, enabled }: { step: StepState; enabled: boolean }) {
  let text: string
  if (step.running) text = 'running…'
  else if (step.error) text = 'failed'
  else if (step.skipped) text = 'skipped — no upstream keys'
  else if (step.result)
    text =
      `✓ ${step.result.rowCount} rows` +
      (step.database ? ` · ${step.database}` : '') +
      (step.result.autoLimited ? ' · auto LIMIT' : '')
  else if (!enabled) text = 'run the previous step first'
  else text = 'not run yet'
  return (
    <Text type={step.error ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
      {text}
    </Text>
  )
}

// One step's expanded body: scope pickers, SQL editor, and result grid. Owns
// nothing — the parent holds all step state so cross-step keying stays in one
// place.
function StepBody({
  index,
  step,
  steps,
  enabled,
  connOptions,
  onPatch,
  onScopeInvalidate
}: {
  index: number
  step: StepState
  steps: StepState[]
  enabled: boolean
  connOptions: { label: string; value: string }[]
  onPatch: (patch: Partial<StepState>) => void
  onScopeInvalidate: () => void
}) {
  const { token } = theme.useToken()
  const schemaInfo = useIntrospectSchema(step.connectionId, step.database)
  const stepNo = index + 1

  // `:stepN.col` refs the user can insert — every column of every earlier step
  // that has already produced a result.
  const keyRefOptions = useMemo(() => {
    const out: { label: string; value: string }[] = []
    for (let j = 0; j < index; j++) {
      const r = steps[j].result
      if (!r) continue
      for (const f of r.fields) out.push({ label: `:step${j + 1}.${f}`, value: `:step${j + 1}.${f}` })
    }
    return out
  }, [steps, index])

  const insertKeyRef = (ref: string) => {
    // Insert the placeholder already wrapped in its `IN (...)` operator — that's
    // the shape it's almost always used in (the rewriter expands `:stepN.col`
    // to the `$k, ...` list *inside* the parens). Splice before a trailing
    // semicolon so it lands inside the statement; otherwise append to the end.
    const clause = `IN (${ref})`
    const cur = step.sql
    const next = /;\s*$/.test(cur) ? cur.replace(/;\s*$/, ` ${clause};`) : `${cur} ${clause}`
    onPatch({ sql: next })
  }

  return (
    <>
      <StepScopePicker
        disabled={!enabled}
        connOptions={connOptions}
        connectionId={step.connectionId}
        database={step.database}
        keyRefOptions={keyRefOptions}
        onConnectionChange={(v) => {
          onPatch({ connectionId: v, database: null, result: null, skipped: false, error: null })
          onScopeInvalidate()
        }}
        onDatabaseChange={(v) => {
          onPatch({ database: v, result: null, skipped: false, error: null })
          onScopeInvalidate()
        }}
        onInsertTable={(schemaName, tableName) =>
          onPatch({ sql: buildSelectSql(schemaName, tableName) })
        }
        onInsertKeyRef={insertKeyRef}
      />
      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', width: '100%' }}>
        <div
          style={{
            flex: '1 1 0',
            width: 0,
            minWidth: 0,
            minHeight: 260,
            display: 'flex',
            overflow: 'hidden',
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusSM,
            opacity: enabled ? 1 : 0.55
          }}
        >
          <SqlEditor
            value={step.sql}
            onChange={(v) => onPatch({ sql: v })}
            schema={schemaInfo}
            editable={enabled}
            basicSetup={{ foldGutter: true }}
            style={{ width: '100%', height: '100%' }}
          />
        </div>
        <div style={{ flex: '1 1 0', width: 0, minWidth: 0, overflow: 'hidden' }}>
          {step.skipped ? (
            <Alert
              type="info"
              showIcon
              message={`Step ${stepNo} skipped`}
              description="An earlier step returned no key values, so there is nothing to look up here."
            />
          ) : step.result ? (
            <QueryResultTable
              fields={step.result.fields}
              rows={step.result.rows}
              pageSize={PAGE_SIZE}
              maxBodyHeight={320}
              toolbarLeft={stepMeta(step.result)}
            />
          ) : (
            <ResultPlaceholder
              text={enabled ? `Run Step ${stepNo} to see rows here.` : 'Run the previous step first.'}
            />
          )}
        </div>
      </div>
      {step.error && (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 8 }}
          message={`Step ${stepNo} failed`}
          description={
            <>
              <div>{step.error}</div>
              {deriveSqlHint(step.sql, step.error) && (
                <div style={{ marginTop: 6, opacity: 0.85 }}>💡 {deriveSqlHint(step.sql, step.error)}</div>
              )}
            </>
          }
        />
      )}
    </>
  )
}

// The `N rows · M ms · auto LIMIT applied` line shown above a step's result
// grid. Rendered into QueryResultTable's toolbar slot.
function stepMeta(result: LinkedStepRunResult): React.ReactNode {
  return (
    <Text type="secondary" style={{ fontSize: 12 }}>
      {result.rowCount} rows · {result.durationMs} ms
      {result.autoLimited && ' · auto LIMIT applied'}
    </Text>
  )
}

// The Connection / Database / Schema / Insert-table / Insert-key row shared by
// every step. Owns the schema selection and its dependent introspection
// queries; the parent controls connection/database (its run logic needs them)
// and handles the table-insert and key-ref-insert actions. `disabled` gates
// every select until the step is runnable.
function StepScopePicker({
  connOptions,
  connectionId,
  database,
  keyRefOptions,
  onConnectionChange,
  onDatabaseChange,
  onInsertTable,
  onInsertKeyRef,
  disabled = false
}: {
  connOptions: { label: string; value: string }[]
  connectionId: string | null
  database: string | null
  keyRefOptions: { label: string; value: string }[]
  onConnectionChange: (value: string) => void
  onDatabaseChange: (value: string) => void
  onInsertTable: (schema: string, table: string) => void
  onInsertKeyRef: (token: string) => void
  disabled?: boolean
}) {
  const [schema, setSchema] = useState<string | null>(null)
  // A changed connection/database invalidates the picked schema.
  useEffect(() => setSchema(null), [connectionId, database])

  const dbs = useDatabases(connectionId)
  const schemas = useSchemas(connectionId, database)
  const tables = useTables(connectionId, database, schema)

  return (
    <Space wrap style={{ marginBottom: 8 }}>
      <Select
        showSearch
        optionFilterProp="label"
        placeholder="Connection"
        style={{ minWidth: 200 }}
        options={connOptions}
        value={connectionId ?? undefined}
        disabled={disabled}
        onChange={onConnectionChange}
      />
      <Select
        showSearch
        optionFilterProp="label"
        placeholder="Database"
        style={{ minWidth: 200 }}
        options={toOptions(dbs.data ?? [])}
        value={database ?? undefined}
        disabled={disabled || !connectionId || dbs.isLoading}
        loading={dbs.isFetching}
        onChange={onDatabaseChange}
      />
      <Select
        showSearch
        optionFilterProp="label"
        placeholder="Schema"
        style={{ minWidth: 160 }}
        options={toOptions(schemas.data ?? [])}
        value={schema ?? undefined}
        disabled={disabled || !database || schemas.isLoading}
        loading={schemas.isFetching}
        onChange={setSchema}
      />
      <Select
        showSearch
        optionFilterProp="label"
        placeholder="Insert table → editor"
        style={{ minWidth: 220 }}
        options={(tables.data ?? []).map((t) => ({ label: t.name, value: t.name }))}
        value={undefined}
        disabled={disabled || !schema || tables.isLoading}
        loading={tables.isFetching}
        onChange={(tableName) => {
          if (!schema || !tableName) return
          onInsertTable(schema, tableName)
        }}
      />
      {keyRefOptions.length > 0 && (
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="Insert IN (:stepN.col) → editor"
          style={{ minWidth: 220 }}
          options={keyRefOptions}
          value={undefined}
          disabled={disabled}
          onChange={(token) => token && onInsertKeyRef(token)}
        />
      )}
    </Space>
  )
}

function ResultPlaceholder({ text }: { text: string }) {
  return (
    <div
      style={{
        height: '100%',
        minHeight: 260,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
        border: '1px dashed rgba(128,128,128,0.35)',
        color: 'rgba(128,128,128,0.75)',
        fontSize: 13
      }}
    >
      {text}
    </div>
  )
}
