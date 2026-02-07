import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, nativeImage } from 'electron'

import { initDatabase, listWorkstreams } from './database'
import { registerIpcHandlers } from './ipc-handlers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null

// Ensure a stable app identity and storage path in dev and production.
app.setName('Rettib')
app.setPath('userData', path.join(app.getPath('appData'), 'rettib'))

function firstExistingPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return candidates[0]
}

function resolvePreloadPath(): string {
  return firstExistingPath([
    path.join(__dirname, 'preload.cjs'),
    path.join(app.getAppPath(), 'dist-electron/preload.cjs')
  ])
}

function resolveRendererHtmlPath(): string {
  return firstExistingPath([
    path.join(__dirname, '../dist/renderer/index.html'),
    path.join(__dirname, '../renderer/index.html'),
    path.join(app.getAppPath(), 'dist/renderer/index.html')
  ])
}

function resolveAppIconPath(): string {
  return firstExistingPath([
    path.join(app.getAppPath(), 'build/icon.png'),
    path.join(__dirname, '../build/icon.png')
  ])
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'Rettib',
    icon: resolveAppIconPath(),
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL

  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(resolveRendererHtmlPath())
  }

  return window
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  app.dock?.setIcon(nativeImage.createFromPath(resolveAppIconPath()))

  const dbPath = path.join(app.getPath('userData'), 'rettib.db')
  console.log('[Rettib] DB path:', dbPath)
  const db = initDatabase(dbPath)
  console.log('[Rettib] Seeded workstreams:', listWorkstreams(db).length)
  registerIpcHandlers()

  mainWindow = createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
    }
  })
}

void bootstrap()

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
