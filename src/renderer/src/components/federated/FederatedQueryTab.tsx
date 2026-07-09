import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import {
  PlayCircleOutlined,
  PlusOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
  SaveOutlined,
  SearchOutlined,
  FolderOpenOutlined,
  AlignLeftOutlined,
  StopOutlined
} from '@ant-design/icons'
import type {
  FederatedTab as FederatedTabModel,
  FederatedAttachment,
  FederatedRunResult,
  FederatedRunOutcome,
  AiTroubleshootResult,
  Connection,
  SavedFederatedQuery,
  SavedFederatedQueryInput
} from '@shared/types'
import { IPC } from '@shared/ipc-channels'
import { deriveAlias, FEDERATED_ROW_LIMIT } from '@shared/federated'
import { isNonMutatingStatement } from '@shared/sql-statement'
import { TroubleshootButton, TroubleshootPanel } from '../common/TroubleshootPanel'
import { invoke } from '../../api'
import { useConnections } from '../../hooks/useConnections'
import { useDatabases, useSchemas } from '../../hooks/useDatabases'
import { useSavedQueries } from '../../hooks/useSavedQueries'
import { useAiGenerate } from '../../hooks/useAiGenerate'
import { useActiveConnection } from '../../store/active-connection'
import { deriveSqlHint } from '../../utils/sql-hints'
import { SqlEditor } from '../common/SqlEditor'
import { QueryResultTable } from '../common/QueryResultTable'
import { SettingsModal } from '../settings/SettingsModal'
import { formatSqlInView } from '../../utils/format-sql'

const { Text } = Typography
const PAGE_SIZE = 100

interface Props {
  tab: FederatedTabModel
}

// One attach row's config. `key` is a stable local id for React lists; the
// DuckDB alias is derived (not stored) so it stays consistent with the names.
// `schema` feeds the runner's search_path so unqualified table names resolve.
interface AttachRow {
  key: string
  connectionId: string | null
  database: string | null
  schema: string
}

const STARTER_SQL =
  '-- Federated query across the attached databases (DuckDB).\n' +
  '-- Unqualified table names resolve across every attached schema below.\n' +
  '-- Only qualify as alias.schema.table when the same name exists in two DBs.\n' +
  'SELECT 1;'

function newRow(): AttachRow {
  return {
    key: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    connectionId: null,
    database: null,
    schema: 'public'
  }
}

// A row's connection health, used after Open to flag rows a saved query can no
// longer run as-is (CONTEXT D3). `ok` = usable; `missing` = the saved
// connectionId no longer exists (deleted); `disconnected` = it exists but is not
// currently connected, so the user must connect it first.
type RowStatus = 'ok' | 'missing' | 'disconnected'

type ResolvedRow = AttachRow & {
  alias: string | null
  connName: string | null
  status: RowStatus
}

// Resolve display + payload data for the rows: derive a stable alias per row in
// order (collisions get a numeric suffix), keep the connection name for the
// header, and compute a status against the currently-connected set. Rows without
// a connection get no alias and status `ok` (an empty row is not an error).
function resolveRows(
  rows: AttachRow[],
  connById: Map<string, Connection>,
  readyIds: Set<string>
): ResolvedRow[] {
  const taken = new Set<string>()
  return rows.map((r) => {
    if (!r.connectionId) return { ...r, alias: null, connName: null, status: 'ok' }
    const conn = connById.get(r.connectionId)
    if (!conn) return { ...r, alias: null, connName: null, status: 'missing' }
    const status: RowStatus = readyIds.has(conn.id) ? 'ok' : 'disconnected'
    return { ...r, alias: deriveAlias(conn.name, taken), connName: conn.name, status }
  })
}

// Module-level so the identity never changes: @uiw/react-codemirror rebuilds the
// whole extension tree whenever the `basicSetup` prop changes identity.
const EDITOR_BASIC_SETUP = { foldGutter: true }

