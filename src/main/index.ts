import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, nativeImage } from 'electron'

import { initDatabase, listWorkstreams } from './database'
import { registerIpcHandlers } from './ipc-handlers'
import { stopTerminalSession } from './terminal-session-manager'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null

// Ensure a stable app identity and storage path in dev and production.
app.setName('Rettib')
app.setPath('userData', path.join(app.getPath('appData'), 'rettib'))

function parseEnvAssignment(rawLine: string): [string, string] | null {
  const trimmedLine = rawLine.trim()
  if (!trimmedLine || trimmedLine.startsWith('#')) {
    return null
  }

  const line = trimmedLine.startsWith('export ') ? trimmedLine.slice(7).trim() : trimmedLine
  const separatorIndex = line.indexOf('=')
  if (separatorIndex <= 0) {
    return null
  }

  const key = line.slice(0, separatorIndex).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null
  }

  let value = line.slice(separatorIndex + 1).trim()
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"')
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'")

  if (isDoubleQuoted || isSingleQuoted) {
    value = value.slice(1, -1)
  } else {
    const commentIndex = value.indexOf(' #')
    if (commentIndex >= 0) {
      value = value.slice(0, commentIndex).trim()
    }
  }

  if (isDoubleQuoted) {
    value = value.replace(/\\n/g, '\n')
  }

  return [key, value]
}

function loadDotEnvFile(filePath: string, lockedEnvKeys: Set<string>): void {
  if (!fs.existsSync(filePath)) {
    return
  }

  let fileContents: string
  try {
    fileContents = fs.readFileSync(filePath, 'utf8')
  } catch {
    return
  }

  for (const line of fileContents.split(/\r?\n/)) {
    const assignment = parseEnvAssignment(line)
    if (!assignment) {
      continue
    }

    const [key, value] = assignment
    if (lockedEnvKeys.has(key)) {
      continue
    }

    process.env[key] = value
  }
}

function loadLocalEnvFiles(): void {
  const lockedEnvKeys = new Set(Object.keys(process.env))
  const candidateRoots = Array.from(
    new Set([process.cwd(), path.resolve(__dirname, '..'), path.resolve(__dirname, '../..')])
  )

  for (const rootPath of candidateRoots) {
    loadDotEnvFile(path.join(rootPath, '.env'), lockedEnvKeys)
    loadDotEnvFile(path.join(rootPath, '.env.local'), lockedEnvKeys)
  }
}

loadLocalEnvFiles()

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
  stopTerminalSession()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
