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

interface StartTerminalSessionParams {
  workstreamId: number
  conversationUuid: string | null
  cwd: string
  commandMode: ChatSessionCommandMode
}

interface ActiveTerminalSession {
  ptyProcess: pty.IPty
  conversationUuid: string
  workstreamId: number
  cwd: string
  commandMode: ChatSessionCommandMode
  startedAt: number
  stopRequested: boolean
}

let activeSession: ActiveTerminalSession | null = null
const requireModule = createRequire(import.meta.url)

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
    // Best-effort hardening only; spawn error handling below surfaces issues to the UI.
  }
}

function buildState(): TerminalSessionState {
  if (!activeSession) {
    return {
      is_active: false,
      conversation_uuid: null,
      workstream_id: null,
      cwd: null,
      command_mode: null,
      started_at: null
    }
  }

  return {
    is_active: true,
    conversation_uuid: activeSession.conversationUuid,
    workstream_id: activeSession.workstreamId,
    cwd: activeSession.cwd,
    command_mode: activeSession.commandMode,
    started_at: activeSession.startedAt
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

export function getTerminalSessionState(): TerminalSessionState {
  return buildState()
}

export function isTerminalSessionActiveForConversation(conversationUuid: string | null | undefined): boolean {
  const normalized = conversationUuid?.trim() ?? ''
  if (!normalized || !activeSession) {
    return false
  }

  return activeSession.conversationUuid === normalized
}

export function startTerminalSession(params: StartTerminalSessionParams): TerminalSessionState {
  const normalizedConversationUuid = params.conversationUuid?.trim() || null

  if (activeSession) {
    if (normalizedConversationUuid && activeSession.conversationUuid === normalizedConversationUuid) {
      return buildState()
    }

    throw new Error(
      `Another terminal session is already active for ${activeSession.conversationUuid}. Stop it before starting a new one.`
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

  activeSession = {
    ptyProcess,
    conversationUuid,
    workstreamId: params.workstreamId,
    cwd: params.cwd,
    commandMode: params.commandMode,
    startedAt: nowMs(),
    stopRequested: false
  }

  emit({
    type: 'started',
    conversation_uuid: conversationUuid,
    workstream_id: params.workstreamId,
    state: buildState()
  })

  void syncConversationReference(conversationUuid, params.workstreamId, params.cwd).catch((error) => {
    emit({
      type: 'error',
      conversation_uuid: conversationUuid,
      workstream_id: params.workstreamId,
      message: error instanceof Error ? error.message : 'Failed to sync terminal session metadata'
    })
  })

  ptyProcess.onData((output) => {
    emit({
      type: 'output',
      conversation_uuid: conversationUuid,
      workstream_id: params.workstreamId,
      output
    })
  })

  ptyProcess.onExit(({ exitCode, signal }) => {
    const previous = activeSession
    if (!previous || previous.ptyProcess !== ptyProcess) {
      return
    }

    const stopRequested = previous.stopRequested
    activeSession = null

    emit({
      type: stopRequested ? 'stopped' : 'exit',
      conversation_uuid: previous.conversationUuid,
      workstream_id: previous.workstreamId,
      exit_code: exitCode,
      signal,
      state: buildState()
    })

    void syncConversationReference(previous.conversationUuid, previous.workstreamId, previous.cwd).catch((error) => {
      emit({
        type: 'error',
        conversation_uuid: previous.conversationUuid,
        workstream_id: previous.workstreamId,
        message: error instanceof Error ? error.message : 'Failed to sync terminal session metadata'
      })
    })
  })

  return buildState()
}

export function stopTerminalSession(): TerminalSessionState {
  if (!activeSession) {
    return buildState()
  }

  const current = activeSession
  current.stopRequested = true
  current.ptyProcess.kill()
  return buildState()
}

export function sendTerminalInput(data: string): void {
  if (!activeSession) {
    throw new Error('No active terminal session')
  }

  activeSession.ptyProcess.write(data)
}

export function resizeTerminal(cols: number, rows: number): void {
  if (!activeSession) {
    return
  }

  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return
  }

  const safeCols = Math.max(20, Math.floor(cols))
  const safeRows = Math.max(6, Math.floor(rows))
  activeSession.ptyProcess.resize(safeCols, safeRows)
}
