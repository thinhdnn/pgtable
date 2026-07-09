import { app, BrowserWindow, shell, ipcMain, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerConnectionHandlers } from './ipc/connection-handlers'
import { registerDbHandlers } from './ipc/db-handlers'
import { registerAiHandlers } from './ipc/ai-handlers'
import { migrateLegacyKey } from './db/settings-store'
import { registerLinkedQueryHandlers } from './ipc/linked-query-handlers'
import { registerFederatedHandlers } from './ipc/federated-handlers'
import { registerScriptHandlers } from './ipc/script-handlers'
import { registerFederatedScriptHandlers } from './ipc/federated-script-handlers'

const TITLEBAR_HEIGHT = 38

// Themed native window-control overlay (Windows). Mirrors the renderer's
// slate surfaces so the OS-drawn min/max/close buttons match the title bar.
function overlayColors(dark: boolean) {
  return {
    color: dark ? '#12161c' : '#ffffff',
    symbolColor: dark ? '#c9d1d9' : '#1f2328',
    height: TITLEBAR_HEIGHT
  }
}

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'
  const dark = nativeTheme.shouldUseDarkColors

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'pgtable',
    show: false,
    // macOS: keep native traffic lights, hide the bar, draw our own drag region.
    // Windows: hide the bar and overlay native controls themed to match.
    // Linux: keep the standard frame (no reliable frameless controls).
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 13, y: 12 } } : {}),
    ...(isWin ? { titleBarStyle: 'hidden' as const, titleBarOverlay: overlayColors(dark) } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.pgtable.app')

  app.on('browser-window-created', (_, win) => {
    optimizer.watchWindowShortcuts(win)
  })

  // Carry a key written by a pre-multi-provider build into the Anthropic slot
  // before any handler reads settings. Idempotent, so a re-run is harmless.
  migrateLegacyKey()

  registerConnectionHandlers()
  registerDbHandlers()
  registerAiHandlers()
  registerLinkedQueryHandlers()
  registerFederatedHandlers()
  registerScriptHandlers()
  registerFederatedScriptHandlers()

  // Let the renderer re-theme the Windows control overlay when the user
  // toggles light/dark. No-op on macOS/Linux.
  ipcMain.handle('window:set-overlay', (e, dark: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && process.platform === 'win32' && win.setTitleBarOverlay) {
      win.setTitleBarOverlay(overlayColors(dark))
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
