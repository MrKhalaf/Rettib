import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'

import type { IpcMainInvokeEvent } from 'electron'

import type { ChatStreamEvent, SendChatMessageResult } from '../shared/types'

export const CHAT_STREAM_EVENT_CHANNEL = 'chat:stream-event'

interface ClaudeCliRequest {
  message: string
  cwd: string
  resume_session_id?: string | null
  model?: string | null
  permission_mode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'delegate' | 'dontAsk' | 'plan' | null
}

interface ActiveStream {
  child: ChildProcess
}

const activeStreams = new Map<string, ActiveStream>()
const CLAUDE_BINARY_ENV_KEYS = ['RETTIB_CLAUDE_BIN', 'CLAUDE_BIN'] as const
let cachedClaudeExecutable: string | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getKnownClaudeBinDirs(): string[] {
  const home = os.homedir()
  return [
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ]
}

function pathContainsBinary(dirPath: string, binaryName: string): string | null {
  if (!dirPath) {
    return null
  }

  const candidate = path.join(dirPath, binaryName)
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return candidate
  } catch {
    return null
  }
}

function buildClaudeExecutableCandidates(pathEnv: string): string[] {
  const candidates: string[] = []

  for (const envKey of CLAUDE_BINARY_ENV_KEYS) {
    const configured = process.env[envKey]
    if (!configured) {
      continue
    }

    const absolute = path.isAbsolute(configured) ? configured : path.resolve(configured)
    candidates.push(absolute)
  }

  for (const knownDir of getKnownClaudeBinDirs()) {
    const candidate = pathContainsBinary(knownDir, 'claude')
    if (candidate) {
      candidates.push(candidate)
    }
  }

  const pathDirs = pathEnv.split(path.delimiter).filter((part) => part.trim().length > 0)
  for (const dirPath of pathDirs) {
    const candidate = pathContainsBinary(dirPath, 'claude')
    if (candidate) {
      candidates.push(candidate)
    }
  }

  return Array.from(new Set(candidates))
}

function isUsableClaudeExecutable(candidatePath: string, pathEnv: string): boolean {
  const probe = spawnSync(candidatePath, ['--version'], {
    env: {
      ...process.env,
      PATH: pathEnv
    },
    stdio: 'pipe',
    timeout: 6_000
  })

  if (probe.error) {
    return false
  }

  return probe.status === 0
}

function buildChildPathEnv(): string {
  const existingPath = process.env.PATH ?? ''
  const pathParts = existingPath.split(path.delimiter).filter((part) => part.trim().length > 0)
  const merged = [...pathParts, ...getKnownClaudeBinDirs()]
  const unique = Array.from(new Set(merged))
  return unique.join(path.delimiter)
}

function resolveClaudeExecutable(pathEnv: string): string | null {
  if (cachedClaudeExecutable && isUsableClaudeExecutable(cachedClaudeExecutable, pathEnv)) {
    return cachedClaudeExecutable
  }

  const candidates = buildClaudeExecutableCandidates(pathEnv)
  for (const candidate of candidates) {
    if (!isUsableClaudeExecutable(candidate, pathEnv)) {
      continue
    }

    cachedClaudeExecutable = candidate
    return candidate
  }

  cachedClaudeExecutable = null
  return null
}

function emitStreamEvent(event: IpcMainInvokeEvent, payload: ChatStreamEvent): void {
  if (!event.sender.isDestroyed()) {
    event.sender.send(CHAT_STREAM_EVENT_CHANNEL, payload)
  }
}

function maybeParseJsonLine(rawLine: string): Record<string, unknown> | null {
  const line = rawLine.trim()
  if (!line.startsWith('{')) {
    return null
  }

  try {
    const parsed = JSON.parse(line) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
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
    }
  }

  return parts.join('\n')
}

function extractTextDelta(payload: Record<string, unknown>): string | null {
  if (payload.type !== 'stream_event') {
    return null
  }

  const event = payload.event
  if (!isRecord(event) || event.type !== 'content_block_delta') {
    return null
  }

  const delta = event.delta
  if (!isRecord(delta) || delta.type !== 'text_delta' || typeof delta.text !== 'string') {
    return null
  }

  return delta.text
}

function normalizeToolUseInput(input: unknown): unknown {
  if (isRecord(input) || Array.isArray(input)) {
    return input
  }

  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return input
  }

  return null
}

