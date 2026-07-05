import React, { useState } from 'react'
import { theme, Button, Tooltip } from 'antd'
import { SettingOutlined, LinkOutlined, ClusterOutlined } from '@ant-design/icons'
import { useActiveConnection } from '../store/active-connection'
import { tabKey } from '@shared/types'
import { SettingsModal } from './settings/SettingsModal'

export const TITLEBAR_HEIGHT = 38

const platform = window.pgtable?.platform
const isMac = platform === 'darwin'
const isWin = platform === 'win32'

// Leave room for the OS-drawn controls living inside the drag region:
// macOS traffic lights at top-left, Windows min/max/close overlay at top-right.
const padLeft = isMac ? 78 : 14
const padRight = isWin ? 146 : 14

export function TitleBar() {
  const { token } = theme.useToken()
  const { tabs, activeTabKey, openLinkedQueryTab, openFederatedTab } = useActiveConnection()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const active = tabs.find((t) => tabKey(t) === activeTabKey)
  let context: string | null = null
  if (active) {
    if (active.kind === 'query') context = `${active.database} · ${active.title}`
    else if (active.kind === 'table') context = `${active.schema}.${active.table}`
    else if (active.kind === 'linked-query') context = active.title
    else if (active.kind === 'federated') context = active.title
  }

  return (
    <div
      style={{
        height: TITLEBAR_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingLeft: padLeft,
        paddingRight: padRight,
        background: token.colorBgElevated,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        WebkitAppRegion: 'drag',
        userSelect: 'none'
      } as React.CSSProperties}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: token.colorPrimary,
          boxShadow: `0 0 0 3px ${token.colorPrimaryBg}`
        }}
      />
      <span
        style={{
          fontFamily: 'var(--ant-font-family-code)',
          fontSize: 12.5,
          fontWeight: 600,
          letterSpacing: 0.3,
          color: token.colorText
        }}
      >
        pgtable
      </span>
      {context && (
        <>
          <span style={{ color: token.colorSplit }}>/</span>
          <span
            style={{
              fontFamily: 'var(--ant-font-family-code)',
              fontSize: 12,
              color: token.colorTextSecondary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {context}
          </span>
        </>
      )}
      <div
        style={{ marginLeft: 'auto', display: 'flex', gap: 4, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Tooltip title="Open a Linked Query tab — chain two SELECTs across databases">
          <Button
            type="text"
            size="small"
            icon={<LinkOutlined />}
            aria-label="Linked Query"
            onClick={openLinkedQueryTab}
          />
        </Tooltip>
        <Tooltip title="Open a Federated Query tab — run one SQL across several databases (DuckDB)">
          <Button
            type="text"
            size="small"
            icon={<ClusterOutlined />}
            aria-label="Federated Query"
            onClick={openFederatedTab}
          />
        </Tooltip>
        <Tooltip title="Settings">
          <Button
            type="text"
            size="small"
            icon={<SettingOutlined />}
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          />
        </Tooltip>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
