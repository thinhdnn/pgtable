import React, { useCallback, useMemo, useState } from 'react'
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
  message,
  theme
} from 'antd'
import {
  PlayCircleOutlined,
  ClusterOutlined,
  PlusOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
  SaveOutlined,
  SearchOutlined,
  FolderOpenOutlined
} from '@ant-design/icons'
import type {
  FederatedTab as FederatedTabModel,
  FederatedAttachment,
  FederatedRunResult,
  FederatedRunOutcome,
  Connection,
  SavedFederatedQuery,
  SavedFederatedQueryInput
} from '@shared/types'
import { IPC } from '@shared/ipc-channels'
import { deriveAlias, FEDERATED_ROW_LIMIT } from '@shared/federated'
import { invoke } from '../../api'
import { useConnections } from '../../hooks/useConnections'
import { useDatabases, useSchemas } from '../../hooks/useDatabases'
import { useSavedQueries } from '../../hooks/useSavedQueries'
import { useAiGenerate } from '../../hooks/useAiGenerate'
import { useActiveConnection } from '../../store/active-connection'
import { deriveSqlHint } from '../../utils/sql-hints'
import { SqlEditor } from '../common/SqlEditor'
import { QueryResultTable } from '../common/QueryResultTable'

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

export function FederatedQueryTab({ tab }: Props): React.ReactElement {
  const { token } = theme.useToken()
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
  // When true, bare SELECTs get a safety LIMIT. Defaults off — queries run with no
  // row cap unless the user turns it on from the toolbar.
  const [autoLimit, setAutoLimit] = useState(false)

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
  // State (open/request/loading) + generate orchestration live in the shared
  // useAiGenerate hook; the attachment pre-check and where the SQL lands stay here.
  const ai = useAiGenerate<{ attachments: FederatedAttachment[]; request: string }>({
    channel: IPC.AI_GENERATE_FEDERATED_SQL,
    setError: setAiError,
    buildPayload: (request) => {
      if (attachments.length === 0) {
        setAiError('Attach at least one connected database first.')
        return null
      }
      return { attachments, request }
    },
    onResult: (sql) => {
      setSql(sql)
      setResult(null)
      setError(null)
    }
  })

  async function run() {
    if (!canRun) return
    setRunning(true)
    setError(null)
    try {
      const res = await invoke<FederatedRunOutcome>(IPC.FEDERATED_RUN, {
        attachments,
        sql,
        autoLimit
      })
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
    }
  }

  // Drag the handle under the editor to resize it. Pointer capture keeps the drag
  // alive while the cursor moves over the CodeMirror surface; height is clamped.
  function beginResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = editorHeight
    const move = (ev: PointerEvent): void => {
      const next = Math.max(120, Math.min(900, startH + (ev.clientY - startY)))
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
    <div style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', padding: 16 }}>
      <Space direction="vertical" size={12} style={{ width: '100%', minWidth: 0 }}>
        <Space align="center" wrap>
          <ClusterOutlined style={{ color: token.colorPrimary }} />
          <Text strong>{tab.title}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Attach several databases and run one SQL across them (DuckDB).
            Unqualified table names resolve across the attached schemas; qualify
            as <code>alias.schema.table</code> only on name collisions.
          </Text>
        </Space>

        <div
          style={{
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusSM,
            padding: 12,
            background: token.colorFillQuaternary
          }}
        >
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
            <Button icon={<PlusOutlined />} size="small" onClick={addRow}>
              Add connection
            </Button>
          </Space>
        </div>

        <Space>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={running}
            disabled={!canRun}
            onClick={run}
          >
            Run
          </Button>
          <Tooltip
            title={
              attachments.length === 0
                ? 'Attach at least one connected database first'
                : 'Describe the query in words — the AI writes DuckDB SQL across the attached databases'
            }
          >
            <Button
              icon={<ThunderboltOutlined />}
              disabled={attachments.length === 0}
              onClick={() => {
                setAiError(null)
                ai.setRequest('')
                ai.setOpen(true)
              }}
            >
              Ask AI
            </Button>
          </Tooltip>
          <Tooltip title="Save this federated query (attachments + SQL) as a named entry">
            <Button
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
            <Button
              icon={<FolderOpenOutlined />}
              onClick={saved.openList}
            >
              Saved
            </Button>
          </Tooltip>
          <Tooltip
            title={
              autoLimit
                ? `Bare SELECTs run with LIMIT ${FEDERATED_ROW_LIMIT}. Click to run with no row cap.`
                : 'Queries run with no row cap. Click to re-enable the auto LIMIT safety net.'
            }
          >
            <Tag
              color={autoLimit ? 'blue' : 'warning'}
              style={{ cursor: 'pointer', userSelect: 'none', margin: 0 }}
              onClick={() => setAutoLimit((v) => !v)}
            >
              {autoLimit ? `Limit ${FEDERATED_ROW_LIMIT}` : 'No limit'}
            </Tag>
          </Tooltip>
          {attachments.length === 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              Pick at least one connected database to run.
            </Text>
          )}
        </Space>

        <div>
          <div
            style={{
              height: editorHeight,
              display: 'flex',
              overflow: 'hidden',
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadiusSM
            }}
          >
            <SqlEditor
              value={sql}
              onChange={setSql}
              schema={null}
              basicSetup={{ foldGutter: true }}
              style={{ width: '100%', height: '100%' }}
            />
          </div>
          <div
            className="pg-row-resizer"
            role="separator"
            aria-orientation="horizontal"
            onPointerDown={beginResize}
            title="Drag to resize editor"
          />
        </div>

        {error && (
          <Alert
            type="error"
            showIcon
            message="Federated query failed"
            description={
              <>
                <div>{error}</div>
                {deriveSqlHint(sql, error) && (
                  <div style={{ marginTop: 6, opacity: 0.85 }}>💡 {deriveSqlHint(sql, error)}</div>
                )}
              </>
            }
          />
        )}

        {result && (
          <QueryResultTable
            fields={result.fields}
            rows={result.rows}
            pageSize={PAGE_SIZE}
            maxBodyHeight={360}
            toolbarLeft={
              <Text type="secondary" style={{ fontSize: 12 }}>
                {result.rowCount} rows · {result.durationMs} ms
                {result.autoLimited && ' · auto LIMIT applied'}
              </Text>
            }
          />
        )}
      </Space>

      <Modal
        title="Generate federated SQL with AI"
        open={ai.open}
        onCancel={() => ai.setOpen(false)}
        onOk={ai.submit}
        okText="Generate"
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
              <Tag key={a.alias} color="blue" style={{ fontFamily: 'var(--ant-font-family-code)' }}>
                {a.alias}.{a.schema}
              </Tag>
            ))}
          </Space>
          <Input.TextArea
            autoFocus
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder="Describe the query in words — e.g. “list customers from crm with their latest order total from sales”. ⌘/Ctrl + Enter to generate."
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
    <Space wrap>
      <Select
        showSearch
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
        optionFilterProp="label"
        placeholder="Schema"
        style={{ minWidth: 140 }}
        options={(schemas.data ?? []).map((s) => ({ label: s, value: s }))}
        value={row.schema}
        disabled={!row.database || schemas.isLoading}
        loading={schemas.isFetching}
        onChange={(v) => onPatch({ schema: v })}
      />
      {alias && <Tag color="blue" style={{ fontFamily: 'var(--ant-font-family-code)' }}>{alias}</Tag>}
      {status === 'missing' && (
        <Tooltip title="This connection no longer exists. Remove the row or pick another connection.">
          <Tag color="error">missing</Tag>
        </Tooltip>
      )}
      {status === 'disconnected' && (
        <Tooltip title="This connection exists but isn't connected. Connect it from the sidebar to run.">
          <Tag color="warning">not connected</Tag>
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