function extractToolUsesFromAssistantPayload(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (payload.type !== 'assistant') {
    return []
  }

  const message = payload.message
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return []
  }

  const toolUses: Record<string, unknown>[] = []
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'tool_use') {
      continue
    }

    toolUses.push({
      id: typeof block.id === 'string' ? block.id : null,
      name: typeof block.name === 'string' ? block.name : null,
      input: normalizeToolUseInput(block.input)
    })
  }

  return toolUses
}

function extractToolResultsFromUserPayload(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (payload.type !== 'user') {
    return []
  }

  const message = payload.message
  if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.content)) {
    return []
  }

  const toolUseResult = isRecord(payload.tool_use_result) ? payload.tool_use_result : null
  const toolResults: Record<string, unknown>[] = []

  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'tool_result') {
      continue
    }

    const blockText = extractTextFromContent(block.content).trim()
    const stdout = typeof toolUseResult?.stdout === 'string' ? toolUseResult.stdout.trim() : ''
    const stderr = typeof toolUseResult?.stderr === 'string' ? toolUseResult.stderr.trim() : ''
    const text = blockText || (stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr || '')

    toolResults.push({
      tool_use_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
      is_error: block.is_error === true,
      text: text || null,
      stdout: stdout || null,
      stderr: stderr || null,
      interrupted: toolUseResult?.interrupted === true
    })
  }

  return toolResults
}

function extractPermissionDenials(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (payload.type !== 'result' || !Array.isArray(payload.permission_denials)) {
    return []
  }

  const denials: Record<string, unknown>[] = []
  for (const entry of payload.permission_denials) {
    if (!isRecord(entry)) {
      continue
    }

    denials.push({
      tool_name: typeof entry.tool_name === 'string' ? entry.tool_name : null,
      tool_use_id: typeof entry.tool_use_id === 'string' ? entry.tool_use_id : null,
      tool_input: normalizeToolUseInput(entry.tool_input)
    })
  }

  return denials
}

function summarizePermissionInput(input: unknown): string {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    return trimmed || '(no input details)'
  }

  if (!isRecord(input)) {
    return '(no input details)'
  }

  const command = input.command
  if (typeof command === 'string' && command.trim()) {
    return command.trim()
  }

  const description = input.description
  if (typeof description === 'string' && description.trim()) {
    return description.trim()
  }

  const keys = Object.keys(input)
  return keys.length > 0 ? `{${keys.slice(0, 3).join(', ')}}` : '(no input details)'
}

function buildPermissionSummary(denials: Record<string, unknown>[]): string {
  if (denials.length === 0) {
    return 'Claude requested approval for one or more operations.'
  }

  const lines = denials.map((entry) => {
    const toolName = typeof entry.tool_name === 'string' && entry.tool_name.trim() ? entry.tool_name.trim() : 'Tool'
    const inputSummary = summarizePermissionInput(entry.tool_input)
    return `- ${toolName}: ${inputSummary}`
  })

  return `Claude requested approval for the following operations:\n${lines.join('\n')}`
}

function buildClaudeArgs(input: ClaudeCliRequest): string[] {
  const args = [
    '-p',
    input.message,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages'
  ]

  const resume = input.resume_session_id?.trim()
  if (resume) {
    args.push('--resume', resume)
  }

  const model = input.model?.trim()
  if (model) {
    args.push('--model', model)
  }

  const permissionMode = input.permission_mode?.trim()
  if (permissionMode) {
    args.push('--permission-mode', permissionMode)
  }

  return args
}

function nowMs(): number {
  return Date.now()
}

