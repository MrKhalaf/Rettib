import fs from 'node:fs'
import path from 'node:path'

import { Level } from 'level'

import type { ClaudeConversation, SyncDiagnostics } from '../shared/types'

interface ConversationAccumulator {
  conversation_uuid: string
  title: string | null
  chat_timestamp: number | null
  last_user_message: string | null
}

function defaultClaudeLevelDbPath(): string {
  return path.join(process.env.HOME ?? '', 'Library/Application Support/Claude/Local Storage/leveldb')
}

function maybeParseJson(value: string): unknown {
  if (!value) {
    return null
  }

  const first = value.trim()[0]
  if (first !== '{' && first !== '[' && first !== '"') {
    return value
  }

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function isLikelyUuid(value: string): boolean {
  return /^[A-Za-z0-9-]{8,}$/.test(value)
}

function parseConversationKey(key: string): { conversationUuid: string; property: string } | null {
  const parts = key.split(':')
  const conversationIndex = parts.findIndex((part) => part === 'conversation')

  if (conversationIndex === -1) {
    return null
  }

  const conversationUuid = parts[conversationIndex + 1]
  if (!conversationUuid || !isLikelyUuid(conversationUuid)) {
    return null
  }

  const property = parts.slice(conversationIndex + 2).join(':') || 'payload'
  return { conversationUuid, property }
}

function extractTimestampFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000)
  }

  if (typeof value === 'string') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) {
      return extractTimestampFromUnknown(asNumber)
    }

    const dateMs = Date.parse(value)
    return Number.isNaN(dateMs) ? null : dateMs
  }

  if (!value || typeof value !== 'object') {
    return null
  }

  const candidateKeys = ['timestamp', 'updatedAt', 'updated_at', 'createdAt', 'created_at', 'lastUpdated']
  for (const key of candidateKeys) {
    if (key in value) {
      const parsed = extractTimestampFromUnknown((value as Record<string, unknown>)[key])
      if (parsed) {
        return parsed
      }
    }
  }

  return null
}

function extractTitleFromUnknown(value: unknown): string | null {
  if (!value) {
    return null
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (typeof value !== 'object') {
    return null
  }

  const candidateKeys = ['title', 'name', 'conversationTitle']
  for (const key of candidateKeys) {
    const candidate = (value as Record<string, unknown>)[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }

  return null
}

function flattenRichText(node: unknown, output: string[]): void {
  if (!node) {
    return
  }

  if (typeof node === 'string') {
    if (node.trim()) {
      output.push(node.trim())
    }
    return
  }

  if (typeof node !== 'object') {
    return
  }

  if ('text' in node && typeof (node as { text: unknown }).text === 'string') {
    const text = (node as { text: string }).text.trim()
    if (text) {
      output.push(text)
    }
  }

  if (Array.isArray((node as { content?: unknown[] }).content)) {
    for (const child of (node as { content: unknown[] }).content) {
      flattenRichText(child, output)
    }
  }

  if (Array.isArray((node as { children?: unknown[] }).children)) {
    for (const child of (node as { children: unknown[] }).children) {
      flattenRichText(child, output)
    }
  }
}

function extractLastUserMessageFromUnknown(value: unknown): string | null {
  if (!value) {
    return null
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed.slice(0, 300) : null
  }

  if (typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>

  if (Array.isArray(record.messages)) {
    for (let i = record.messages.length - 1; i >= 0; i -= 1) {
      const message = record.messages[i] as Record<string, unknown>
      const role = String(message.role ?? message.sender ?? '')
      if (role.toLowerCase() !== 'user') {
        continue
      }

      const text =
        extractLastUserMessageFromUnknown(message.text) ??
        extractLastUserMessageFromUnknown(message.content) ??
        extractLastUserMessageFromUnknown(message.body)

      if (text) {
        return text
      }
    }
  }

  if (record.editorState && typeof record.editorState === 'object') {
    const pieces: string[] = []
    flattenRichText(record.editorState, pieces)
    if (pieces.length > 0) {
      return pieces.join(' ').slice(0, 300)
    }
  }

  if (record.content && typeof record.content === 'object') {
    const pieces: string[] = []
    flattenRichText(record.content, pieces)
    if (pieces.length > 0) {
      return pieces.join(' ').slice(0, 300)
    }
  }

  return null
}

export class ClaudeConnector {
  private readonly levelDbPath: string

  constructor(levelDbPath = defaultClaudeLevelDbPath()) {
    this.levelDbPath = levelDbPath
  }

  diagnostics(): SyncDiagnostics {
    try {
      const exists = fs.existsSync(this.levelDbPath)
      return {
        exists,
        path: this.levelDbPath,
        error: exists ? undefined : 'Path does not exist'
      }
    } catch (error) {
      return {
        exists: false,
        path: this.levelDbPath,
        error: error instanceof Error ? error.message : 'Unknown filesystem error'
      }
    }
  }

  async listConversations(): Promise<ClaudeConversation[]> {
    const diagnostics = this.diagnostics()
    if (!diagnostics.exists) {
      return []
    }

    const conversations = new Map<string, ConversationAccumulator>()
    const db = new Level<string, string>(this.levelDbPath, {
      keyEncoding: 'utf8',
      valueEncoding: 'utf8'
    })

    try {
      for await (const [key, rawValue] of db.iterator()) {
        const parsedKey = parseConversationKey(key)
        if (!parsedKey) {
          continue
        }

        const parsedValue = maybeParseJson(rawValue)
        const { conversationUuid, property } = parsedKey

        const accumulator =
          conversations.get(conversationUuid) ?? {
            conversation_uuid: conversationUuid,
            title: null,
            chat_timestamp: null,
            last_user_message: null
          }

        const timestamp = extractTimestampFromUnknown(parsedValue)
        if (timestamp && (!accumulator.chat_timestamp || timestamp > accumulator.chat_timestamp)) {
          accumulator.chat_timestamp = timestamp
        }

        if (property.includes('title')) {
          accumulator.title = extractTitleFromUnknown(parsedValue) ?? accumulator.title
        } else if (!accumulator.title) {
          accumulator.title = extractTitleFromUnknown(parsedValue)
        }

        const message = this.extractLastUserMessage(parsedValue)
        if (message) {
          accumulator.last_user_message = message
        }

        conversations.set(conversationUuid, accumulator)
      }
    } finally {
      await db.close()
    }

    return Array.from(conversations.values()).sort((a, b) => {
      return (b.chat_timestamp ?? 0) - (a.chat_timestamp ?? 0)
    })
  }

  async getConversationDetail(uuid: string): Promise<ClaudeConversation | null> {
    const conversations = await this.listConversations()
    return conversations.find((conversation) => conversation.conversation_uuid === uuid) ?? null
  }

  private extractLastUserMessage(editorState: unknown): string | null {
    return extractLastUserMessageFromUnknown(editorState)
  }
}
