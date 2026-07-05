import React, { useEffect, useMemo, useState } from 'react'
import { Button, Input, Tree, Typography, Space, Dropdown, Tooltip, message, theme } from 'antd'
import type { GlobalToken } from 'antd'
import type { DataNode } from 'antd/es/tree'
import {
  DatabaseOutlined,
  TableOutlined,
  LinkOutlined,
  EyeOutlined,
  BlockOutlined,
  FieldNumberOutlined,
  FunctionOutlined,
  PlusOutlined,
  MoreOutlined,
  ReloadOutlined,
  MoonOutlined,
  SunOutlined,
  SearchOutlined,
  ConsoleSqlOutlined,
  CloseCircleFilled
} from '@ant-design/icons'
import type { Connection, ConnectionInput, DbObjectKind } from '@shared/types'
import { ConnectionForm } from '../connection/ConnectionForm'
import { useConnections, useDeleteConnection } from '../../hooks/useConnections'
import { useActiveConnection } from '../../store/active-connection'
import { useThemeMode } from '../../theme'
import { invoke } from '../../api'
import { IPC } from '@shared/ipc-channels'
import { LoadingPanel } from '../Loading'

const { Text } = Typography

type ConnState = 'connected' | 'disconnected' | 'failed'

// connected -> solid dot with a slow live pulse, failed -> solid red,
// disconnected -> hollow ring (clearly "off", never a stray bullet).
function StatusDot({ state, token }: { state: ConnState; token: GlobalToken }) {
  if (state === 'connected') {
    return (
      <span
        className="pg-dot pg-dot-live"
        style={{ ['--dot' as string]: token.colorSuccess } as React.CSSProperties}
      />
    )
  }
  if (state === 'failed') {
    return <span className="pg-dot" style={{ background: token.colorError }} />
  }
  return (
    <span
      className="pg-dot"
      style={{ background: 'transparent', border: `1.5px solid ${token.colorTextQuaternary}` }}
    />
  )
}

type NodeType = 'connection' | 'database' | 'schema' | 'category' | 'table' | 'view' | 'object'

interface NodeData {
  type: NodeType
  connectionId: string
  database?: string
  schema?: string
  table?: string
  kind?: DbObjectKind
}

// DBeaver-style object categories shown under each schema, in order.
const CATEGORIES: { kind: DbObjectKind; label: string; icon: React.ReactNode }[] = [
  { kind: 'table', label: 'Tables', icon: <TableOutlined /> },
  { kind: 'foreign', label: 'Foreign Tables', icon: <LinkOutlined /> },
  { kind: 'view', label: 'Views', icon: <EyeOutlined /> },
  { kind: 'matview', label: 'Materialized Views', icon: <BlockOutlined /> },
  { kind: 'sequence', label: 'Sequences', icon: <FieldNumberOutlined /> },
  { kind: 'function', label: 'Functions', icon: <FunctionOutlined /> }
]

function objectIcon(kind: DbObjectKind): React.ReactNode {
  switch (kind) {
    case 'foreign':
      return <LinkOutlined />
    case 'view':
      return <EyeOutlined />
    case 'matview':
      return <BlockOutlined />
    case 'sequence':
      return <FieldNumberOutlined />
    case 'function':
      return <FunctionOutlined />
    default:
      return <TableOutlined />
  }
}

