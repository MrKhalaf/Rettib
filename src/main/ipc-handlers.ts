import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ipcMain, shell } from 'electron'

import type { CreateWorkstreamInput, UpdateTaskInput, UpdateWorkstreamInput } from '../shared/types'
import { ClaudeConnector } from './claude-connector'
import {
  completeSyncRun,
  createSyncRun,
  createTask,
  createWorkstream,
  deleteTask,
  getDatabase,
  getOrCreateClaudeSyncSource,
  getWorkstream,
  linkChatReference,
  listChatReferences,
  listProgress,
  listSyncRuns,
  listTasks,
  logProgress,
  unlinkChatReference,
  updateClaudeSourcePath,
  updateTask,
  updateWorkstream
} from './database'
import { calculateRankings, calculateRankingsWithChat } from './ranking-engine'

function ensureNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`)
  }

  return value
}

function ensureString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`)
  }

  return value
}

function parseClaudePathFromSourceConfig(config: string): string | null {
  try {
    const parsed = JSON.parse(config) as { path?: unknown }
    return typeof parsed.path === 'string' ? parsed.path : null
  } catch {
    return null
  }
}

function makeConnectorFromSource(): ClaudeConnector {
  const db = getDatabase()
  const source = getOrCreateClaudeSyncSource(db)
  const configuredPath = parseClaudePathFromSourceConfig(source.config)
  return new ClaudeConnector(configuredPath ?? undefined)
}

