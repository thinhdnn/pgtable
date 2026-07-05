import React, { useCallback, useRef, useState } from 'react'
import { Tabs, Typography, theme, Tooltip } from 'antd'
import { TableOutlined } from '@ant-design/icons'
import { Sidebar } from './components/sidebar/Sidebar'
import { TableViewer } from './components/table-viewer/TableViewer'
import { QueryEditor } from './components/query/QueryEditor'
import { LinkedQueryTab } from './components/linked-query/LinkedQueryTab'
import { FederatedQueryTab } from './components/federated/FederatedQueryTab'
import { TitleBar } from './components/TitleBar'
import { useActiveConnection } from './store/active-connection'
import { tabKey } from '@shared/types'

const { Title, Text } = Typography

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 480
const SIDEBAR_DEFAULT = 260
const SIDEBAR_KEY = 'pgtable.sidebar-width'

const clampWidth = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w))

function initialSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_KEY))
  return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : SIDEBAR_DEFAULT
}

function EmptyState() {
  const { token } = theme.useToken()
  return (
    <div
      style={{
        margin: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        textAlign: 'center',
        padding: 24
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 14,
          color: token.colorPrimary,
          background: token.colorPrimaryBg,
          fontSize: 26
        }}
      >
        <TableOutlined />
      </div>
      <Title level={5} style={{ margin: 0 }}>
        No table open
      </Title>
      <Text type="secondary" style={{ maxWidth: 320 }}>
        Connect to a database in the sidebar, then double-click any table or view to inspect its
        rows and columns here.
      </Text>
    </div>
  )
}

export function App() {
  const { token } = theme.useToken()
  const { tabs, activeTabKey, closeTab, setActiveTab, openQueryTab } = useActiveConnection()

  // Derive a connection/database for a fresh query tab from the currently
  // active tab. Both tab kinds carry that context, so the editor always opens
  // bound to whatever the user is looking at.
  const activeTab = tabs.find((t) => tabKey(t) === activeTabKey) ?? tabs[tabs.length - 1]
  // Linked and Federated Query tabs have no single connection context, so they
  // can't seed a new query tab. Only table/query tabs enable the "+ SQL" button.
  const canOpenQuery = !!activeTab && (activeTab.kind === 'table' || activeTab.kind === 'query')
  const onAddTab = useCallback(() => {
    if (!activeTab || (activeTab.kind !== 'table' && activeTab.kind !== 'query')) return
    // Opening from a table tab seeds a starter query for that table; any other
    // active tab opens a blank editor.
    if (activeTab.kind === 'table') {
      openQueryTab(activeTab.connectionId, activeTab.database, {
        kind: 'table',
        schema: activeTab.schema,
        table: activeTab.table
      })
    } else {
      openQueryTab(activeTab.connectionId, activeTab.database)
    }
  }, [activeTab, openQueryTab])

  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth)
  const sidebarRef = useRef<HTMLDivElement>(null)

  const commitWidth = useCallback((w: number) => {
    const clamped = clampWidth(w)
    setSidebarWidth(clamped)
    localStorage.setItem(SIDEBAR_KEY, String(clamped))
  }, [])

  // Drive the width on the DOM during the drag so the (potentially heavy) table
  // content does not re-render on every mouse move; commit to React on release.
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = sidebarRef.current?.offsetWidth ?? sidebarWidth
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent) => {
        const w = clampWidth(startW + (ev.clientX - startX))
        if (sidebarRef.current) sidebarRef.current.style.width = `${w}px`
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        commitWidth(sidebarRef.current?.offsetWidth ?? startW)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [sidebarWidth, commitWidth]
  )

  const onResizerKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') commitWidth(sidebarWidth - 16)
      else if (e.key === 'ArrowRight') commitWidth(sidebarWidth + 16)
    },
    [sidebarWidth, commitWidth]
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <TitleBar />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', background: token.colorBgLayout }}>
        <div
          ref={sidebarRef}
          style={{
            width: sidebarWidth,
            flexShrink: 0,
            overflow: 'auto',
            background: token.colorBgContainer,
            borderRight: `1px solid ${token.colorBorderSecondary}`
          }}
        >
          <Sidebar />
        </div>

        <div
          className="pg-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          tabIndex={0}
          onMouseDown={startResize}
          onDoubleClick={() => commitWidth(SIDEBAR_DEFAULT)}
          onKeyDown={onResizerKey}
        />

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}
        >
          {tabs.length === 0 ? (
            <EmptyState />
          ) : (
            <Tabs
              className="pg-fill-tabs"
              type="editable-card"
              hideAdd={!canOpenQuery}
              size="small"
              activeKey={activeTabKey ?? undefined}
              onChange={setActiveTab}
              onEdit={(key, action) => {
                if (action === 'remove') closeTab(String(key))
                else if (action === 'add') onAddTab()
              }}
              style={{ height: '100%' }}
              tabBarStyle={{ paddingLeft: 8, marginBottom: 0 }}
              addIcon={
                <Tooltip title="New SQL query (uses the active tab's connection)">
                  <span>+ SQL</span>
                </Tooltip>
              }
              items={tabs.map((tab) => {
                const key = tabKey(tab)
                if (tab.kind === 'query') {
                  return {
                    key,
                    label: tab.title,
                    children: <QueryEditor tab={tab} />,
                    closable: true
                  }
                }
                if (tab.kind === 'linked-query') {
                  return {
                    key,
                    label: tab.title,
                    children: <LinkedQueryTab tab={tab} />,
                    closable: true
                  }
                }
                if (tab.kind === 'federated') {
                  return {
                    key,
                    label: tab.title,
                    children: <FederatedQueryTab tab={tab} />,
                    closable: true
                  }
                }
                return {
                  key,
                  label: `${tab.schema}.${tab.table}`,
                  children: <TableViewer tab={tab} />,
                  closable: true
                }
              })}
            />
          )}
        </div>
      </div>
    </div>
  )
}