export function Sidebar() {
  const [formOpen, setFormOpen] = useState(false)
  const [editConn, setEditConn] = useState<Connection | undefined>()
  const [cloneValues, setCloneValues] = useState<ConnectionInput | undefined>()
  const [loadedKeys, setLoadedKeys] = useState<Record<string, DataNode[]>>({})
  const [msg, msgCtx] = message.useMessage()

  const { data: connections = [], isLoading, refetch } = useConnections()
  const deleteConn = useDeleteConnection()
  const { connectionStates, setConnectionState, openTab, openQueryTab } = useActiveConnection()
  const { mode, toggle } = useThemeMode()
  const { token } = theme.useToken()

  // Controlled expansion so we can programmatically expand a connection after
  // an auto-connect, and force all matching paths open while searching.
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const [search, setSearch] = useState('')

  function openAddForm() {
    setEditConn(undefined)
    setCloneValues(undefined)
    setFormOpen(true)
  }

  function openEditForm(conn: Connection) {
    setCloneValues(undefined)
    setEditConn(conn)
    setFormOpen(true)
  }

  function openCloneForm(conn: Connection) {
    const taken = new Set(connections.map((c) => c.name))
    let name = `${conn.name} (copy)`
    for (let n = 2; taken.has(name); n++) name = `${conn.name} (copy ${n})`
    // Carry every field except identity/timestamps so credentials clone too.
    const { id: _id, created_at: _c, updated_at: _u, ...rest } = conn
    setEditConn(undefined)
    setCloneValues({ ...rest, name })
    setFormOpen(true)
  }

  async function handleConnect(conn: Connection) {
    const result = await invoke<{ ok: true } | { error: string }>(IPC.CONN_CONNECT, {
      id: conn.id
    })
    if ('error' in result) {
      setConnectionState(conn.id, 'failed')
      msg.error(`Connect failed: ${result.error}`)
      return false
    }
    setConnectionState(conn.id, 'connected')
    return true
  }

  async function handleDisconnect(conn: Connection) {
    await invoke(IPC.CONN_DISCONNECT, { id: conn.id })
    setConnectionState(conn.id, 'disconnected')
    setLoadedKeys((prev) => {
      const next = { ...prev }
      Object.keys(next).forEach((k) => {
        if (k.startsWith(conn.id)) delete next[k]
      })
      return next
    })
  }

  // Wrap names so the truncated text still exposes the full value on hover.
  const label = (name: string) => <span title={name}>{name}</span>

  async function loadChildren(key: string, data: NodeData): Promise<DataNode[]> {
    if (loadedKeys[key]) return loadedKeys[key]

    let children: DataNode[] = []
    const { connectionId, database, schema } = data

    if (data.type === 'connection') {
      const dbs = await invoke<string[]>(IPC.DB_LIST, { connectionId })
      children = (dbs as string[]).map((db) => {
        const dbKey = `${connectionId}::${db}`
        return {
          key: dbKey,
          title: (
            <Dropdown
              trigger={['contextMenu']}
              menu={{
                items: [
                  {
                    key: 'sql',
                    icon: <ConsoleSqlOutlined />,
                    label: 'Open SQL editor',
                    onClick: () => openQueryTab(connectionId, db, { kind: 'firstTable' })
                  }
                ]
              }}
            >
              <span title={db}>{db}</span>
            </Dropdown>
          ),
          icon: <DatabaseOutlined />,
          isLeaf: false,
          data: { type: 'database', connectionId, database: db } as NodeData
        }
      })
    } else if (data.type === 'database') {
      const schemas = await invoke<string[]>(IPC.SCHEMA_LIST, { connectionId, database })
      children = (schemas as string[]).map((sc) => {
        const scKey = `${connectionId}::${database}::${sc}`
        return {
          key: scKey,
          title: label(sc),
          isLeaf: false,
          data: { type: 'schema', connectionId, database, schema: sc } as NodeData
        }
      })
    } else if (data.type === 'schema') {
      // One folder per object kind (DBeaver-style). Hide kinds with nothing in
      // them; on a count error, show all rather than hide everything.
      const counts = await invoke<Record<DbObjectKind, number> | { error: string }>(
        IPC.OBJECT_COUNTS,
        { connectionId, database, schema }
      )
      const hasCounts = counts && !('error' in counts)
      children = CATEGORIES.filter(
        (cat) => !hasCounts || (counts as Record<DbObjectKind, number>)[cat.kind] > 0
      ).map((cat) => ({
        key: `${connectionId}::${database}::${schema}::@${cat.kind}`,
        title: cat.label,
        icon: cat.icon,
        isLeaf: false,
        selectable: false,
        data: { type: 'category', connectionId, database, schema, kind: cat.kind } as NodeData
      }))
    } else if (data.type === 'category') {
      const kind = data.kind!
      const res = await invoke<string[] | { error: string }>(IPC.OBJECT_LIST, {
        connectionId,
        database,
        schema,
        kind
      })
      const names = Array.isArray(res) ? res : []
      // Relations (tables, foreign tables, views, matviews) carry browsable rows;
      // sequences/functions are display-only.
      const openable =
        kind === 'table' || kind === 'foreign' || kind === 'view' || kind === 'matview'
      children = names.map((name) => ({
        key: `${connectionId}::${database}::${schema}::${kind}:${name}`,
        // Browsable relations get a right-click "Open SQL editor" that seeds a
        // starter query for this table; display-only objects keep a plain label.
        title: openable ? (
          <Dropdown
            trigger={['contextMenu']}
            menu={{
              items: [
                {
                  key: 'sql',
                  icon: <ConsoleSqlOutlined />,
                  label: 'Open SQL editor',
                  onClick: () =>
                    openQueryTab(connectionId, database!, { kind: 'table', schema: schema!, table: name })
                }
              ]
            }}
          >
            <span title={name}>{name}</span>
          </Dropdown>
        ) : (
          label(name)
        ),
        icon: objectIcon(kind),
        isLeaf: true,
        data: {
          type: openable ? (kind === 'view' || kind === 'matview' ? 'view' : 'table') : 'object',
          connectionId,
          database,
          schema,
          table: name
        } as NodeData
      }))
    }

    setLoadedKeys((prev) => ({ ...prev, [key]: children }))
    return children
  }

  // rc-tree ignores the children returned from loadData — they only render if
  // present in treeData. loadChildren caches every level in loadedKeys, so walk
  // it recursively and attach children at every depth (connection -> db ->
  // schema -> table), not just the top level.
  function attachChildren(nodes: DataNode[]): DataNode[] {
    return nodes.map((node) => {
      const loaded = loadedKeys[String(node.key)]
      return loaded ? { ...node, children: attachChildren(loaded) } : node
    })
  }

  function buildTree(): DataNode[] {
    return connections.map((conn) => ({
      key: conn.id,
      title: (
        <div className="pg-conn-row">
          <StatusDot state={connectionStates[conn.id] ?? 'disconnected'} token={token} />
          <span className="pg-conn-label">
            <span
              className="pg-conn-name"
              style={{
                color:
                  connectionStates[conn.id] === 'connected'
                    ? token.colorText
                    : token.colorTextSecondary
              }}
            >
              {conn.name}
            </span>
            <span className="pg-conn-host">
              {conn.host}:{conn.port}
            </span>
          </span>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'connect',
                  label:
                    connectionStates[conn.id] === 'connected' ? 'Disconnect' : 'Connect',
                  onClick: () =>
                    connectionStates[conn.id] === 'connected'
                      ? handleDisconnect(conn)
                      : handleConnect(conn)
                },
                { type: 'divider' },
                { key: 'edit', label: 'Edit', onClick: () => openEditForm(conn) },
                { key: 'clone', label: 'Clone', onClick: () => openCloneForm(conn) },
                { type: 'divider' },
                {
                  key: 'delete',
                  label: 'Delete',
                  danger: true,
                  onClick: () => deleteConn.mutate(conn.id)
                }
              ]
            }}
          >
            <MoreOutlined
              className="pg-conn-action"
              onClick={(e) => e.stopPropagation()}
            />
          </Dropdown>
        </div>
      ),
      isLeaf: connectionStates[conn.id] !== 'connected',
      selectable: false,
      data: { type: 'connection', connectionId: conn.id } as NodeData,
      children: loadedKeys[conn.id] ? attachChildren(loadedKeys[conn.id]) : undefined
    }))
  }

  // Recursively keep table/view leaves whose name matches the search, plus
  // every ancestor on the path. Returns the same tree shape so the renderer
  // doesn't need to know about filtering.
  function filterByTable(nodes: DataNode[], q: string): DataNode[] {
    const out: DataNode[] = []
    for (const node of nodes) {
      const data = (node as DataNode & { data?: NodeData }).data
      const isLeafObj =
        data?.type === 'table' || data?.type === 'view' || data?.type === 'object'
      const selfMatch =
        isLeafObj && !!data.table && data.table.toLowerCase().includes(q)
      const filteredChildren = node.children ? filterByTable(node.children, q) : []
      if (selfMatch) {
        out.push(node)
      } else if (filteredChildren.length > 0) {
        out.push({ ...node, children: filteredChildren })
      }
    }
    return out
  }

  function collectKeys(nodes: DataNode[]): React.Key[] {
    const out: React.Key[] = []
    for (const n of nodes) {
      out.push(n.key)
      if (n.children) out.push(...collectKeys(n.children))
    }
    return out
  }

  const treeData = useMemo(() => {
    const base = buildTree()
    const q = search.trim().toLowerCase()
    return q ? filterByTable(base, q) : base
    // buildTree is recomputed from connections/connectionStates/loadedKeys; keep
    // those in deps so the memo invalidates correctly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, connectionStates, loadedKeys, search])

  // While a search is active, force every matching ancestor open so results
  // are visible. Otherwise honour whatever the user expanded manually.
  const searchActive = search.trim().length > 0
  const effectiveExpandedKeys = useMemo(
    () => (searchActive ? collectKeys(treeData) : expandedKeys),
    [searchActive, treeData, expandedKeys]
  )

  // Backend search across loaded databases (plus each connected connection's
  // default database). Lazy-loaded subtrees aren't in the client tree yet, so
  // a client-only filter would miss tables that haven't been expanded once.
  interface SearchHit {
    connectionId: string
    database: string
    connName: string
    schema: string
    name: string
    relkind: string
  }
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)

  useEffect(() => {
    const q = search.trim()
    if (!q) {
      setSearchResults(null)
      setSearchLoading(false)
      return
    }
    let cancelled = false
    setSearchLoading(true)
    // Debounce ~180ms so each keystroke doesn't spawn a query storm. The
    // global search iterates every live pool on the main side, so the
    // renderer doesn't need to enumerate databases itself.
    const timer = setTimeout(async () => {
      const res = await invoke<
        | Array<{
            connectionId: string
            database: string
            schema: string
            name: string
            relkind: string
          }>
        | { error: string }
      >(IPC.TABLE_SEARCH_GLOBAL, { query: q, limit: 50 })
      if (cancelled) return
      if (!Array.isArray(res)) {
        setSearchResults([])
        setSearchLoading(false)
        return
      }
      const connNameById = new Map(connections.map((c) => [c.id, c.name]))
      const all: SearchHit[] = res.map((r) => ({
        connectionId: r.connectionId,
        database: r.database,
        connName: connNameById.get(r.connectionId) ?? r.connectionId,
        schema: r.schema,
        name: r.name,
        relkind: r.relkind
      }))
      // Surface exact-prefix matches first, then alpha.
      const ql = q.toLowerCase()
      all.sort((a, b) => {
        const ai = a.name.toLowerCase().startsWith(ql) ? 0 : 1
        const bi = b.name.toLowerCase().startsWith(ql) ? 0 : 1
        if (ai !== bi) return ai - bi
        return a.name.localeCompare(b.name)
      })
      setSearchResults(all)
      setSearchLoading(false)
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search, connections])

  function relkindIcon(relkind: string): React.ReactNode {
    if (relkind === 'v') return <EyeOutlined />
    if (relkind === 'm') return <BlockOutlined />
    if (relkind === 'f') return <LinkOutlined />
    return <TableOutlined />
  }

  return (
    <div
      className="pg-sidebar"
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {msgCtx}
      <div
        style={{
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${token.colorBorderSecondary}`
        }}
      >
        <Text strong style={{ fontSize: 13, letterSpacing: 0.2 }}>
          Connections
        </Text>
        <Space size={2}>
          <Tooltip title={mode === 'dark' ? 'Light mode' : 'Dark mode'}>
            <Button
              size="small"
              icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
              onClick={toggle}
              type="text"
            />
          </Tooltip>
          <Tooltip title="Refresh">
            <Button size="small" icon={<ReloadOutlined />} onClick={() => refetch()} type="text" />
          </Tooltip>
          <Tooltip title="Add connection">
            <Button size="small" icon={<PlusOutlined />} onClick={openAddForm} type="text" />
          </Tooltip>
        </Space>
      </div>

      {isLoading ? (
        <LoadingPanel />
      ) : (
        <>
          <div style={{ padding: '6px 10px 4px' }}>
            <Input
              size="small"
              allowClear
              prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
              placeholder="Search tables..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              suffix={
                search ? (
                  <CloseCircleFilled
                    style={{ color: token.colorTextTertiary, cursor: 'pointer' }}
                    onClick={() => setSearch('')}
                  />
                ) : null
              }
            />
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
            {searchActive ? (
              <SearchResultsList
                hits={searchResults ?? []}
                loading={searchLoading}
                onOpen={(h) => {
                  openTab({
                    kind: 'table',
                    connectionId: h.connectionId,
                    database: h.database,
                    schema: h.schema,
                    table: h.name
                  })
                }}
                relkindIcon={relkindIcon}
                token={token}
              />
            ) : (
              <Tree
                treeData={treeData}
                showIcon
                blockNode
                expandedKeys={effectiveExpandedKeys}
                onExpand={(keys) => setExpandedKeys(keys)}
                loadData={async (node) => {
                  const data = (node as unknown as DataNode & { data: NodeData }).data
                  const children = await loadChildren(String(node.key), data)
                  return children
                }}
                onDoubleClick={async (_e, node) => {
                  const data = (node as unknown as DataNode & { data: NodeData }).data
                  if (data?.type === 'table' || data?.type === 'view') {
                    openTab({
                      kind: 'table',
                      connectionId: data.connectionId,
                      database: data.database!,
                      schema: data.schema!,
                      table: data.table!
                    })
                    return
                  }
                  if (data?.type === 'connection') {
                    // Auto-connect and reveal the children inline.
                    const conn = connections.find((c) => c.id === data.connectionId)
                    if (!conn) return
                    const isConnected = connectionStates[conn.id] === 'connected'
                    const ok = isConnected ? true : await handleConnect(conn)
                    if (ok) {
                      setExpandedKeys((prev) =>
                        prev.includes(conn.id) ? prev : [...prev, conn.id]
                      )
                    }
                    return
                  }
                  // For any other branch node, toggle expansion to mimic native
                  // file-tree double-click behaviour.
                  const key = node.key as React.Key
                  setExpandedKeys((prev) =>
                    prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
                  )
                }}
              />
            )}
          </div>
        </>
      )}

      <ConnectionForm
        open={formOpen}
        existing={editConn}
        initialValues={cloneValues}
        onClose={() => setFormOpen(false)}
      />
    </div>
  )
}

// Flat search results — replaces the tree while a search query is active so
// users see every backend match, not just things expanded into the tree.
interface SearchHitView {
  connectionId: string
  database: string
  connName: string
  schema: string
  name: string
  relkind: string
}

interface SearchResultsListProps {
  hits: SearchHitView[]
  loading: boolean
  onOpen: (hit: SearchHitView) => void
  relkindIcon: (relkind: string) => React.ReactNode
  token: GlobalToken
}

function SearchResultsList({
  hits,
  loading,
  onOpen,
  relkindIcon,
  token
}: SearchResultsListProps): React.ReactElement {
  if (loading && hits.length === 0) {
    return <LoadingPanel tip="Searching..." />
  }
  if (hits.length === 0) {
    return (
      <div style={{ padding: '16px 14px', fontSize: 12, color: token.colorTextTertiary }}>
        No tables match. Connect to a database first if you haven't already.
      </div>
    )
  }
  return (
    <div className="pg-search-results">
      {hits.map((h) => {
        const key = `${h.connectionId}::${h.database}::${h.schema}::${h.name}`
        return (
          <div
            key={key}
            className="pg-search-row"
            onMouseDown={(e) => {
              // The second mousedown of a dblclick still selects nearby text
              // by default; cancel it so the row stays clean.
              if (e.detail > 1) e.preventDefault()
            }}
            onDoubleClick={() => onOpen(h)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onOpen(h)
            }}
            tabIndex={0}
            role="button"
            title={`${h.schema}.${h.name} \u00b7 ${h.connName} / ${h.database}`}
          >
            <span className="pg-search-icon" style={{ color: token.colorTextSecondary }}>
              {relkindIcon(h.relkind)}
            </span>
            <span className="pg-search-name">
              <span style={{ color: token.colorTextSecondary }}>{h.schema}.</span>
              <span style={{ color: token.colorText, fontWeight: 500 }}>{h.name}</span>
            </span>
            <span className="pg-search-meta" style={{ color: token.colorTextTertiary }}>
              {h.connName} / {h.database}
            </span>
          </div>
        )
      })}
    </div>
  )
}