// The tab bar already renders `tab.title`, so the pane itself never reads the
// model — repeating the title inside the pane is what made this tab look unlike
// the query and table tabs.
export function FederatedQueryTab(_props: Props): React.ReactElement {
  const { data: connections = [] } = useConnections()
  const { connectionStates } = useActiveConnection()

  // Only connections that are currently open can be attached — DuckDB's ATTACH
  // would fail otherwise. Mirrors the sidebar's "connected" set.
  const readyConnections = useMemo<Connection[]>(
    () => connections.filter((c) => connectionStates[c.id] === 'connected'),
    [connections, connectionStates]
  )
  const connOptions = readyConnections.map((c) => ({ label: c.name, value: c.id }))
  const connById = useMemo(() => new Map(connections.map((c) => [c.id, c])), [connections])
  const readyIds = useMemo(() => new Set(readyConnections.map((c) => c.id)), [readyConnections])

  const [rows, setRows] = useState<AttachRow[]>(() => [newRow(), newRow()])
  const [sql, setSql] = useState(STARTER_SQL)
  // Editor pane height in px, drag-resizable via the handle below it.
  const [editorHeight, setEditorHeight] = useState(220)
  const [result, setResult] = useState<FederatedRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  // Set once Stop is pressed, cleared when the run actually settles. Keeps the
  // Stop button disabled and spinning through the gap — interrupting a DuckDB
  // scan is not instantaneous.
  const [cancelling, setCancelling] = useState(false)
  // Identifies the in-flight run to the main process. Null when idle. A ref, not
  // state: `cancel` only reads it, and re-rendering on it would be noise.
  const runIdRef = useRef<string | null>(null)
  // When true, bare SELECTs get a safety LIMIT. Defaults off — queries run with no
  // row cap unless the user turns it on from the toolbar.
  const [autoLimit, setAutoLimit] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Live EditorView, needed to format in place (dispatching through the view
  // keeps undo history and the cursor intact).
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  // Bounds the editor/results splitter against the pane rather than a fixed
  // pixel ceiling, so the results half can never be dragged off-screen.
  const splitContainerRef = useRef<HTMLDivElement>(null)

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

  // `run` is redeclared every render, so point the ref at the current one here
  // rather than in an effect that would fire on every render anyway.
  const runRef = useRef<() => void>(() => {})

  // Prec.highest so Mod-Enter beats CodeMirror's default Enter binding and
  // Shift-Alt-F wins over its defaults, matching the query editor's bindings.
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

  const resolved = useMemo(() => resolveRows(rows, connById, readyIds), [rows, connById, readyIds])
  // Attachments ready to send: connection picked, database picked, alias derived.
  const attachments = useMemo<FederatedAttachment[]>(
    () =>
      resolved
        .filter((r) => r.connectionId && r.database && r.alias && r.schema)
        .map((r) => ({
          connectionId: r.connectionId!,
          database: r.database!,
          alias: r.alias!,
          schema: r.schema
        })),
    [resolved]
  )

  const patchRow = (key: string, patch: Partial<AttachRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const addRow = () => setRows((prev) => [...prev, newRow()])
  const removeRow = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key))

  const canRun = attachments.length > 0 && sql.trim().length > 0 && !running

  // Rows worth saving: a connection + database picked (schema defaults to public).
  const savedAttachments = useMemo(
    () =>
      rows
        .filter((r) => r.connectionId && r.database)
        .map((r) => ({ connectionId: r.connectionId!, database: r.database!, schema: r.schema })),
    [rows]
  )
  // "Meaningful content" for the D5 overwrite confirm: any configured attachment
  // OR the SQL has diverged from the starter template.
  const isDirty = savedAttachments.length > 0 || sql.trim() !== STARTER_SQL.trim()
  const canSave = savedAttachments.length > 0 && sql.trim().length > 0

  // Saved federated-query library (CONTEXT D1-D5). State + IPC (list/save with
  // NAME_EXISTS handling/delete) live in the shared useSavedQueries hook; the
  // save payload persists the full runnable tab (attachments + SQL + autoLimit),
  // and applySaved (below) hydrates the tab on Open — those stay local.
  const saved = useSavedQueries<SavedFederatedQuery, SavedFederatedQueryInput>({
    channels: {
      list: IPC.FEDERATED_SCRIPT_LIST,
      save: IPC.FEDERATED_SCRIPT_SAVE,
      delete: IPC.FEDERATED_SCRIPT_DELETE
    },
    noun: 'federated query',
    buildSaveInput: (name, overwrite) => {
      if (savedAttachments.length === 0) {
        message.warning('Attach at least one database (connection + database) to save.')
        return null
      }
      if (!sql.trim()) {
        message.warning('There is no SQL to save.')
        return null
      }
      return { name, attachments: savedAttachments, sql, autoLimit, overwrite }
    }
  })

  // Hydrate the tab from a saved query (D5: overwrite in place). Rebuild the
  // attach rows with fresh React keys; missing/disconnected connections are
  // flagged by resolveRows (D3), not blocked here.
  const applySaved = useCallback((q: SavedFederatedQuery) => {
    const nextRows: AttachRow[] =
      q.attachments.length > 0
        ? q.attachments.map((a) => ({
            key: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            connectionId: a.connectionId,
            database: a.database,
            schema: a.schema
          }))
        : [newRow()]
    setRows(nextRows)
    setSql(q.sql)
    setAutoLimit(q.autoLimit)
    setResult(null)
    setError(null)
    saved.closeList()
    message.success(`Opened "${q.name}".`)
  }, [saved])

  // Confirm before clobbering a tab that holds meaningful content (D5).
  const openSaved = useCallback(
    (q: SavedFederatedQuery) => {
      if (isDirty) {
        Modal.confirm({
          title: `Open "${q.name}"?`,
          content: 'This replaces the current attachments and SQL in this tab.',
          okText: 'Open',
          cancelText: 'Cancel',
          onOk: () => applySaved(q)
        })
        return
      }
      applySaved(q)
    },
    [isDirty, applySaved]
  )

  // "Ask AI": describe the federated query in words; the AI writes DuckDB SQL from
  // every attached database's tables + FKs (referenced as alias.schema.table).
  const [aiError, setAiError] = useState<string | null>(null)
  // Set when AI-authored SQL (generated or a troubleshoot fix) is not a read-only
  // statement. The federated runner refuses to execute those, but the warning
  // exists so the user is told *before* pressing Run, not after.
  const [genWarning, setGenWarning] = useState(false)
  // Refine mode, mirroring QueryEditor: when the popup is opened with a non-empty
  // editor selection, that SQL becomes the base the AI edits, and `aiSelRef`
  // remembers the range so the result replaces just the selection instead of the
  // whole buffer. Null = a from-scratch generation replacing the buffer.
  const [aiBaseSql, setAiBaseSql] = useState<string | null>(null)
  const aiSelRef = useRef<{ from: number; to: number } | null>(null)
  // AI "troubleshoot" state: explains the error the last run produced.
  const [tsLoading, setTsLoading] = useState(false)
  const [tsResult, setTsResult] = useState<AiTroubleshootResult | null>(null)
  // State (open/request/loading) + generate orchestration live in the shared
  // useAiGenerate hook; the attachment pre-check and where the SQL lands stay here.
  const ai = useAiGenerate<{
    attachments: FederatedAttachment[]
    request: string
    baseSql?: string
  }>({
    channel: IPC.AI_GENERATE_FEDERATED_SQL,
    setError: setAiError,
    // NO_API_KEY: close the popup and route to Settings, as the query editor does.
    onNoApiKey: ({ close }) => {
      close()
      setSettingsOpen(true)
    },
    buildPayload: (request) => {
      if (attachments.length === 0) {
        setAiError('Attach at least one connected database first.')
        return null
      }
      setGenWarning(false)
      return { attachments, request, baseSql: aiBaseSql ?? undefined }
    },
    onResult: (sql) => {
      // Refine mode replaces only the selected range (dispatched through the live
      // view so undo history stays intact; onChange syncs sql). From-scratch mode
      // replaces the whole buffer.
      const sel = aiSelRef.current
      const view = editorRef.current?.view
      if (sel && view) {
        const docLen = view.state.doc.length
        const from = Math.min(sel.from, docLen)
        const to = Math.min(sel.to, docLen)
        view.dispatch({
          changes: { from, to, insert: sql },
          selection: { anchor: from, head: from + sql.length }
        })
      } else {
        setSql(sql)
      }
      setGenWarning(!isNonMutatingStatement(sql))
      setResult(null)
      setError(null)
    }
  })

  // Open the AI popup. If the editor has a selection, enter "refine" mode: the
  // selected SQL is shown as context and its range is remembered so the result
  // replaces just that selection. Otherwise it's a from-scratch generation.
  const openAiModal = useCallback(() => {
    setAiError(null)
    ai.setRequest('')
    const view = editorRef.current?.view
    let base: string | null = null
    aiSelRef.current = null
    if (view) {
      const { from, to } = view.state.selection.main
      if (from !== to) {
        base = view.state.sliceDoc(from, to)
        aiSelRef.current = { from, to }
      }
    }
    setAiBaseSql(base)
    ai.setOpen(true)
  }, [ai])

  // Ask the AI provider why the last federated run failed. Sends the statement,
  // the raw DuckDB error, and every attachment's alias + database + schema (D3) —
  // DuckDB names tables `alias.schema.table`, so without the alias list the model
  // cannot tell a misspelled alias from a missing attachment. No row values.
  const troubleshoot = useCallback(async () => {
    if (!error || tsLoading) return
    setTsLoading(true)
    setAiError(null)
    setTsResult(null)
    try {
      const res = await invoke<AiTroubleshootResult | { error: string }>(IPC.AI_TROUBLESHOOT_SQL, {
        kind: 'federated',
        attachments,
        sql,
        errorMessage: error
      })
      if ('error' in res) {
        if (res.error === 'NO_API_KEY') {
          setAiError('No AI provider configured. Add an API key in Settings.')
          setSettingsOpen(true)
        } else {
          setAiError(res.error)
        }
        return
      }
      setTsResult(res)
    } catch (err) {
      setAiError(String(err))
    } finally {
      setTsLoading(false)
    }
  }, [error, tsLoading, attachments, sql])

  // Apply a troubleshoot fix: write it to the editor, warn if it is not read-only,
  // and run nothing. The user presses Run.
  const applyTroubleshootFix = useCallback((fixed: string) => {
    setSql(fixed)
    setGenWarning(!isNonMutatingStatement(fixed))
    setTsResult(null)
    setResult(null)
    setError(null)
  }, [])

  // Ask the main process to interrupt the in-flight run. `running` is cleared by
  // run()'s finally, not here — the run is over when its promise settles, and
  // pretending otherwise would re-enable Run while DuckDB is still unwinding.
  const cancel = useCallback(async () => {
    const runId = runIdRef.current
    if (!runId || cancelling) return
    setCancelling(true)
    try {
      await invoke<{ cancelled: boolean }>(IPC.FEDERATED_CANCEL, { runId })
    } catch (err) {
      setCancelling(false)
      message.error(`Couldn't cancel: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [cancelling])

  async function run() {
    if (!canRun) return
    const runId = crypto.randomUUID()
    runIdRef.current = runId
    setRunning(true)
    setCancelling(false)
    setError(null)
    try {
      const res = await invoke<FederatedRunOutcome>(IPC.FEDERATED_RUN, {
        attachments,
        sql,
        autoLimit,
        runId
      })
      // `cancelled` first: an abort the user asked for is a notice, not the red
      // error alert, and it must not leave the previous run's rows on screen.
      if ('cancelled' in res) {
        setResult(null)
        message.info('Federated query cancelled.')
        return
      }
      if ('error' in res) {
        setResult(null)
        setError(res.error)
        return
      }
      setResult(res)
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      setCancelling(false)
      runIdRef.current = null
    }
  }
  runRef.current = run

  // Drag the handle under the editor to resize it. Pointer capture keeps the drag
  // alive while the cursor moves over the CodeMirror surface; height is clamped
  // so the results half below always keeps at least 220px.
  function beginResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = editorHeight
    const maxH = Math.max(160, (splitContainerRef.current?.clientHeight ?? 800) - 220)
    const move = (ev: PointerEvent): void => {
      const next = Math.max(120, Math.min(maxH, startH + (ev.clientY - startY)))
      setEditorHeight(next)
    }
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
    document.body.style.cursor = 'row-resize'
  }

  return (
    <div
      ref={splitContainerRef}
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div className="pg-toolbar">
        <Tooltip title="Run (⌘/Ctrl + Enter) across every attached database.">
          <Button
            type="primary"
            size="small"
            icon={<PlayCircleOutlined />}
            loading={running}
            disabled={!canRun}
            onClick={run}
          >
            Run
          </Button>
        </Tooltip>
        {running && (
          <Tooltip title="Stop the running query. A large scan may take a moment to unwind.">
            <Button
              danger
              size="small"
              icon={<StopOutlined />}
              loading={cancelling}
              disabled={cancelling}
              onClick={cancel}
            >
              Stop
            </Button>
          </Tooltip>
        )}
        <Tooltip title="Format SQL (⇧ + Alt + F). Formats the selection if there is one.">
          <Button size="small" icon={<AlignLeftOutlined />} disabled={!sql.trim()} onClick={format}>
            Format
          </Button>
        </Tooltip>
        <Tooltip title="Save this federated query (attachments + SQL) as a named entry">
          <Button
            size="small"
            icon={<SaveOutlined />}
            disabled={!canSave}
            onClick={() => {
              saved.setSaveName('')
              saved.setSaveOpen(true)
            }}
          >
            Save
          </Button>
        </Tooltip>
        <Tooltip title="Open a saved federated query">
          <Button size="small" icon={<FolderOpenOutlined />} onClick={saved.openList}>
            Saved
          </Button>
        </Tooltip>
        <Tooltip
          title={
            attachments.length === 0
              ? 'Attach at least one connected database first'
              : 'Describe the query in words — or select SQL first to have the AI refine it'
          }
        >
          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            disabled={attachments.length === 0}
            onClick={openAiModal}
          >
            Ask AI
          </Button>
        </Tooltip>
        <Text type="secondary" className="tabular" style={{ fontSize: 12 }}>
          {attachments.length === 0
            ? 'no databases attached'
            : `${attachments.length} attached`}
        </Text>
        <Tooltip
          title={
            autoLimit
              ? `Bare SELECTs run with LIMIT ${FEDERATED_ROW_LIMIT}. Click to run with no row cap.`
              : 'Queries run with no row cap. Click to re-enable the auto LIMIT safety net.'
          }
        >
          <Tag
            color={autoLimit ? 'processing' : 'warning'}
            style={{ cursor: 'pointer', userSelect: 'none', margin: 0 }}
            onClick={() => setAutoLimit((v) => !v)}
          >
            {autoLimit ? `Limit ${FEDERATED_ROW_LIMIT}` : 'No limit'}
          </Tag>
        </Tooltip>
        <div className="pg-toolbar-meta">
          {result && (
            <Text type="secondary" className="tabular" style={{ fontSize: 12 }}>
              {result.rowCount} row{result.rowCount === 1 ? '' : 's'} · {result.durationMs} ms
              {result.autoLimited && ' · auto LIMIT'}
            </Text>
          )}
        </div>
      </div>

      <div className="pg-subbar">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {resolved.map((r) => (
            <AttachRowEditor
              key={r.key}
              row={r}
              alias={r.alias}
              status={r.status}
              connName={r.connName}
              connOptions={connOptions}
              canRemove={rows.length > 1}
              onPatch={(patch) => patchRow(r.key, patch)}
              onRemove={() => removeRow(r.key)}
            />
          ))}
          <Space size={8} wrap>
            <Button size="small" icon={<PlusOutlined />} onClick={addRow}>
              Add connection
            </Button>
            <Text type="secondary" className="pg-hint" style={{ fontSize: 12 }}>
              Unqualified table names resolve across the attached schemas. Qualify as{' '}
              <code>alias.schema.table</code> only when the same name exists in two databases.
            </Text>
          </Space>
        </Space>
      </div>

      {aiError && !ai.open && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setAiError(null)}
          message={aiError}
          style={{ margin: '8px 12px 0' }}
        />
      )}
      {genWarning && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setGenWarning(false)}
          message="This AI-authored statement is not a read-only SELECT"
          description="It may modify or delete data. Review it carefully before you run it."
          style={{ margin: '8px 12px 0' }}
        />
      )}

      <div style={{ height: editorHeight, minHeight: 80, overflow: 'hidden', flexShrink: 0 }}>
        <SqlEditor
          ref={editorRef}
          value={sql}
          onChange={setSql}
          schema={null}
          basicSetup={EDITOR_BASIC_SETUP}
          extraExtensions={keymapExtension}
        />
      </div>

      <div
        className="pg-row-resizer"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={beginResize}
        title="Drag to resize editor"
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}>
        {error && (
          <Alert
            type="error"
            showIcon
            message="Federated query failed"
            action={<TroubleshootButton loading={tsLoading} onClick={troubleshoot} />}
            description={
              <>
                <div>{error}</div>
                {deriveSqlHint(sql, error) && (
                  <div style={{ marginTop: 6, opacity: 0.85 }}>💡 {deriveSqlHint(sql, error)}</div>
                )}
              </>
            }
            style={{ margin: 12 }}
          />
        )}
        {tsResult && (
          <TroubleshootPanel
            result={tsResult}
            onApply={applyTroubleshootFix}
            onClose={() => setTsResult(null)}
          />
        )}
        {!error && result && result.rows.length > 0 && (
          <QueryResultTable fields={result.fields} rows={result.rows} pageSize={PAGE_SIZE} />
        )}
        {!error && result && result.rows.length === 0 && (
          <div style={{ padding: 16, opacity: 0.65, fontSize: 13 }}>No rows returned.</div>
        )}
        {!error && !result && (
          <div style={{ padding: 16, opacity: 0.55, fontSize: 13 }}>
            Attach a connected database above, then press <kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> or
            click <strong>Run</strong> to execute.
          </div>
        )}
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => setAiError(null)}
      />

      <Modal
        title={aiBaseSql != null ? 'Refine selected SQL with AI' : 'Generate federated SQL with AI'}
        open={ai.open}
        onCancel={() => ai.setOpen(false)}
        onOk={ai.submit}
        okText={aiBaseSql != null ? 'Apply changes' : 'Generate'}
        okButtonProps={{ icon: <ThunderboltOutlined />, disabled: !ai.request.trim() }}
        confirmLoading={ai.loading}
        width={560}
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            The AI sees the tables + foreign keys of these attached databases and
            writes DuckDB SQL referencing them as <code>alias.schema.table</code>:
          </Text>
          <Space size={[6, 6]} wrap>
            {attachments.map((a) => (
              <Tag key={a.alias} color="processing" className="pg-mono">
                {a.alias}.{a.schema}
              </Tag>
            ))}
          </Space>
          {aiBaseSql != null && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Modifying your selected SQL — the result replaces the selection:
              </Text>
              <pre
                style={{
                  margin: '4px 0 0',
                  padding: 8,
                  maxHeight: 140,
                  overflow: 'auto',
                  fontSize: 12,
                  borderRadius: 4,
                  background: 'rgba(127,127,127,0.12)',
                  whiteSpace: 'pre-wrap'
                }}
              >
                {aiBaseSql}
              </pre>
            </div>
          )}
          <Input.TextArea
            autoFocus
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder={
              aiBaseSql != null
                ? 'Describe the change — e.g. “only orders from the last 30 days”, “also join crm.public.regions”. ⌘/Ctrl + Enter to apply.'
                : 'Describe the query in words — e.g. “list customers from crm with their latest order total from sales”. ⌘/Ctrl + Enter to generate.'
            }
            value={ai.request}
            onChange={(e) => ai.setRequest(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                ai.submit()
              }
            }}
            disabled={ai.loading}
          />
          {aiError && <Alert type="error" showIcon message={aiError} />}
        </Space>
      </Modal>

      <Modal
        title="Save federated query"
        open={saved.saveOpen}
        onCancel={() => saved.setSaveOpen(false)}
        onOk={saved.submitSave}
        okText="Save"
        confirmLoading={saved.saving}
        destroyOnClose
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Saves the {savedAttachments.length} attached database
            {savedAttachments.length === 1 ? '' : 's'}, the SQL, and the row limit
            setting under a unique name.
          </Text>
          <Input
            autoFocus
            placeholder="Query name"
            value={saved.saveName}
            onChange={(e) => saved.setSaveName(e.target.value)}
            onPressEnter={saved.submitSave}
          />
        </Space>
      </Modal>

      <Drawer
        title="Saved federated queries"
        placement="right"
        width={360}
        open={saved.listOpen}
        onClose={saved.closeList}
      >
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search saved queries…"
          value={saved.search}
          onChange={(e) => saved.setSearch(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        {saved.filtered.length === 0 ? (
          <Empty description={saved.items.length === 0 ? 'No saved queries yet' : 'No matches'} />
        ) : (
          <List
            size="small"
            dataSource={saved.filtered}
            renderItem={(q) => (
              <List.Item
                actions={[
                  <Button key="open" type="link" size="small" onClick={() => openSaved(q)}>
                    Open
                  </Button>,
                  <Popconfirm
                    key="del"
                    title="Delete this saved query?"
                    okText="Delete"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => saved.remove(q.id)}
                  >
                    <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                ]}
              >
                <List.Item.Meta
                  title={
                    <span style={{ cursor: 'pointer' }} onClick={() => openSaved(q)}>
                      {q.name}
                    </span>
                  }
                  description={
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {q.attachments.length} database{q.attachments.length === 1 ? '' : 's'} ·{' '}
                      {new Date(q.updated_at).toLocaleString()}
                    </Text>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Drawer>
    </div>
  )
}

// One attach row: connection + database pickers with the derived alias shown as
// a tag so the user knows how to qualify tables. Owns its database options via
// useDatabases (each row can target a different connection).
function AttachRowEditor({
  row,
  alias,
  status,
  connName,
  connOptions,
  canRemove,
  onPatch,
  onRemove
}: {
  row: AttachRow
  alias: string | null
  status: RowStatus
  connName: string | null
  connOptions: { label: string; value: string }[]
  canRemove: boolean
  onPatch: (patch: Partial<AttachRow>) => void
  onRemove: () => void
}) {
  const dbs = useDatabases(row.connectionId)
  const schemas = useSchemas(row.connectionId, row.database)
  // A saved query may reference a connection that isn't in the connected-only
  // option list (deleted or just not connected). Surface it as a synthetic
  // option so the Select shows a name instead of a raw id (D3).
  const options = useMemo(() => {
    if (row.connectionId && !connOptions.some((o) => o.value === row.connectionId)) {
      return [
        { label: connName ?? '(missing connection)', value: row.connectionId },
        ...connOptions
      ]
    }
    return connOptions
  }, [connOptions, row.connectionId, connName])
  return (
    <Space wrap size={8}>
      <Select
        showSearch
        size="small"
        optionFilterProp="label"
        placeholder="Connection"
        style={{ minWidth: 200 }}
        status={status === 'missing' ? 'error' : status === 'disconnected' ? 'warning' : undefined}
        options={options}
        value={row.connectionId ?? undefined}
        onChange={(v) => onPatch({ connectionId: v, database: null })}
      />
      <Select
        showSearch
        size="small"
        optionFilterProp="label"
        placeholder="Database"
        style={{ minWidth: 180 }}
        options={(dbs.data ?? []).map((d) => ({ label: d, value: d }))}
        value={row.database ?? undefined}
        disabled={!row.connectionId || dbs.isLoading}
        loading={dbs.isFetching}
        onChange={(v) => onPatch({ database: v })}
      />
      <Select
        showSearch
        size="small"
        optionFilterProp="label"
        placeholder="Schema"
        style={{ minWidth: 140 }}
        options={(schemas.data ?? []).map((s) => ({ label: s, value: s }))}
        value={row.schema}
        disabled={!row.database || schemas.isLoading}
        loading={schemas.isFetching}
        onChange={(v) => onPatch({ schema: v })}
      />
      {alias && (
        <Tag color="processing" className="pg-mono" style={{ margin: 0 }}>
          {alias}
        </Tag>
      )}
      {status === 'missing' && (
        <Tooltip title="This connection no longer exists. Remove the row or pick another connection.">
          <Tag color="error" style={{ margin: 0 }}>
            missing
          </Tag>
        </Tooltip>
      )}
      {status === 'disconnected' && (
        <Tooltip title="This connection exists but isn't connected. Connect it from the sidebar to run.">
          <Tag color="warning" style={{ margin: 0 }}>
            not connected
          </Tag>
        </Tooltip>
      )}
      <Button
        type="text"
        size="small"
        icon={<DeleteOutlined />}
        aria-label="Remove connection"
        disabled={!canRemove}
        onClick={onRemove}
      />
    </Space>
  )
}
