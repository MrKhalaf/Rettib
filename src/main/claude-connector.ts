import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ClaudeConversation, ClaudeConversationPreviewMessage, SyncDiagnostics } from '../shared/types'

interface SessionIndexEntry {
  sessionId: string
  fullPath: string | null
  fileMtime: number | null
  firstPrompt: string | null
  summary: string | null
  modified: number | null
}

function defaultClaudeProjectsPath(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 10_000_000_000) {
      return Math.floor(value)
    }

    return Math.floor(value * 1000)
  }

  if (typeof value === 'string') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) {
      return toTimestampMs(asNumber)
    }

    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }

  return null
}

function listSessionsIndexFiles(rootPath: string): string[] {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return []
  }

  const stat = fs.statSync(rootPath)
  if (stat.isFile()) {
    return path.basename(rootPath) === 'sessions-index.json' ? [rootPath] : []
  }

  const indexFiles: string[] = []
  const queue: string[] = [rootPath]

  while (queue.length > 0) {
    const current = queue.pop() as string
    let entries: fs.Dirent[]

    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const resolved = path.join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(resolved)
      } else if (entry.isFile() && entry.name === 'sessions-index.json') {
        indexFiles.push(resolved)
      }
    }
  }

  return indexFiles
}

function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') {
    const text = content.trim()
    if (!text) {
      return null
    }

    if (text.includes('<local-command-caveat>') || text.includes('<command-name>/exit</command-name>')) {
      return null
    }

    return text.slice(0, 300)
  }

  if (!Array.isArray(content)) {
    return null
  }

  const parts: string[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      const value = item.trim()
      if (value) {
        parts.push(value)
      }
      continue
    }

    if (!isRecord(item)) {
      continue
    }

    if (item.type === 'text' && typeof item.text === 'string') {
      const value = item.text.trim()
      if (value) {
        parts.push(value)
      }
      continue
    }

    if (typeof item.content === 'string') {
      const value = item.content.trim()
      if (value) {
        parts.push(value)
      }
    }
  }

  if (parts.length === 0) {
    return null
  }

  const joined = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (!joined) {
    return null
  }

  return joined.slice(0, 300)
}

function extractLastUserMessageFromSessionFile(filePath: string): string | null {
  if (!filePath || !fs.existsSync(filePath)) {
    return null
  }

  let contents: string
  try {
    contents = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }

  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let parsed: unknown

    try {
      parsed = JSON.parse(lines[i])
    } catch {
      continue
    }

    if (!isRecord(parsed) || parsed.type !== 'user' || parsed.isMeta === true) {
      continue
    }

    const message = parsed.message
    if (!isRecord(message) || message.role !== 'user') {
      continue
    }

    const extracted = extractUserText(message.content)
    if (extracted) {
      return extracted
    }
  }

  return null
}

function extractConversationMessagesFromSessionFile(filePath: string): ClaudeConversationPreviewMessage[] {
  if (!filePath || !fs.existsSync(filePath)) {
    return []
  }

  let contents: string
  try {
    contents = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }

  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const messages: ClaudeConversationPreviewMessage[] = []
  for (const line of lines) {
    let parsed: unknown

    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    if (!isRecord(parsed) || parsed.isMeta === true) {
      continue
    }

    const rawType = toNonEmptyString(parsed.type)
    const message = isRecord(parsed.message) ? parsed.message : null
    const rawRole = toNonEmptyString(message?.role) ?? rawType
    if (rawRole !== 'user' && rawRole !== 'assistant') {
      continue
    }

    const content = message?.content ?? parsed.content ?? parsed.text
    const text = extractUserText(content)
    if (!text) {
      continue
    }

    const timestamp = toTimestampMs(parsed.timestamp ?? parsed.created_at ?? message?.timestamp ?? message?.created_at)
    messages.push({
      role: rawRole,
      text,
      timestamp
    })
  }

  return messages
}

function parseSessionEntries(indexPath: string): SessionIndexEntry[] {
  let fileContents: string

  try {
    fileContents = fs.readFileSync(indexPath, 'utf8')
  } catch {
    return []
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(fileContents)
  } catch {
    return []
  }

  if (!isRecord(parsedJson) || !Array.isArray(parsedJson.entries)) {
    return []
  }

  const rows: SessionIndexEntry[] = []
  for (const rawEntry of parsedJson.entries) {
    if (!isRecord(rawEntry)) {
      continue
    }

    const sessionId = toNonEmptyString(rawEntry.sessionId)
    if (!sessionId) {
      continue
    }

    rows.push({
      sessionId,
      fullPath: toNonEmptyString(rawEntry.fullPath),
      fileMtime: toTimestampMs(rawEntry.fileMtime),
      firstPrompt: toNonEmptyString(rawEntry.firstPrompt),
      summary: toNonEmptyString(rawEntry.summary),
      modified: toTimestampMs(rawEntry.modified)
    })
  }

  return rows
}

