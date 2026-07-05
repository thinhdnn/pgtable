import React, { createContext, useContext, useRef, useState } from 'react'
import type { TabId, QueryTab, QueryTabSeed, LinkedQueryTab, FederatedTab } from '@shared/types'
import { tabKey } from '@shared/types'

interface ActiveState {
  connectionId: string | null
  database: string | null
  schema: string | null
  connectionStates: Record<string, 'connected' | 'disconnected' | 'failed'>
  tabs: TabId[]
  activeTabKey: string | null
  setConnectionId: (id: string | null) => void
  setDatabase: (db: string | null) => void
  setSchema: (schema: string | null) => void
  setConnectionState: (id: string, state: 'connected' | 'disconnected' | 'failed') => void
  openTab: (tab: TabId) => void
  /**
   * Open a new SQL editor tab against a connection/database. An optional seed
   * pre-fills a starter query for a specific table or the database's first
   * table.
   */
  openQueryTab: (connectionId: string, database: string, seed?: QueryTabSeed) => void
  /**
   * Open a new Linked Query tab. Not bound to any connection/database — each
   * Step inside the tab picks its own (see `history/linked-query/CONTEXT.md`
   * D5 and VQ2: unlimited tabs).
   */
  openLinkedQueryTab: () => void
  /**
   * Open a new Federated Query tab. Not bound to any connection/database — the
   * user picks which connections to ATTACH inside the tab and runs one SQL
   * statement across them via DuckDB.
   */
  openFederatedTab: () => void
  closeTab: (key: string) => void
  setActiveTab: (key: string) => void
}

const Ctx = createContext<ActiveState | null>(null)

export function ActiveConnectionProvider({ children }: { children: React.ReactNode }) {
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [database, setDatabase] = useState<string | null>(null)
  const [schema, setSchema] = useState<string | null>(null)
  const [connectionStates, setConnectionStates] = useState<
    Record<string, 'connected' | 'disconnected' | 'failed'>
  >({})
  const [tabs, setTabs] = useState<TabId[]>([])
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null)
  // Monotonically-increasing counter for default query-tab titles.
  const queryCounter = useRef(0)
  const linkedCounter = useRef(0)
  const federatedCounter = useRef(0)

  function setConnectionState(id: string, state: 'connected' | 'disconnected' | 'failed') {
    setConnectionStates((prev) => ({ ...prev, [id]: state }))
  }

  function openTab(tab: TabId) {
    const key = tabKey(tab)
    setTabs((prev) => {
      if (prev.find((t) => tabKey(t) === key)) return prev
      return [...prev, tab]
    })
    setActiveTabKey(key)
  }

  function openQueryTab(connectionId: string, database: string, seed?: QueryTabSeed) {
    queryCounter.current += 1
    const n = queryCounter.current
    const tab: QueryTab = {
      kind: 'query',
      id: `q-${Date.now()}-${n}`,
      connectionId,
      database,
      title: `Query ${n}`,
      ...(seed?.kind === 'table'
        ? { suggest: { schema: seed.schema, table: seed.table } }
        : {}),
      ...(seed?.kind === 'firstTable' ? { suggestFirstTable: true } : {}),
      ...(seed?.kind === 'sql' ? { initialSql: seed.sql } : {})
    }
    openTab(tab)
  }

  function openLinkedQueryTab() {
    linkedCounter.current += 1
    const n = linkedCounter.current
    const tab: LinkedQueryTab = {
      kind: 'linked-query',
      id: `linked-${Date.now()}-${n}`,
      title: `Linked ${n}`
    }
    openTab(tab)
  }

  function openFederatedTab() {
    federatedCounter.current += 1
    const n = federatedCounter.current
    const tab: FederatedTab = {
      kind: 'federated',
      id: `federated-${Date.now()}-${n}`,
      title: `Federated ${n}`
    }
    openTab(tab)
  }

  function closeTab(key: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => tabKey(t) !== key)
      if (activeTabKey === key) {
        setActiveTabKey(next.length > 0 ? tabKey(next[next.length - 1]) : null)
      }
      return next
    })
  }

  return (
    <Ctx.Provider
      value={{
        connectionId,
        openLinkedQueryTab,
        openFederatedTab,
        database,
        schema,
        connectionStates,
        tabs,
        activeTabKey,
        setConnectionId,
        setDatabase,
        setSchema,
        setConnectionState,
        openTab,
        openQueryTab,
        closeTab,
        setActiveTab: setActiveTabKey
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useActiveConnection(): ActiveState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useActiveConnection must be inside ActiveConnectionProvider')
  return ctx
}
