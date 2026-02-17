import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { dialog, ipcMain, shell } from 'electron'

import type {
  ChatSessionCommandMode,
  ChatSessionViewMode,
  ContextDocInput,
  ContextDocSource,
  CreateWorkstreamInput,
  ResolveContextDocResult,
  SendChatMessageInput,
  SessionContextDoc,
  WorkstreamContextDoc,
  UpdateTaskInput,
  UpdateWorkstreamInput
} from '../shared/types'
import { ClaudeConnector } from './claude-connector'
import { cancelClaudeCliStream, runClaudeCliStream } from './claude-cli-runner'
import {
  buildContextBundle,
  computeContextFingerprint,
  resolveContextDocs,
  resolveObsidianReference
} from './context-service'
import { refreshNextActionFromChat } from './next-action-summarizer'
import {
  completeSyncRun,
  createSyncRun,
  createTask,
  createWorkstream,
  deleteTask,
  getDatabase,
  getChatSessionPreference,
  getSessionContextFingerprint,
  getWorkstreamChatSession,
  getOrCreateClaudeSyncSource,
  getWorkstream,
  linkChatReference,
  listWorkstreamContextDocuments,
  listSessionContextDocuments,
  listLinkedConversationUuids,
  listChatReferences,
  listProgress,
  listSyncRuns,
  listTasks,
  logProgress,
  unlinkChatReference,
  updateClaudeSourcePath,
  replaceWorkstreamContextDocuments,
  replaceSessionContextDocuments,
  setSessionContextFingerprint,
  setChatSessionPreference,
  setWorkstreamChatSession,
  updateTask,
  updateWorkstream
} from './database'
import { calculateRankings, calculateRankingsWithChat } from './ranking-engine'
import {
  getTerminalSessionState,
  isTerminalSessionActiveForConversation,
  resizeTerminal,
  sendTerminalInput,
  startTerminalSession,
  stopTerminalSession
} from './terminal-session-manager'

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