function isGenericSessionSummary(summary: string | null): boolean {
  if (!summary) {
    return true
  }

  const normalized = summary.toLowerCase()
  return normalized.includes('user exited') || normalized === 'session'
}

function selectConversationTitle(entry: SessionIndexEntry): string {
  if (!isGenericSessionSummary(entry.summary)) {
    return entry.summary as string
  }

  const firstPrompt = entry.firstPrompt
  if (firstPrompt && firstPrompt.toLowerCase() !== 'no prompt') {
    return firstPrompt.length > 80 ? `${firstPrompt.slice(0, 80)}...` : firstPrompt
  }

  return entry.sessionId
}

export class ClaudeConnector {
  private readonly projectsPath: string

  constructor(projectsPath = defaultClaudeProjectsPath()) {
    this.projectsPath = projectsPath
  }

  diagnostics(): SyncDiagnostics {
    try {
      const exists = fs.existsSync(this.projectsPath)
      if (!exists) {
        return {
          exists: false,
          path: this.projectsPath,
          error: 'Path does not exist'
        }
      }

      const indexFiles = listSessionsIndexFiles(this.projectsPath)
      if (indexFiles.length === 0) {
        return {
          exists: false,
          path: this.projectsPath,
          error: 'No sessions-index.json files found'
        }
      }

      return {
        exists: true,
        path: this.projectsPath
      }
    } catch (error) {
      return {
        exists: false,
        path: this.projectsPath,
        error: error instanceof Error ? error.message : 'Unknown filesystem error'
      }
    }
  }

  async listConversations(): Promise<ClaudeConversation[]> {
    const diagnostics = this.diagnostics()
    if (!diagnostics.exists) {
      return []
    }

    const entriesBySession = new Map<string, SessionIndexEntry>()
    const indexFiles = listSessionsIndexFiles(this.projectsPath)

    for (const indexFile of indexFiles) {
      const entries = parseSessionEntries(indexFile)
      for (const entry of entries) {
        const existing = entriesBySession.get(entry.sessionId)
        const entryTimestamp = entry.modified ?? entry.fileMtime ?? 0
        const existingTimestamp = existing?.modified ?? existing?.fileMtime ?? 0

        if (!existing || entryTimestamp >= existingTimestamp) {
          entriesBySession.set(entry.sessionId, entry)
        }
      }
    }

    const conversations: ClaudeConversation[] = []
    for (const entry of entriesBySession.values()) {
      const timestamp = entry.modified ?? entry.fileMtime ?? null
      const lastMessage = extractLastUserMessageFromSessionFile(entry.fullPath ?? '')
      const fallbackPrompt = entry.firstPrompt?.toLowerCase() === 'no prompt' ? null : entry.firstPrompt

      conversations.push({
        conversation_uuid: entry.sessionId,
        title: selectConversationTitle(entry),
        chat_timestamp: timestamp,
        last_user_message: lastMessage ?? fallbackPrompt
      })
    }

    conversations.sort((a, b) => (b.chat_timestamp ?? 0) - (a.chat_timestamp ?? 0))
    return conversations
  }

  async getConversationDetail(uuid: string): Promise<ClaudeConversation | null> {
    const conversations = await this.listConversations()
    return conversations.find((conversation) => conversation.conversation_uuid === uuid) ?? null
  }

  async getConversationPreview(uuid: string, limit = 4): Promise<ClaudeConversationPreviewMessage[]> {
    const trimmedUuid = uuid.trim()
    if (!trimmedUuid) {
      return []
    }

    const diagnostics = this.diagnostics()
    if (!diagnostics.exists) {
      return []
    }

    const entriesBySession = new Map<string, SessionIndexEntry>()
    const indexFiles = listSessionsIndexFiles(this.projectsPath)

    for (const indexFile of indexFiles) {
      const entries = parseSessionEntries(indexFile)
      for (const entry of entries) {
        const existing = entriesBySession.get(entry.sessionId)
        const entryTimestamp = entry.modified ?? entry.fileMtime ?? 0
        const existingTimestamp = existing?.modified ?? existing?.fileMtime ?? 0

        if (!existing || entryTimestamp >= existingTimestamp) {
          entriesBySession.set(entry.sessionId, entry)
        }
      }
    }

    const target = entriesBySession.get(trimmedUuid)
    if (!target?.fullPath) {
      return []
    }

    const allMessages = extractConversationMessagesFromSessionFile(target.fullPath)
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 4
    return allMessages.slice(-safeLimit)
  }
}