export async function runClaudeCliStream(
  event: IpcMainInvokeEvent,
  input: ClaudeCliRequest
): Promise<SendChatMessageResult> {
  const streamId = randomUUID()
  const childPathEnv = buildChildPathEnv()
  const claudeExecutable = resolveClaudeExecutable(childPathEnv)
  if (!claudeExecutable) {
    throw new Error(
      'Claude CLI was not found. Install it and ensure it is in PATH, or set RETTIB_CLAUDE_BIN to the full binary path.'
    )
  }

  const child = spawn(claudeExecutable, buildClaudeArgs(input), {
    cwd: input.cwd,
    env: {
      ...process.env,
      PATH: childPathEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  activeStreams.set(streamId, { child })

  return await new Promise<SendChatMessageResult>((resolve, reject) => {
    let sessionId: string | null = input.resume_session_id?.trim() || null
    let assistantTextFromChunks = ''
    let assistantTextFromFinalMessage = ''
    let resultText: string | null = null
    let markedAsError = false
    const stderrLines: string[] = []
    const permissionDenials: Record<string, unknown>[] = []

    const stdoutLines = readline.createInterface({ input: child.stdout })
    const stderrLinesReader = readline.createInterface({ input: child.stderr })

    function emit(payload: Omit<ChatStreamEvent, 'stream_id' | 'timestamp'>): void {
      emitStreamEvent(event, {
        stream_id: streamId,
        timestamp: nowMs(),
        ...payload
      })
    }

    function cleanup(): void {
      stdoutLines.removeAllListeners()
      stderrLinesReader.removeAllListeners()
      stdoutLines.close()
      stderrLinesReader.close()
      activeStreams.delete(streamId)
    }

    stdoutLines.on('line', (line) => {
      const parsed = maybeParseJsonLine(line)
      if (!parsed) {
        return
      }

      const payloadSessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null
      if (payloadSessionId) {
        sessionId = payloadSessionId
      }

      if (parsed.type === 'system' && parsed.subtype === 'init') {
        emit({ type: 'init', data: parsed, session_id: sessionId })
        return
      }

      const tokenDelta = extractTextDelta(parsed)
      if (tokenDelta) {
        assistantTextFromChunks += tokenDelta
        emit({ type: 'token', text: tokenDelta, session_id: sessionId })
      }

      if (parsed.type === 'assistant') {
        const toolUses = extractToolUsesFromAssistantPayload(parsed)
        for (const toolUse of toolUses) {
          emit({ type: 'tool_use', data: toolUse, session_id: sessionId })

          const toolName = typeof toolUse.name === 'string' ? toolUse.name.toLowerCase() : ''
          if (toolName === 'askuserquestion') {
            emit({ type: 'question', data: toolUse, session_id: sessionId })
          }
        }

        const message = parsed.message
        if (isRecord(message)) {
          assistantTextFromFinalMessage = extractTextFromContent(message.content)
          if (assistantTextFromFinalMessage) {
            emit({ type: 'assistant', text: assistantTextFromFinalMessage, session_id: sessionId })
          }
        }
      }

      const toolResults = extractToolResultsFromUserPayload(parsed)
      for (const toolResult of toolResults) {
        emit({ type: 'tool_result', data: toolResult, session_id: sessionId })
      }

      if (parsed.type === 'result') {
        if (typeof parsed.result === 'string') {
          resultText = parsed.result
        }
        if (typeof parsed.is_error === 'boolean') {
          markedAsError = parsed.is_error
        }

        const denied = extractPermissionDenials(parsed)
        if (denied.length > 0) {
          permissionDenials.push(...denied)
          markedAsError = true
          emit({ type: 'permission', data: { denials: denied }, session_id: sessionId })
        }

        emit({ type: 'result', data: parsed, session_id: sessionId })
      }
    })

    stderrLinesReader.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('\u001b]1337;SetProfile=')) {
        return
      }

      stderrLines.push(trimmed)
      emit({ type: 'error', error: trimmed, session_id: sessionId })
    })

    child.once('error', (error) => {
      cleanup()
      emit({ type: 'error', error: error.message, session_id: sessionId })
      reject(error)
    })

    child.once('close', (code) => {
      cleanup()

      const assistantText = assistantTextFromChunks || assistantTextFromFinalMessage || resultText || ''
      const stderrText = stderrLines.length > 0 ? stderrLines.join('\n') : null
      const permissionSummary = permissionDenials.length > 0 ? buildPermissionSummary(permissionDenials) : null
      const isError = markedAsError || code !== 0 || permissionDenials.length > 0
      const finalResultText =
        resultText && permissionSummary
          ? `${resultText}\n\n${permissionSummary}`
          : resultText ?? (isError ? (stderrText ?? permissionSummary) : null)

      emit({
        type: 'done',
        session_id: sessionId,
        data: {
          exit_code: code,
          is_error: isError
        }
      })

      resolve({
        stream_id: streamId,
        session_id: sessionId,
        assistant_text: assistantText,
        result_text: finalResultText,
        is_error: isError,
        exit_code: code
      })
    })
  })
}

export function cancelClaudeCliStream(streamId: string): boolean {
  const active = activeStreams.get(streamId)
  if (!active) {
    return false
  }

  if (!active.child.killed) {
    active.child.kill('SIGTERM')
  }

  return true
}