function normalizeWorkstreamRunDirectoryInput(
  rawValue: unknown,
  fieldName: string
): string | null | undefined {
  if (rawValue === undefined) {
    return undefined
  }

  if (rawValue === null) {
    return null
  }

  if (typeof rawValue !== 'string') {
    throw new Error(`${fieldName} must be a string, null, or undefined`)
  }

  const normalized = normalizePathInput(rawValue)
  if (!normalized) {
    return null
  }

  if (!isExistingDirectory(normalized)) {
    throw new Error(`${fieldName} must reference an existing directory`)
  }

  return normalized
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

function parsePickContextFileOptions(value: unknown): { defaultPath: string | null } {
  if (value === undefined || value === null) {
    return { defaultPath: null }
  }

  const payload = ensureObject(value, 'pick context file options')
  const defaultPathRaw = payload.defaultPath
  if (defaultPathRaw === undefined || defaultPathRaw === null) {
    return { defaultPath: null }
  }

  if (typeof defaultPathRaw !== 'string') {
    throw new Error('pick context file options.defaultPath must be a string, null, or undefined')
  }

  const normalized = normalizePathInput(defaultPathRaw)
  if (!normalized) {
    return { defaultPath: null }
  }

  if (isExistingDirectory(normalized)) {
    return { defaultPath: normalized }
  }

  try {
    const stat = fs.statSync(normalized)
    if (stat.isFile()) {
      const parent = path.dirname(normalized)
      return isExistingDirectory(parent) ? { defaultPath: parent } : { defaultPath: null }
    }
  } catch {
    return { defaultPath: null }
  }

  return { defaultPath: null }
}

const CLAUDE_PERMISSION_MODES = new Set(['acceptEdits', 'bypassPermissions', 'default', 'delegate', 'dontAsk', 'plan'])
const CHAT_SESSION_COMMAND_MODES: ReadonlySet<ChatSessionCommandMode> = new Set(['claude', 'cc'])
const CHAT_SESSION_VIEW_MODES: ReadonlySet<ChatSessionViewMode> = new Set(['chat', 'terminal'])
const CONTEXT_DOC_SOURCES: ReadonlySet<ContextDocSource> = new Set(['obsidian', 'file'])

function normalizeContextDocInput(entry: unknown, index: number): ContextDocInput {
  const record = ensureObject(entry, `context doc at index ${index}`)
  const source = ensureString(record.source, `context doc source at index ${index}`).trim() as ContextDocSource
  const reference = ensureString(record.reference, `context doc reference at index ${index}`).trim()

  if (!CONTEXT_DOC_SOURCES.has(source)) {
    throw new Error(`context doc source at index ${index} must be one of: obsidian, file`)
  }

  if (!reference) {
    throw new Error(`context doc reference at index ${index} must not be empty`)
  }

  return {
    source,
    reference
  }
}

function parseContextDocsInput(value: unknown): ContextDocInput[] {
  if (value === undefined || value === null) {
    return []
  }

  if (!Array.isArray(value)) {
    throw new Error('context_docs must be an array when provided')
  }

  return value.map((entry, index) => normalizeContextDocInput(entry, index))
}

function inferContextStatus(result: ResolveContextDocResult): SessionContextDoc['status'] {
  if (result.exists) {
    return 'ok'
  }

  const warning = (result.warning ?? '').toLowerCase()
  if (warning.includes('invalid') || warning.includes('empty')) {
    return 'invalid'
  }

  return 'missing'
}

function toContextDocInputs(rows: Array<{ source: ContextDocSource; reference: string }>): ContextDocInput[] {
  return rows.map((row) => ({
    source: row.source,
    reference: row.reference
  }))
}

function enrichSessionContextDocs(rows: Awaited<ReturnType<typeof listSessionContextDocuments>>): SessionContextDoc[] {
  if (rows.length === 0) {
    return []
  }

  const docInputs = toContextDocInputs(rows)
  const resolved = resolveContextDocs(docInputs)
  const bundle = buildContextBundle(docInputs)
  const resolvedByKey = new Map(resolved.map((entry) => [entry.normalized_reference, entry]))
  const metadataByKey = new Map(bundle.metadata.map((entry) => [entry.normalized_reference, entry]))

  return rows.map((row) => {
    const resolvedEntry = resolvedByKey.get(row.normalized_reference)
    const metadataEntry = metadataByKey.get(row.normalized_reference)
    return {
      id: row.id,
      workstream_id: row.workstream_id,
      conversation_uuid: row.conversation_uuid,
      source: row.source,
      reference: row.reference,
      normalized_reference: row.normalized_reference,
      resolved_path: resolvedEntry?.resolved_path ?? null,
      status: resolvedEntry ? inferContextStatus(resolvedEntry) : 'invalid',
      char_count: metadataEntry?.char_count ?? null,
      updated_at: row.updated_at
    }
  })
}

function enrichWorkstreamContextDocs(rows: Awaited<ReturnType<typeof listWorkstreamContextDocuments>>): WorkstreamContextDoc[] {
  if (rows.length === 0) {
    return []
  }

  const docInputs = toContextDocInputs(rows)
  const resolved = resolveContextDocs(docInputs)
  const bundle = buildContextBundle(docInputs)
  const resolvedByKey = new Map(resolved.map((entry) => [entry.normalized_reference, entry]))
  const metadataByKey = new Map(bundle.metadata.map((entry) => [entry.normalized_reference, entry]))

  return rows.map((row) => {
    const resolvedEntry = resolvedByKey.get(row.normalized_reference)
    const metadataEntry = metadataByKey.get(row.normalized_reference)
    return {
      id: row.id,
      workstream_id: row.workstream_id,
      source: row.source,
      reference: row.reference,
      normalized_reference: row.normalized_reference,
      resolved_path: resolvedEntry?.resolved_path ?? null,
      status: resolvedEntry ? inferContextStatus(resolvedEntry) : 'invalid',
      char_count: metadataEntry?.char_count ?? null,
      updated_at: row.updated_at
    }
  })
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
  const permissionModeRaw =
    payload.permission_mode === undefined || payload.permission_mode === null
      ? null
      : ensureString(payload.permission_mode, 'permission_mode').trim() || null
  const dangerouslySkipPermissionsRaw = payload.dangerously_skip_permissions
  if (
    dangerouslySkipPermissionsRaw !== undefined &&
    dangerouslySkipPermissionsRaw !== null &&
    typeof dangerouslySkipPermissionsRaw !== 'boolean'
  ) {
    throw new Error('dangerously_skip_permissions must be a boolean')
  }

  const dangerouslySkipPermissions =
    dangerouslySkipPermissionsRaw === undefined || dangerouslySkipPermissionsRaw === null
      ? false
      : dangerouslySkipPermissionsRaw
  const contextDocsProvided = Object.prototype.hasOwnProperty.call(payload, 'context_docs')
  const contextDocs = contextDocsProvided ? parseContextDocsInput(payload.context_docs) : undefined

  if (permissionModeRaw && !CLAUDE_PERMISSION_MODES.has(permissionModeRaw)) {
    throw new Error(
      `permission_mode must be one of: ${Array.from(CLAUDE_PERMISSION_MODES)
        .sort()
        .join(', ')}`
    )
  }

  return {
    workstream_id: workstreamId,
    message,
    cwd,
    resume_session_id: resumeSessionId,
    allow_workstream_session_fallback: allowWorkstreamSessionFallback,
    model,
    permission_mode: permissionModeRaw as SendChatMessageInput['permission_mode'],
    dangerously_skip_permissions: dangerouslySkipPermissions,
    context_docs: contextDocs
  }
}

function parseSessionPreferencePatch(data: unknown): {
  command_mode?: ChatSessionCommandMode
  view_mode?: ChatSessionViewMode
} {
  const payload = ensureObject(data, 'session preference patch')
  const commandModeRaw =
    payload.command_mode === undefined || payload.command_mode === null
      ? undefined
      : ensureString(payload.command_mode, 'command_mode').trim()
  const viewModeRaw =
    payload.view_mode === undefined || payload.view_mode === null
      ? undefined
      : ensureString(payload.view_mode, 'view_mode').trim()

  if (commandModeRaw !== undefined && !CHAT_SESSION_COMMAND_MODES.has(commandModeRaw as ChatSessionCommandMode)) {
    throw new Error('command_mode must be one of: claude, cc')
  }

  if (viewModeRaw !== undefined && !CHAT_SESSION_VIEW_MODES.has(viewModeRaw as ChatSessionViewMode)) {
    throw new Error('view_mode must be one of: chat, terminal')
  }

  return {
    command_mode: commandModeRaw as ChatSessionCommandMode | undefined,
    view_mode: viewModeRaw as ChatSessionViewMode | undefined
  }
}

function parseStartTerminalSessionInput(
  data: unknown
): {
  workstream_id: number
  conversation_uuid: string | null
  cwd: string | null
  command_mode: ChatSessionCommandMode | null
} {
  const payload = ensureObject(data, 'terminal session payload')
  const workstreamId = ensureNumber(payload.workstream_id, 'workstream id')
  const conversationUuid =
    payload.conversation_uuid === undefined || payload.conversation_uuid === null
      ? null
      : ensureString(payload.conversation_uuid, 'conversation_uuid').trim() || null
  const cwd = payload.cwd === undefined || payload.cwd === null ? null : ensureString(payload.cwd, 'cwd').trim() || null
  const commandModeRaw =
    payload.command_mode === undefined || payload.command_mode === null
      ? null
      : ensureString(payload.command_mode, 'command_mode').trim() || null

  if (commandModeRaw && !CHAT_SESSION_COMMAND_MODES.has(commandModeRaw as ChatSessionCommandMode)) {
    throw new Error('command_mode must be one of: claude, cc')
  }

  return {
    workstream_id: workstreamId,
    conversation_uuid: conversationUuid,
    cwd,
    command_mode: commandModeRaw as ChatSessionCommandMode | null
  }
}

const MAX_CONVERSATION_TITLE_LENGTH = 80
const DEFAULT_TOPIC_TITLE = 'New topic'

function normalizeConversationTitle(rawTitle: string | null | undefined): string | null {
  if (!rawTitle) {
    return null
  }

  const compacted = rawTitle.replace(/\s+/g, ' ').trim()
  if (!compacted) {
    return null
  }

  if (compacted.toLowerCase() === 'no prompt') {
    return null
  }

  return compacted.length > MAX_CONVERSATION_TITLE_LENGTH
    ? `${compacted.slice(0, MAX_CONVERSATION_TITLE_LENGTH)}...`
    : compacted
}

function deriveTopicTitleFromMessage(message: string): string | null {
  const compacted = message.replace(/\s+/g, ' ').trim()
  if (!compacted) {
    return null
  }

  const sentenceBoundary = compacted.search(/[.?!](?:\s|$)/)
  const sentence = sentenceBoundary > 0 ? compacted.slice(0, sentenceBoundary) : compacted
  const cleaned = sentence.replace(/^["'`([{]+|["'`)\]}]+$/g, '').trim()
  if (!cleaned) {
    return null
  }

  return cleaned.length > MAX_CONVERSATION_TITLE_LENGTH
    ? `${cleaned.slice(0, MAX_CONVERSATION_TITLE_LENGTH)}...`
    : cleaned
}

function areTitlesEqual(left: string | null, right: string | null): boolean {
  if (!left || !right) {
    return false
  }

  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

function makeConnectorFromSource(): ClaudeConnector {
  const db = getDatabase()
  const source = getOrCreateClaudeSyncSource(db)
  const configuredPath = parseClaudePathFromSourceConfig(source.config)
  return new ClaudeConnector(configuredPath ?? undefined)
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
    const normalizedRunDirectory = normalizeWorkstreamRunDirectoryInput(payload.chat_run_directory, 'chat_run_directory')
    if (normalizedRunDirectory !== undefined) {
      payload.chat_run_directory = normalizedRunDirectory
    }
    return createWorkstream(payload, getDatabase())
  })

  ipcMain.handle('workstreams:update', async (_event, id: unknown, data: unknown) => {
    const workstreamId = ensureNumber(id, 'workstream id')
    const payload = data as UpdateWorkstreamInput
    const normalizedRunDirectory = normalizeWorkstreamRunDirectoryInput(payload.chat_run_directory, 'chat_run_directory')
    if (normalizedRunDirectory !== undefined) {
      payload.chat_run_directory = normalizedRunDirectory
    }
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

  ipcMain.handle('chat:get-workstream-context', async (_event, workstreamId: unknown) => {
    const id = ensureNumber(workstreamId, 'workstream id')
    const rows = listWorkstreamContextDocuments(id, getDatabase())
    return enrichWorkstreamContextDocs(rows)
  })

  ipcMain.handle('chat:set-workstream-context', async (_event, workstreamId: unknown, docs: unknown) => {
    const id = ensureNumber(workstreamId, 'workstream id')
    const payloadDocs = parseContextDocsInput(docs)
    const rows = replaceWorkstreamContextDocuments(id, payloadDocs, getDatabase())
    return enrichWorkstreamContextDocs(rows)
  })

  ipcMain.handle('chat:get-session-context', async (_event, workstreamId: unknown, conversationUuid: unknown) => {
    const id = ensureNumber(workstreamId, 'workstream id')
    const uuid = ensureString(conversationUuid, 'conversation uuid').trim()
    if (!uuid) {
      throw new Error('conversation uuid must not be empty')
    }

    const rows = listSessionContextDocuments(id, uuid, getDatabase())
    return enrichSessionContextDocs(rows)
  })

  ipcMain.handle('chat:set-session-context', async (_event, workstreamId: unknown, conversationUuid: unknown, docs: unknown) => {
    const id = ensureNumber(workstreamId, 'workstream id')
    const uuid = ensureString(conversationUuid, 'conversation uuid').trim()
    if (!uuid) {
      throw new Error('conversation uuid must not be empty')
    }

    const payloadDocs = parseContextDocsInput(docs)
    const rows = replaceSessionContextDocuments(id, uuid, payloadDocs, getDatabase())
    return enrichSessionContextDocs(rows)
  })

  ipcMain.handle('chat:get-session-preference', async (_event, conversationUuid: unknown) => {
    const uuid = ensureString(conversationUuid, 'conversation uuid').trim()
    if (!uuid) {
      throw new Error('conversation uuid must not be empty')
    }

    return getChatSessionPreference(uuid, getDatabase())
  })

  ipcMain.handle('chat:set-session-preference', async (_event, conversationUuid: unknown, patch: unknown) => {
    const uuid = ensureString(conversationUuid, 'conversation uuid').trim()
    if (!uuid) {
      throw new Error('conversation uuid must not be empty')
    }

    const parsedPatch = parseSessionPreferencePatch(patch)
    if (parsedPatch.command_mode === undefined && parsedPatch.view_mode === undefined) {
      throw new Error('session preference patch must include command_mode or view_mode')
    }

    return setChatSessionPreference(uuid, parsedPatch, getDatabase())
  })

  ipcMain.handle('chat:start-terminal-session', async (_event, data: unknown) => {
    const payload = parseStartTerminalSessionInput(data)
    const db = getDatabase()
    const workstream = getWorkstream(db, payload.workstream_id)
    if (!workstream) {
      throw new Error(`Workstream ${payload.workstream_id} not found`)
    }

    const currentSession = getWorkstreamChatSession(payload.workstream_id, db)
    const resolvedConversationUuid = payload.conversation_uuid ?? null
    const persistedPreference = resolvedConversationUuid ? getChatSessionPreference(resolvedConversationUuid, db) : null
    const commandMode = payload.command_mode ?? persistedPreference?.command_mode ?? 'claude'
    const cwd = resolveChatCwd(
      payload.cwd ?? null,
      workstream.chat_run_directory,
      currentSession?.project_cwd ?? null,
      process.cwd(),
      os.homedir()
    )

    const state = startTerminalSession({
      workstreamId: payload.workstream_id,
      conversationUuid: resolvedConversationUuid,
      cwd,
      commandMode
    })

    if (state.conversation_uuid) {
      setChatSessionPreference(
        state.conversation_uuid,
        {
          command_mode: commandMode
        },
        db
      )
    }

    return state
  })

  ipcMain.handle('chat:stop-terminal-session', async () => {
    return stopTerminalSession()
  })

  ipcMain.handle('chat:send-terminal-input', async (_event, data: unknown) => {
    const value = ensureString(data, 'terminal input')
    sendTerminalInput(value)
  })

  ipcMain.handle('chat:resize-terminal', async (_event, cols: unknown, rows: unknown) => {
    const parsedCols = ensureNumber(cols, 'terminal cols')
    const parsedRows = ensureNumber(rows, 'terminal rows')
    resizeTerminal(parsedCols, parsedRows)
  })

  ipcMain.handle('chat:get-terminal-session-state', async () => {
    return getTerminalSessionState()
  })

  ipcMain.handle('chat:resolve-context-docs', async (_event, docs: unknown) => {
    const payloadDocs = parseContextDocsInput(docs)
    return resolveContextDocs(payloadDocs)
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
      workstream.chat_run_directory,
      currentSession?.project_cwd ?? null,
      process.cwd(),
      os.homedir()
    )
    const resumeSessionId =
      payload.resume_session_id ??
      (payload.allow_workstream_session_fallback === false ? null : (currentSession?.session_id ?? null))

    if (resumeSessionId && isTerminalSessionActiveForConversation(resumeSessionId)) {
      throw new Error('Terminal session is active; use terminal input or stop terminal before sending chat messages.')
    }

    const workstreamContextRows = listWorkstreamContextDocuments(payload.workstream_id, db)
    const workstreamContextDocs = toContextDocInputs(workstreamContextRows)
    const persistedContextRows = resumeSessionId ? listSessionContextDocuments(payload.workstream_id, resumeSessionId, db) : []
    const persistedContextDocs = toContextDocInputs(persistedContextRows)
    const contextDocs =
      payload.context_docs !== undefined && payload.context_docs !== null
        ? payload.context_docs
        : persistedContextDocs.length > 0
          ? persistedContextDocs
          : workstreamContextDocs
    const contextBundle = buildContextBundle(contextDocs)
    const contextFingerprint = computeContextFingerprint(contextBundle.metadata)
    const previousFingerprint = resumeSessionId ? getSessionContextFingerprint(resumeSessionId, db) : null
    const shouldInjectContext =
      Boolean(contextBundle.text) && (resumeSessionId === null || previousFingerprint === null || previousFingerprint !== contextFingerprint)
    const message = shouldInjectContext && contextBundle.text ? `${contextBundle.text}\n\n${payload.message}` : payload.message

    const result = await runClaudeCliStream(event, {
      message,
      cwd,
      resume_session_id: resumeSessionId,
      model: payload.model ?? null,
      permission_mode: payload.permission_mode ?? null,
      dangerously_skip_permissions: payload.dangerously_skip_permissions ?? false
    })

    const sessionId = result.session_id ?? resumeSessionId
    if (sessionId) {
      setWorkstreamChatSession(payload.workstream_id, sessionId, cwd, db)
      replaceSessionContextDocuments(payload.workstream_id, sessionId, contextDocs, db)
      setSessionContextFingerprint(payload.workstream_id, sessionId, contextFingerprint, db)

      const existingReference =
        listChatReferences(payload.workstream_id, db).find((chat) => chat.conversation_uuid === sessionId) ?? null
      const existingTitle = normalizeConversationTitle(existingReference?.conversation_title ?? null)
      const workstreamNameTitle = normalizeConversationTitle(workstream.name)
      const preferredExistingTitle = areTitlesEqual(existingTitle, workstreamNameTitle) ? null : existingTitle

      const connector = makeConnectorFromSource()
      const conversation = await connector.getConversationDetail(sessionId).catch(() => null)
      const connectorTitle = normalizeConversationTitle(conversation?.title ?? null)
      const messageTopicTitle = deriveTopicTitleFromMessage(payload.message)
      const resolvedConversationTitle = connectorTitle ?? preferredExistingTitle ?? messageTopicTitle ?? DEFAULT_TOPIC_TITLE

      linkChatReference(
        payload.workstream_id,
        {
          conversation_uuid: sessionId,
          conversation_title: resolvedConversationTitle,
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
    const notePath = resolveObsidianReference(target)
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

  ipcMain.handle('app:pick-context-file', async (_event, options: unknown) => {
    const parsed = parsePickContextFileOptions(options)
    const result = await dialog.showOpenDialog({
      title: 'Select context file',
      properties: ['openFile'],
      defaultPath: parsed.defaultPath ?? undefined
    })

    if (result.canceled || result.filePaths.length === 0) {
      return {
        canceled: true,
        path: null
      }
    }

    return {
      canceled: false,
      path: result.filePaths[0]
    }
  })
}
