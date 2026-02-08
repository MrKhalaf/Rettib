import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ipcMain, shell } from 'electron'

import type { CreateWorkstreamInput, SendChatMessageInput, UpdateTaskInput, UpdateWorkstreamInput } from '../shared/types'
import { ClaudeConnector } from './claude-connector'
import { cancelClaudeCliStream, runClaudeCliStream } from './claude-cli-runner'
import { refreshNextActionFromChat } from './next-action-summarizer'
import {
  completeSyncRun,
  createSyncRun,
  createTask,
  createWorkstream,
  deleteTask,
  getDatabase,
  getWorkstreamChatSession,
  getOrCreateClaudeSyncSource,
  getWorkstream,
  linkChatReference,
  listLinkedConversationUuids,
  listChatReferences,
  listProgress,
  listSyncRuns,
  listTasks,
  logProgress,
  unlinkChatReference,
  updateClaudeSourcePath,
  setWorkstreamChatSession,
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

function ensureObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }

  return value as Record<string, unknown>
}

function parseClaudePathFromSourceConfig(config: string): string | null {
  try {
    const parsed = JSON.parse(config) as { path?: unknown }
    return typeof parsed.path === 'string' ? parsed.path : null
  } catch {
    return null
  }
}

function parseRepoPathFromNotes(notes: string | null): string | null {
  if (!notes) {
    return null
  }

  const repoLine = notes
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^repo:/i.test(line))

  if (!repoLine) {
    return null
  }

  const rawPath = repoLine.replace(/^repo:/i, '').trim()
  if (!rawPath) {
    return null
  }

  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2))
  }

  return rawPath
}

function normalizePathInput(input: string | null | undefined): string | null {
  if (!input) {
    return null
  }

  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2))
  }

  return path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed)
}

function isExistingDirectory(input: string | null | undefined): input is string {
  if (!input) {
    return false
  }

  try {
    return fs.statSync(input).isDirectory()
  } catch {
    return false
  }
}

function resolveChatCwd(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const normalized = normalizePathInput(candidate)
    if (isExistingDirectory(normalized)) {
      return normalized
    }
  }

  return os.homedir()
}

function parseSendChatMessageInput(data: unknown): SendChatMessageInput {
  const payload = ensureObject(data, 'chat payload')
  const workstreamId = ensureNumber(payload.workstream_id, 'workstream id')
  const message = ensureString(payload.message, 'message').trim()
  if (!message) {
    throw new Error('message must not be empty')
  }

  const cwd = payload.cwd === undefined || payload.cwd === null ? null : ensureString(payload.cwd, 'cwd').trim() || null
  const resumeSessionId =
    payload.resume_session_id === undefined || payload.resume_session_id === null
      ? null
      : ensureString(payload.resume_session_id, 'resume_session_id').trim() || null
  const allowWorkstreamSessionFallbackRaw = payload.allow_workstream_session_fallback
  if (
    allowWorkstreamSessionFallbackRaw !== undefined &&
    allowWorkstreamSessionFallbackRaw !== null &&
    typeof allowWorkstreamSessionFallbackRaw !== 'boolean'
  ) {
    throw new Error('allow_workstream_session_fallback must be a boolean')
  }

  const allowWorkstreamSessionFallback =
    allowWorkstreamSessionFallbackRaw === undefined || allowWorkstreamSessionFallbackRaw === null
      ? true
      : allowWorkstreamSessionFallbackRaw
  const model = payload.model === undefined || payload.model === null ? null : ensureString(payload.model, 'model').trim() || null

  return {
    workstream_id: workstreamId,
    message,
    cwd,
    resume_session_id: resumeSessionId,
    allow_workstream_session_fallback: allowWorkstreamSessionFallback,
    model
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

  ipcMain.handle('chat:list-linked-conversation-uuids', async () => {
    return listLinkedConversationUuids(getDatabase())
  })

  ipcMain.handle('chat:get-conversation-preview', async (_event, conversationUuid: unknown, limit: unknown) => {
    const uuid = ensureString(conversationUuid, 'conversation uuid')
    const parsedLimit =
      typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 4
    const connector = makeConnectorFromSource()
    return connector.getConversationPreview(uuid, parsedLimit)
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
        source: 'claude_cli'
      },
      getDatabase()
    )
  })

  ipcMain.handle('chat:unlink', async (_event, workstreamId: unknown, conversationUuid: unknown) => {
    const id = ensureNumber(workstreamId, 'workstream id')
    const uuid = ensureString(conversationUuid, 'conversation uuid')
    unlinkChatReference(id, uuid, getDatabase())
  })

  ipcMain.handle('chat:get-workstream-session', async (_event, workstreamId: unknown) => {
    const id = ensureNumber(workstreamId, 'workstream id')
    return getWorkstreamChatSession(id, getDatabase())
  })

  ipcMain.handle('chat:send-message', async (event, data: unknown) => {
    const payload = parseSendChatMessageInput(data)
    const db = getDatabase()
    const workstream = getWorkstream(db, payload.workstream_id)

    if (!workstream) {
      throw new Error(`Workstream ${payload.workstream_id} not found`)
    }

    const currentSession = getWorkstreamChatSession(payload.workstream_id, db)
    const cwd = resolveChatCwd(
      payload.cwd ?? null,
      currentSession?.project_cwd ?? null,
      parseRepoPathFromNotes(workstream.notes),
      process.cwd(),
      os.homedir()
    )
    const resumeSessionId =
      payload.resume_session_id ??
      (payload.allow_workstream_session_fallback === false ? null : (currentSession?.session_id ?? null))

    const result = await runClaudeCliStream(event, {
      message: payload.message,
      cwd,
      resume_session_id: resumeSessionId,
      model: payload.model ?? null
    })

    const sessionId = result.session_id ?? resumeSessionId
    if (sessionId) {
      setWorkstreamChatSession(payload.workstream_id, sessionId, cwd, db)
      linkChatReference(
        payload.workstream_id,
        {
          conversation_uuid: sessionId,
          conversation_title: workstream.name,
          last_user_message: payload.message,
          chat_timestamp: Date.now(),
          source: 'claude_cli'
        },
        db
      )
    }

    if (!result.is_error) {
      const assistantText = (result.assistant_text || result.result_text || '').trim()
      if (assistantText) {
        const latestWorkstream = getWorkstream(db, payload.workstream_id) ?? workstream
        await refreshNextActionFromChat({
          workstream: latestWorkstream,
          userMessage: payload.message,
          assistantMessage: assistantText
        })
      }
    }

    return result
  })

  ipcMain.handle('chat:cancel-stream', async (_event, streamId: unknown) => {
    const id = ensureString(streamId, 'stream id')
    cancelClaudeCliStream(id)
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