function resolveObsidianNotePath(noteRef: string): string | null {
  const trimmed = noteRef.trim()
  if (!trimmed) {
    return null
  }

  const normalized = trimmed.replace(/\\/g, '/').replace(/\.md$/i, '')
  const fileName = `${normalized}.md`

  if (path.isAbsolute(fileName) && fs.existsSync(fileName)) {
    return fileName
  }

  const iCloudObsidianRoot = path.join(
    os.homedir(),
    'Library',
    'Mobile Documents',
    'iCloud~md~obsidian',
    'Documents'
  )

  if (!fs.existsSync(iCloudObsidianRoot)) {
    return null
  }

  const directCandidate = path.join(iCloudObsidianRoot, fileName)
  if (fs.existsSync(directCandidate)) {
    return directCandidate
  }

  const vaultDirs = fs
    .readdirSync(iCloudObsidianRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(iCloudObsidianRoot, entry.name))

  for (const vaultDir of vaultDirs) {
    const candidate = path.join(vaultDir, fileName)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

export function registerIpcHandlers(): void {
  ipcMain.handle('workstreams:list', async () => {
    const db = getDatabase()
    return calculateRankingsWithChat(db)
  })

  ipcMain.handle('workstreams:get', async (_event, id: unknown) => {
    const workstreamId = ensureNumber(id, 'workstream id')
    const db = getDatabase()
    const rankedWorkstream = calculateRankings(db).find((item) => item.id === workstreamId)

    if (!rankedWorkstream) {
      return null
    }

    return {
      workstream: rankedWorkstream,
      tasks: listTasks(workstreamId, db),
      progress: listProgress(workstreamId, db),
      chats: listChatReferences(workstreamId, db)
    }
  })

  ipcMain.handle('workstreams:create', async (_event, data: unknown) => {
    const payload = data as CreateWorkstreamInput
    return createWorkstream(payload, getDatabase())
  })

  ipcMain.handle('workstreams:update', async (_event, id: unknown, data: unknown) => {
    const workstreamId = ensureNumber(id, 'workstream id')
    const payload = data as UpdateWorkstreamInput
    updateWorkstream(workstreamId, payload, getDatabase())
  })

  ipcMain.handle('progress:log', async (_event, workstreamId: unknown, note: unknown) => {
    const id = ensureNumber(workstreamId, 'workstream id')
    const progressNote = ensureString(note, 'note')
    logProgress(id, progressNote, getDatabase())
  })

  ipcMain.handle('progress:list', async (_event, workstreamId: unknown) => {
    const id = ensureNumber(workstreamId, 'workstream id')
    return listProgress(id, getDatabase())
  })

  ipcMain.handle('tasks:list', async (_event, workstreamId: unknown) => {
    const id = ensureNumber(workstreamId, 'workstream id')
    return listTasks(id, getDatabase())
  })

  ipcMain.handle('tasks:create', async (_event, workstreamId: unknown, title: unknown) => {
    const id = ensureNumber(workstreamId, 'workstream id')
    const taskTitle = ensureString(title, 'title')
    return createTask({ workstream_id: id, title: taskTitle }, getDatabase())
  })

  ipcMain.handle('tasks:update', async (_event, id: unknown, data: unknown) => {
    const taskId = ensureNumber(id, 'task id')
    const payload = data as UpdateTaskInput
    updateTask(taskId, payload, getDatabase())
  })

  ipcMain.handle('tasks:delete', async (_event, id: unknown) => {
    const taskId = ensureNumber(id, 'task id')
    deleteTask(taskId, getDatabase())
  })

  ipcMain.handle('chat:list-conversations', async () => {
    const connector = makeConnectorFromSource()
    return connector.listConversations()
  })

  ipcMain.handle('chat:link', async (_event, workstreamId: unknown, conversationUuid: unknown) => {
    const id = ensureNumber(workstreamId, 'workstream id')
    const uuid = ensureString(conversationUuid, 'conversation uuid')
    const connector = makeConnectorFromSource()

    const conversation = await connector.getConversationDetail(uuid)
    linkChatReference(
      id,
      {
        conversation_uuid: uuid,
        conversation_title: conversation?.title ?? null,
        last_user_message: conversation?.last_user_message ?? null,
        chat_timestamp: conversation?.chat_timestamp ?? null,
        source: 'claude_desktop'
      },
      getDatabase()
    )
  })

  ipcMain.handle('chat:unlink', async (_event, workstreamId: unknown, conversationUuid: unknown) => {
    const id = ensureNumber(workstreamId, 'workstream id')
    const uuid = ensureString(conversationUuid, 'conversation uuid')
    unlinkChatReference(id, uuid, getDatabase())
  })

  ipcMain.handle('sync:get-or-create-source', async () => {
    return getOrCreateClaudeSyncSource(getDatabase())
  })

  ipcMain.handle('sync:update-source-path', async (_event, sourcePath: unknown) => {
    const path = ensureString(sourcePath, 'source path')
    return updateClaudeSourcePath(path, getDatabase())
  })

  ipcMain.handle('sync:diagnostics', async () => {
    const connector = makeConnectorFromSource()
    return connector.diagnostics()
  })

  ipcMain.handle('sync:run', async (_event, sourceId: unknown) => {
    const id = ensureNumber(sourceId, 'source id')
    const db = getDatabase()
    const source = getOrCreateClaudeSyncSource(db)

    if (source.id !== id) {
      throw new Error(`Unsupported source id: ${id}`)
    }

    const runId = createSyncRun(source.id, 'running', null, db)

    try {
      const connector = makeConnectorFromSource()
      const conversations = await connector.listConversations()
      completeSyncRun(
        runId,
        'success',
        JSON.stringify({ imported: conversations.length, completedAt: Date.now() }),
        db
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync failure'
      completeSyncRun(runId, 'failed', JSON.stringify({ error: message, completedAt: Date.now() }), db)
      throw error
    }
  })

  ipcMain.handle('sync:runs', async (_event, sourceId: unknown) => {
    const id = ensureNumber(sourceId, 'source id')
    return listSyncRuns(id, getDatabase())
  })

  ipcMain.handle('app:healthcheck', async () => {
    const db = getDatabase()
    return {
      ready: true,
      workstreams: calculateRankings(db).length,
      hasCurrentSource: Boolean(getOrCreateClaudeSyncSource(db))
    }
  })

  ipcMain.handle('workstreams:exists', async (_event, id: unknown) => {
    const workstreamId = ensureNumber(id, 'workstream id')
    return getWorkstream(getDatabase(), workstreamId) !== null
  })

  ipcMain.handle('app:open-obsidian-note', async (_event, noteRef: unknown) => {
    const target = ensureString(noteRef, 'note ref')
    const notePath = resolveObsidianNotePath(target)
    if (!notePath) {
      return { ok: false, error: `Could not find Obsidian note for [[${target}]]` }
    }

    const obsidianUrl = `obsidian://open?path=${encodeURIComponent(notePath)}`
    try {
      await shell.openExternal(obsidianUrl)
      return { ok: true, path: notePath }
    } catch {
      const fallbackError = await shell.openPath(notePath)
      if (fallbackError) {
        return { ok: false, error: fallbackError, path: notePath }
      }
      return { ok: true, path: notePath }
    }
  })
}
