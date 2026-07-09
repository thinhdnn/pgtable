import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { Alert, Button, Collapse, Select, Space, Tag, Tooltip, Typography, message, theme } from 'antd'
import {
  PlayCircleOutlined,
  PlusOutlined,
  DeleteOutlined,
  AlignLeftOutlined
} from '@ant-design/icons'
import type {
  LinkedQueryTab as LinkedQueryTabModel,
  LinkedStepRunResult,
  LinkedStepRunOutcome,
  LinkedUpstreamResults,
  Connection
} from '@shared/types'
import { IPC } from '@shared/ipc-channels'
import { LINKED_STEP_ROW_LIMIT, feedsLaterStep } from '@shared/linked-query'
import { invoke } from '../../api'
import { useConnections } from '../../hooks/useConnections'
import { useDatabases, useSchemas, useTables } from '../../hooks/useDatabases'
import { useActiveConnection } from '../../store/active-connection'
import { deriveSqlHint } from '../../utils/sql-hints'
import { type SchemaPayload } from '../../utils/sql-completion'
import { buildSelectSql } from '../../utils/sql-builders'
import { SqlEditor } from '../common/SqlEditor'
import { QueryResultTable } from '../common/QueryResultTable'
import { formatSqlInView } from '../../utils/format-sql'

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
  /** Per-step auto-LIMIT safety net, on by default. Off returns every row. It
   * never lifts the keyset bound a later step's placeholder imposes. */
  autoLimit: boolean
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
    running: false,
    autoLimit: true
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

// The tab bar already renders `tab.title`, so the pane itself never reads the
// model — repeating the title inside the pane is what made this tab look unlike
// the query and table tabs.
export function LinkedQueryTab(_props: Props) {
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
        upstream,
        autoLimit: step.autoLimit
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
    const runnable = enabled && !!step.connectionId && !!step.database && !step.running
    return {
      key: String(i),
      label: <StepHeader index={i} step={step} enabled={enabled} />,
      extra: (
        <Space size={8}>
          <LimitTag
            autoLimit={step.autoLimit}
            keysFeedLaterStep={feedsLaterStep(
              steps.slice(i + 1).map((s) => s.sql),
              i + 1
            )}
            onToggle={() => patchStep(i, { autoLimit: !step.autoLimit })}
          />
          <Tooltip title={`Run step ${i + 1} (⌘/Ctrl + Enter from its editor).`}>
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
          </Tooltip>
        </Space>
      ),
      style: { background: token.colorFillQuaternary },
      children: (
        <StepBody
          index={i}
          step={step}
          steps={steps}
          enabled={enabled}
          runnable={runnable}
          connOptions={connOptions}
          onRun={() => runStep(i)}
          onPatch={(patch) => patchStep(i, patch)}
          onScopeInvalidate={() => clearDownstream(i)}
        />
      )
    }
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="pg-toolbar">
        <Tooltip title="Append a step that can reference every earlier step's keys">
          <Button size="small" icon={<PlusOutlined />} onClick={addStep}>
            Add step
          </Button>
        </Tooltip>
        <Tooltip title="Drop the last step. Earlier :stepN numbering stays stable.">
          <Button
            size="small"
            icon={<DeleteOutlined />}
            disabled={steps.length <= 1}
            onClick={removeLastStep}
          >
            Remove last step
          </Button>
        </Tooltip>
        <Text type="secondary" className="tabular" style={{ fontSize: 12 }}>
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </Text>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 12 }}>
        <Text type="secondary" className="pg-hint" style={{ display: 'block', fontSize: 12 }}>
          Chain SELECTs across databases: each step pushes its keys into a later step&apos;s WHERE
          IN. Placeholder: <code>:stepN.&lt;column&gt;</code>.
        </Text>

        {/* `collapsible="header"` keeps the Run button in `extra` from toggling
            the panel; only the header text expands/collapses. */}
        <Collapse
          style={{ marginTop: 12 }}
          collapsible="header"
          activeKey={activeKeys}
          onChange={(keys) => setActiveKeys(keys as string[])}
          items={items}
        />
      </div>
    </div>
  )
}

const PAGE_SIZE = 25

// Height of a step's editor + result row. Fixed rather than content-driven so a
// long statement scrolls inside the editor (see .pg-sql-editor in styles.css).
const STEP_EDITOR_HEIGHT = 320

// Module-level so the identities never change: @uiw/react-codemirror rebuilds
// the whole extension tree whenever the `basicSetup` prop changes identity.
const STEP_BASIC_SETUP = { foldGutter: true }
const STEP_EDITOR_STYLE: React.CSSProperties = { width: '100%', height: '100%' }

