import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import type {
  ChatSessionCommandMode,
  TerminalEvent,
  TerminalSessionState
} from '../shared/types'
import { ClaudeConnector } from './claude-connector'
import {
  getDatabase,
  getOrCreateClaudeSyncSource,
  linkChatReference,
  setWorkstreamChatSession
} from './database'
import { buildChildPathEnv, resolveClaudeExecutableOrThrow } from './claude-cli-runner'

export const TERMINAL_EVENT_CHANNEL = 'chat:terminal-event'

const WRITE_BATCH_SIZE = 16_384
const RESIZE_DEBOUNCE_MS = 60

// ── Types ──────────────────────────────────────────────────────────

interface StartTerminalSessionParams {
  taskId: number
  workstreamId: number
  conversationUuid: string | null
  cwd: string
  commandMode: ChatSessionCommandMode
}

interface ActiveTerminalSession {
  ptyProcess: pty.IPty
  taskId: number
  conversationUuid: string
  workstreamId: number
  cwd: string
  commandMode: ChatSessionCommandMode
  startedAt: number
  stopRequested: boolean
}

// ── Module state ───────────────────────────────────────────────────

const sessions = new Map<number, ActiveTerminalSession>()
let attachedTaskId: number | null = null
const scrollPositions = new Map<number, number>()
const outputBuffers = new Map<number, string>()

const resizeTimers = new Map<number, ReturnType<typeof setTimeout>>()

const requireModule = createRequire(import.meta.url)

// ── Helpers ────────────────────────────────────────────────────────

function nowMs(): number {
  return Date.now()
}

function parseClaudePathFromSourceConfig(config: string): string | null {
  try {
    const parsed = JSON.parse(config) as { path?: unknown }
    return typeof parsed.path === 'string' ? parsed.path : null
  } catch {
    return null
  }
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return
  }

  try {
    const packageJsonPath = requireModule.resolve('node-pty/package.json')
    const packageRoot = path.dirname(packageJsonPath)
    const candidates = [
      path.join(packageRoot, 'build', 'Release', 'spawn-helper'),
      path.join(packageRoot, 'build', 'Debug', 'spawn-helper'),
      path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    ]

    for (const candidatePath of candidates) {
      if (!fs.existsSync(candidatePath)) {
        continue
      }

      const stat = fs.statSync(candidatePath)
      if ((stat.mode & 0o111) !== 0) {
        continue
      }

      fs.chmodSync(candidatePath, stat.mode | 0o755)
    }
  } catch {
    // Best-effort hardening only
  }
}

function buildSessionState(session: ActiveTerminalSession | undefined): TerminalSessionState {
  if (!session) {
    return {
      is_active: false,
      task_id: null,
      conversation_uuid: null,
      workstream_id: null,
      cwd: null,
      command_mode: null,
      started_at: null
    }
  }

  return {
    is_active: true,
    task_id: session.taskId,
    conversation_uuid: session.conversationUuid,
    workstream_id: session.workstreamId,
    cwd: session.cwd,
    command_mode: session.commandMode,
    started_at: session.startedAt
  }
}

function emit(event: Omit<TerminalEvent, 'timestamp'>): void {
  const payload: TerminalEvent = {
    timestamp: nowMs(),
    ...event
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) {
      continue
    }

    window.webContents.send(TERMINAL_EVENT_CHANNEL, payload)
  }
}

function appendToBuffer(taskId: number, data: string): void {
  const existing = outputBuffers.get(taskId) ?? ''
  outputBuffers.set(taskId, existing + data)
}

function drainBuffer(taskId: number): void {
  const buffer = outputBuffers.get(taskId)
  if (!buffer || buffer.length === 0) return

  const slice = buffer.slice(0, WRITE_BATCH_SIZE)
  const remaining = buffer.slice(WRITE_BATCH_SIZE)
  outputBuffers.set(taskId, remaining)

  const session = sessions.get(taskId)
  emit({
    type: 'output',
    task_id: taskId,
    conversation_uuid: session?.conversationUuid ?? null,
    workstream_id: session?.workstreamId ?? null,
    output: slice
  })

  if (remaining.length > 0) {
    setImmediate(() => drainBuffer(taskId))
  }
}

