import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { ConfigProvider, App as AntApp, theme as antdTheme, type ThemeConfig } from 'antd'

export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'pgtable.theme-mode'

// UI uses the platform grotesk; data, types and identifiers use a real monospace
// so columns line up and numbers read as numbers. No web fonts — this is a desktop app.
const FONT_UI =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", system-ui, Arial, sans-serif'
const FONT_MONO =
  'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, "Cascadia Code", "Roboto Mono", monospace'

// One accent, cool-slate neutrals. Teal reads "database / terminal" and stays clear
// of antd's default blue while leaving green/red free for connection status.
const ACCENT_LIGHT = '#0d9488'
const ACCENT_DARK = '#2dd4bf'

export function buildTheme(mode: ThemeMode): ThemeConfig {
  const isDark = mode === 'dark'
  return {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    cssVar: true,
    token: {
      colorPrimary: isDark ? ACCENT_DARK : ACCENT_LIGHT,
      colorInfo: isDark ? ACCENT_DARK : ACCENT_LIGHT,
      colorSuccess: isDark ? '#22c55e' : '#16a34a',
      colorError: isDark ? '#f87171' : '#dc2626',
      borderRadius: 6,
      fontFamily: FONT_UI,
      fontFamilyCode: FONT_MONO,
      fontSize: 13,
      // Cool-tinted neutrals for a cohesive slate identity in both modes.
      colorBgLayout: isDark ? '#0e1116' : '#f3f4f6',
      colorBgContainer: isDark ? '#161b22' : '#ffffff',
      colorBgElevated: isDark ? '#1c222b' : '#ffffff',
      colorBorderSecondary: isDark ? '#222a35' : '#ebedf0',
      colorBorder: isDark ? '#2c3543' : '#dfe3e8'
    },
    components: {
      Layout: {
        siderBg: isDark ? '#12161c' : '#ffffff',
        bodyBg: isDark ? '#0e1116' : '#f3f4f6'
      },
      Tabs: {
        cardBg: isDark ? '#12161c' : '#f3f4f6',
        horizontalItemPadding: '6px 14px'
      },
      Tree: {
        nodeHoverBg: isDark ? 'rgba(45,212,191,0.10)' : 'rgba(13,148,136,0.08)',
        nodeSelectedBg: isDark ? 'rgba(45,212,191,0.16)' : 'rgba(13,148,136,0.12)',
        titleHeight: 30
      },
      Button: {
        primaryShadow: 'none',
        defaultShadow: 'none'
      }
    }
  }
}

interface ThemeModeCtx {
  mode: ThemeMode
  toggle: () => void
  setMode: (m: ThemeMode) => void
}

const Ctx = createContext<ThemeModeCtx | null>(null)

export function useThemeMode(): ThemeModeCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useThemeMode must be used within ThemeModeProvider')
  return ctx
}

function initialMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode)

  const setMode = (m: ThemeMode) => {
    setModeState(m)
    localStorage.setItem(STORAGE_KEY, m)
  }
  const toggle = () => setMode(mode === 'dark' ? 'light' : 'dark')

  // Drive native form controls, scrollbars and selection colors per mode,
  // and re-theme the native window-control overlay (Windows).
  useEffect(() => {
    document.documentElement.dataset.theme = mode
    document.documentElement.style.colorScheme = mode
    window.pgtable?.setTitleBarOverlay?.(mode === 'dark')
  }, [mode])

  // Follow the OS only while the user has not made an explicit choice.
  useEffect(() => {
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mql) return
    const onChange = (e: MediaQueryListEvent) => {
      if (!localStorage.getItem(STORAGE_KEY)) setModeState(e.matches ? 'dark' : 'light')
    }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const value = useMemo(() => ({ mode, toggle, setMode }), [mode])
  const themeConfig = useMemo(() => buildTheme(mode), [mode])

  return (
    <Ctx.Provider value={value}>
      <ConfigProvider theme={themeConfig}>
        <AntApp>{children}</AntApp>
      </ConfigProvider>
    </Ctx.Provider>
  )
}