// Per-step auto-LIMIT toggle, mirroring the tag in QueryEditor and
// FederatedQueryTab. `keysFeedLaterStep` changes only the copy: turning the net
// off still leaves the keyset this step hands downstream bounded by
// MAX_KEY_VALUES, and the later step fails with TOO_MANY_KEYS past it.
function LimitTag({
  autoLimit,
  keysFeedLaterStep,
  onToggle
}: {
  autoLimit: boolean
  keysFeedLaterStep: boolean
  onToggle: () => void
}) {
  const title = autoLimit
    ? `Bare SELECTs run with LIMIT ${LINKED_STEP_ROW_LIMIT}. Click to run with no row cap.`
    : keysFeedLaterStep
      ? `This step runs with no row cap, but a later step reads its keys — past ${LINKED_STEP_ROW_LIMIT} keys that step fails with TOO_MANY_KEYS. Click to re-arm the LIMIT.`
      : 'This step runs with no row cap. Click to re-arm the auto LIMIT safety net.'
  return (
    <Tooltip title={title}>
      <Tag
        color={autoLimit ? 'processing' : 'warning'}
        style={{ cursor: 'pointer', userSelect: 'none', margin: 0 }}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        {autoLimit ? `Limit ${LINKED_STEP_ROW_LIMIT}` : 'No limit'}
      </Tag>
    </Tooltip>
  )
}

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
  // Status colors, not preset palette colors: these track colorError / colorInfo
  // / colorSuccess, so the chain stays on the app's accent in both themes.
  const color = !enabled ? 'default' : step.error ? 'error' : stepNo === 1 ? 'processing' : 'success'
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
      `✓ ${step.result.rowCount} row${step.result.rowCount === 1 ? '' : 's'}` +
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
  runnable,
  connOptions,
  onRun,
  onPatch,
  onScopeInvalidate
}: {
  index: number
  step: StepState
  steps: StepState[]
  enabled: boolean
  runnable: boolean
  connOptions: { label: string; value: string }[]
  onRun: () => void
  onPatch: (patch: Partial<StepState>) => void
  onScopeInvalidate: () => void
}) {
  const { token } = theme.useToken()
  const schemaInfo = useIntrospectSchema(step.connectionId, step.database)
  const stepNo = index + 1

  // Live EditorView for this step, needed to format in place. Each step body
  // owns its own ref — the steps are independent editors.
  const editorRef = useRef<ReactCodeMirrorRef>(null)

  const format = useCallback(() => {
    const view = editorRef.current?.view
    if (!view) return
    if (formatSqlInView(view) === 'invalid') {
      message.warning("Couldn't format — the SQL may be incomplete or invalid.")
    }
  }, [])

  // Read through refs so the keymap extension stays referentially stable —
  // SqlEditor memoises its extensions on that identity.
  const formatRef = useRef<() => void>(() => {})
  useEffect(() => {
    formatRef.current = format
  }, [format])

  // Same reason, one level up: the parent rebuilds `onPatch` on every render, and
  // an unstable `onChange` makes react-codemirror reconfigure the editor on every
  // keystroke. Route the live callback through a ref so `handleSqlChange` is fixed.
  const onPatchRef = useRef(onPatch)
  onPatchRef.current = onPatch
  const handleSqlChange = useCallback((v: string) => onPatchRef.current({ sql: v }), [])

  // Stable toolbar node, or QueryResultTable's memo never holds.
  const resultMeta = useMemo(
    () => (step.result ? stepMeta(step.result) : null),
    [step.result]
  )

  // Mod-Enter runs *this* step, mirroring the query editor. Guarded by
  // `runnable` so a keypress can't fire a step the Run button has disabled.
  const runRef = useRef<() => void>(() => {})
  runRef.current = () => {
    if (runnable) onRun()
  }

  const keymapExtension = useMemo(
    () => [
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              runRef.current()
              return true
            }
          },
          {
            key: 'Shift-Alt-f',
            run: () => {
              formatRef.current()
              return true
            }
          }
        ])
      )
    ],
    []
  )

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
        onFormat={format}
        formatDisabled={!enabled || !step.sql.trim()}
      />
      {/* Definite height, not minHeight: the editor sizes itself to its content,
          so an auto-height row grows without bound on a long statement and the
          whole tab scrolls instead of the editor. */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'stretch',
          width: '100%',
          height: STEP_EDITOR_HEIGHT
        }}
      >
        <div
          style={{
            flex: '1 1 0',
            width: 0,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            overflow: 'hidden',
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusSM,
            opacity: enabled ? 1 : 0.55
          }}
        >
          <SqlEditor
            ref={editorRef}
            value={step.sql}
            onChange={handleSqlChange}
            schema={schemaInfo}
            editable={enabled}
            basicSetup={STEP_BASIC_SETUP}
            extraExtensions={keymapExtension}
            style={STEP_EDITOR_STYLE}
          />
        </div>
        <div style={{ flex: '1 1 0', width: 0, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
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
              toolbarLeft={resultMeta}
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

// The `N rows · M ms · auto LIMIT` line shown above a step's result grid,
// worded and styled like the query and federated tabs' toolbar meta. Rendered
// into QueryResultTable's toolbar slot.
function stepMeta(result: LinkedStepRunResult): React.ReactNode {
  return (
    <Text type="secondary" className="tabular" style={{ fontSize: 12 }}>
      {result.rowCount} row{result.rowCount === 1 ? '' : 's'} · {result.durationMs} ms
      {result.autoLimited && ' · auto LIMIT'}
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
  onFormat,
  formatDisabled,
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
  onFormat: () => void
  formatDisabled: boolean
  disabled?: boolean
}) {
  const [schema, setSchema] = useState<string | null>(null)
  // A changed connection/database invalidates the picked schema.
  useEffect(() => setSchema(null), [connectionId, database])

  const dbs = useDatabases(connectionId)
  const schemas = useSchemas(connectionId, database)
  const tables = useTables(connectionId, database, schema)

  return (
    <Space wrap size={8} style={{ marginBottom: 8 }}>
      <Select
        showSearch
        size="small"
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
        size="small"
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
        size="small"
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
        size="small"
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
          size="small"
          optionFilterProp="label"
          placeholder="Insert IN (:stepN.col) → editor"
          style={{ minWidth: 220 }}
          options={keyRefOptions}
          value={undefined}
          disabled={disabled}
          onChange={(token) => token && onInsertKeyRef(token)}
        />
      )}
      <Tooltip title="Format SQL (⇧ + Alt + F). Formats the selection if there is one.">
        <Button
          size="small"
          icon={<AlignLeftOutlined />}
          disabled={formatDisabled}
          onClick={onFormat}
        >
          Format
        </Button>
      </Tooltip>
    </Space>
  )
}

function ResultPlaceholder({ text }: { text: string }) {
  return <div className="pg-placeholder">{text}</div>
}