async function syncConversationReference(conversationUuid: string, workstreamId: number, cwd: string): Promise<void> {
  const db = getDatabase()
  setWorkstreamChatSession(workstreamId, conversationUuid, cwd, db)

  const source = getOrCreateClaudeSyncSource(db)
  const configuredPath = parseClaudePathFromSourceConfig(source.config)
  const connector = new ClaudeConnector(configuredPath ?? undefined)
  const conversation = await connector.getConversationDetail(conversationUuid).catch(() => null)

  linkChatReference(
    workstreamId,
    {
      conversation_uuid: conversationUuid,
      conversation_title: conversation?.title ?? conversationUuid,
      last_user_message: conversation?.last_user_message ?? null,
      chat_timestamp: Date.now(),
      source: 'claude_cli'
    },
    db
  )
}

function buildClaudeArgs(
  conversationUuid: string,
  shouldResume: boolean,
  commandMode: ChatSessionCommandMode
): string[] {
  const args: string[] = shouldResume ? ['--resume', conversationUuid] : ['--session-id', conversationUuid]
  if (commandMode === 'cc') {
    args.push('--dangerously-skip-permissions')
  }

  return args
}

// ── New multi-session API (per-task) ───────────────────────────────

export function startTaskTerminalSession(params: StartTerminalSessionParams): TerminalSessionState {
  const normalizedConversationUuid = params.conversationUuid?.trim() || null
  const existing = sessions.get(params.taskId)

  if (existing) {
    if (normalizedConversationUuid && existing.conversationUuid === normalizedConversationUuid) {
      return buildSessionState(existing)
    }
    throw new Error(
      `Task ${params.taskId} already has an active terminal session. Stop it before starting a new one.`
    )
  }

  const conversationUuid = normalizedConversationUuid ?? randomUUID()
  const shouldResume = Boolean(normalizedConversationUuid)
  const childPathEnv = buildChildPathEnv()
  const claudeExecutable = resolveClaudeExecutableOrThrow(childPathEnv)
  ensureNodePtySpawnHelperExecutable()

  let ptyProcess: pty.IPty
  try {
    ptyProcess = pty.spawn(claudeExecutable, buildClaudeArgs(conversationUuid, shouldResume, params.commandMode), {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: params.cwd,
      env: {
        ...process.env,
        PATH: childPathEnv
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Unable to start terminal session (command: ${claudeExecutable}, cwd: ${params.cwd}). ${message}`
    )
  }

  const session: ActiveTerminalSession = {
    ptyProcess,
    taskId: params.taskId,
    conversationUuid,
    workstreamId: params.workstreamId,
    cwd: params.cwd,
    commandMode: params.commandMode,
    startedAt: nowMs(),
    stopRequested: false
  }

  sessions.set(params.taskId, session)
  outputBuffers.set(params.taskId, '')

  emit({
    type: 'started',
    task_id: params.taskId,
    conversation_uuid: conversationUuid,
    workstream_id: params.workstreamId,
    state: buildSessionState(session)
  })

  void syncConversationReference(conversationUuid, params.workstreamId, params.cwd).catch((error) => {
    emit({
      type: 'error',
      task_id: params.taskId,
      conversation_uuid: conversationUuid,
      workstream_id: params.workstreamId,
      message: error instanceof Error ? error.message : 'Failed to sync terminal session metadata'
    })
  })

  ptyProcess.onData((output) => {
    if (attachedTaskId === params.taskId) {
      emit({
        type: 'output',
        task_id: params.taskId,
        conversation_uuid: conversationUuid,
        workstream_id: params.workstreamId,
        output
      })
    } else {
      appendToBuffer(params.taskId, output)
    }
  })

  ptyProcess.onExit(({ exitCode, signal }) => {
    const current = sessions.get(params.taskId)
    if (!current || current.ptyProcess !== ptyProcess) return

    const stopRequested = current.stopRequested
    sessions.delete(params.taskId)

    if (attachedTaskId === params.taskId) {
      attachedTaskId = null
    }

    emit({
      type: stopRequested ? 'stopped' : 'exit',
      task_id: params.taskId,
      conversation_uuid: current.conversationUuid,
      workstream_id: current.workstreamId,
      exit_code: exitCode,
      signal,
      state: buildSessionState(undefined)
    })

    void syncConversationReference(current.conversationUuid, current.workstreamId, current.cwd).catch((error) => {
      emit({
        type: 'error',
        task_id: params.taskId,
        conversation_uuid: current.conversationUuid,
        workstream_id: current.workstreamId,
        message: error instanceof Error ? error.message : 'Failed to sync terminal session metadata'
      })
    })
  })

  return buildSessionState(session)
}

export function stopTaskTerminalSession(taskId: number): void {
  const session = sessions.get(taskId)
  if (!session) return

  session.stopRequested = true
  session.ptyProcess.kill()
}

export function attachSession(taskId: number): { output: string } | null {
  const session = sessions.get(taskId)
  if (!session) return null

  attachedTaskId = taskId

  const buffered = outputBuffers.get(taskId) ?? ''
  outputBuffers.set(taskId, '')

  return { output: buffered }
}

export function detachSession(taskId: number, scrollOffset: number): void {
  scrollPositions.set(taskId, scrollOffset)

  if (attachedTaskId === taskId) {
    attachedTaskId = null
  }
}

export function sendTaskTerminalInput(taskId: number, data: string): void {
  const session = sessions.get(taskId)
  if (!session) {
    throw new Error(`No active terminal session for task ${taskId}`)
  }

  session.ptyProcess.write(data)
}

export function resizeTaskTerminal(taskId: number, cols: number, rows: number): void {
  const existing = resizeTimers.get(taskId)
  if (existing) clearTimeout(existing)

  resizeTimers.set(taskId, setTimeout(() => {
    const session = sessions.get(taskId)
    if (!session) return

    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return

    const safeCols = Math.max(20, Math.floor(cols))
    const safeRows = Math.max(6, Math.floor(rows))
    session.ptyProcess.resize(safeCols, safeRows)
    resizeTimers.delete(taskId)
  }, RESIZE_DEBOUNCE_MS))
}

export function saveScrollPosition(taskId: number, offset: number): void {
  scrollPositions.set(taskId, offset)
}

export function getScrollPosition(taskId: number): number {
  return scrollPositions.get(taskId) ?? -1
}

export function getActiveSessions(): TerminalSessionState[] {
  return Array.from(sessions.values()).map(buildSessionState)
}

export function getTaskTerminalSessionState(taskId: number): TerminalSessionState {
  return buildSessionState(sessions.get(taskId))
}

export function stopAllSessions(): void {
  for (const [, session] of sessions) {
    session.stopRequested = true
    session.ptyProcess.kill()
  }
}

// ── Legacy single-session API (backward compat for existing chat handlers) ──

export function getTerminalSessionState(): TerminalSessionState {
  // Return first active session or empty state
  const first = sessions.values().next().value as ActiveTerminalSession | undefined
  return buildSessionState(first)
}

export function isTerminalSessionActiveForConversation(conversationUuid: string | null | undefined): boolean {
  const normalized = conversationUuid?.trim() ?? ''
  if (!normalized) return false

  for (const session of sessions.values()) {
    if (session.conversationUuid === normalized) return true
  }

  return false
}

export function startTerminalSession(params: {
  workstreamId: number
  conversationUuid: string | null
  cwd: string
  commandMode: ChatSessionCommandMode
}): TerminalSessionState {
  // Legacy: use workstreamId as a pseudo-taskId (negative to avoid collision)
  const pseudoTaskId = -(params.workstreamId)
  return startTaskTerminalSession({
    taskId: pseudoTaskId,
    workstreamId: params.workstreamId,
    conversationUuid: params.conversationUuid,
    cwd: params.cwd,
    commandMode: params.commandMode
  })
}

export function stopTerminalSession(): TerminalSessionState {
  // Legacy: stop first session
  const first = sessions.values().next().value as ActiveTerminalSession | undefined
  if (first) {
    first.stopRequested = true
    first.ptyProcess.kill()
  }
  return buildSessionState(undefined)
}

export function sendTerminalInput(data: string): void {
  // Legacy: send to first session
  const first = sessions.values().next().value as ActiveTerminalSession | undefined
  if (!first) throw new Error('No active terminal session')
  first.ptyProcess.write(data)
}

export function resizeTerminal(cols: number, rows: number): void {
  // Legacy: resize first session
  const first = sessions.values().next().value as ActiveTerminalSession | undefined
  if (!first) return

  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return

  const safeCols = Math.max(20, Math.floor(cols))
  const safeRows = Math.max(6, Math.floor(rows))
  first.ptyProcess.resize(safeCols, safeRows)
}
