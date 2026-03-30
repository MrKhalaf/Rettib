import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

import type { ChatSessionCommandMode, Task } from '../../shared/types'
import { terminalApi } from '../api/terminal'
import { useTaskTerminal } from '../hooks/useTerminal'
import { formatRelativeTime } from '../utils/time'

interface Props {
  task: Task | null
  workstreamId: number | null
  projectName: string | null
  projectRunDirectory: string | null
}

const RESIZE_DEBOUNCE_MS = 60
const TERMINAL_THEME = {
  background: '#0f1116',
  foreground: '#cfd7e6',
  cursor: '#d9c6a0',
  selectionBackground: '#283147'
}

const COMMAND_MODE_LABELS: Record<ChatSessionCommandMode, string> = {
  claude: 'Claude',
  cc: 'CC'
}

function shortenSessionId(sessionId: string | null): string {
  if (!sessionId) {
    return 'New session'
  }

  if (sessionId.length <= 18) {
    return sessionId
  }

  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`
}

function getActiveCwd(task: Task | null, sessionCwd: string | null, projectRunDirectory: string | null): string | null {
  return sessionCwd ?? task?.worktree_path ?? task?.run_directory ?? projectRunDirectory ?? null
}

export function TaskTerminalView({ task, workstreamId, projectName, projectRunDirectory }: Props) {
  const { isRunning, error, output, sessionState, start, stop, sendInput, resize, saveScroll } = useTaskTerminal(
    task?.id ?? null,
    workstreamId
  )

  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sendInputRef = useRef(sendInput)
  const resizeRef = useRef(resize)
  const saveScrollRef = useRef(saveScroll)
  const outputLengthRef = useRef(0)
  const taskIdRef = useRef<number | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollOffsetsRef = useRef<Map<number, number>>(new Map())

  sendInputRef.current = sendInput
  resizeRef.current = resize
  saveScrollRef.current = saveScroll

  const commandMode = task?.command_mode ?? 'claude'
  const commandModeLabel = COMMAND_MODE_LABELS[commandMode]
  const activeCwd = useMemo(
    () => getActiveCwd(task, sessionState.cwd, projectRunDirectory),
    [projectRunDirectory, sessionState.cwd, task]
  )
  const hasConfiguredDirectory = Boolean(activeCwd)
  const startedLabel = sessionState.started_at ? formatRelativeTime(sessionState.started_at) : null

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus()
  }, [])

  const restoreViewport = useCallback((nextTaskId: number | null) => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }

    const scrollOffset = nextTaskId === null ? -1 : (scrollOffsetsRef.current.get(nextTaskId) ?? -1)
    if (scrollOffset >= 0) {
      terminal.scrollToLine(scrollOffset)
      return
    }

    terminal.scrollToBottom()
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const terminal = new Terminal({
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      convertEol: true,
      cursorBlink: true,
      scrollback: 10_000,
      theme: TERMINAL_THEME
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const dataDisposable = terminal.onData((data) => {
      sendInputRef.current(data)
    })

    const scrollDisposable = terminal.onScroll(() => {
      const viewport = terminal.buffer.active
      const atBottom = viewport.baseY + terminal.rows >= viewport.length
      const scrollOffset = atBottom ? -1 : viewport.viewportY
      const currentTaskId = taskIdRef.current

      if (currentTaskId !== null) {
        scrollOffsetsRef.current.set(currentTaskId, scrollOffset)
        saveScrollRef.current(scrollOffset)
      }
    })

    let resizeObserver: ResizeObserver | null = null
    if (typeof window.ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = setTimeout(() => {
          if (!fitAddonRef.current || !terminalRef.current) {
            return
          }

          fitAddonRef.current.fit()
          if (taskIdRef.current !== null) {
            resizeRef.current(terminalRef.current.cols, terminalRef.current.rows)
          }
          resizeTimerRef.current = null
        }, RESIZE_DEBOUNCE_MS)
      })
      resizeObserver.observe(container)
    }

    return () => {
      dataDisposable.dispose()
      scrollDisposable.dispose()
      resizeObserver?.disconnect()
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      outputLengthRef.current = 0
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }

    const nextTaskId = task?.id ?? null

    if (taskIdRef.current !== nextTaskId) {
      const previousTaskId = taskIdRef.current
      if (previousTaskId !== null) {
        const previousOffset = scrollOffsetsRef.current.get(previousTaskId) ?? -1
        terminalApi.detach(previousTaskId, previousOffset).catch(() => {})
      }

      taskIdRef.current = nextTaskId
      terminal.reset()

      const applyTerminalState = () => {
        fitAddonRef.current?.fit()
        if (nextTaskId !== null) {
          resizeRef.current(terminal.cols, terminal.rows)
        }
        restoreViewport(nextTaskId)
      }

      if (output) {
        terminal.write(output, applyTerminalState)
      } else {
        applyTerminalState()
      }

      outputLengthRef.current = output.length
      return
    }

    if (output.length < outputLengthRef.current) {
      terminal.reset()
      terminal.write(output, () => restoreViewport(nextTaskId))
      outputLengthRef.current = output.length
      return
    }

    if (output.length === outputLengthRef.current) {
      return
    }

    const delta = output.slice(outputLengthRef.current)
    terminal.write(delta)
    outputLengthRef.current = output.length
  }, [output, restoreViewport, task?.id])

  useEffect(() => {
    return () => {
      const currentTaskId = taskIdRef.current
      if (currentTaskId === null) {
        return
      }

      const scrollOffset = scrollOffsetsRef.current.get(currentTaskId) ?? -1
      terminalApi.detach(currentTaskId, scrollOffset).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (!task) {
      return
    }

    const timer = window.setTimeout(() => {
      focusTerminal()
    }, 50)

    return () => {
      window.clearTimeout(timer)
    }
  }, [focusTerminal, isRunning, task?.id])

  return (
    <div className="task-terminal-view">
      <header className="task-terminal-header">
        <div className="task-terminal-heading">
          <span className="task-terminal-kicker">{projectName ?? 'Agent workspace'}</span>
          <div className="task-terminal-title-row">
            <h2 className="task-terminal-title">{task?.title ?? 'Select a task'}</h2>
            {task ? (
              <span className={`task-terminal-status ${isRunning ? 'active' : ''}`}>
                {isRunning ? 'Live' : 'Ready'}
              </span>
            ) : null}
          </div>
        </div>

        {task ? (
          <div className="task-terminal-controls">
            <span className="task-terminal-pill">{commandModeLabel}</span>
            {isRunning ? (
              <button type="button" className="tv-btn tv-btn-stop" onClick={stop}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="tv-btn tv-btn-run"
                onClick={() => {
                  focusTerminal()
                  void start(commandMode)
                }}
              >
                Run Agent
              </button>
            )}
          </div>
        ) : null}
      </header>

      {task ? (
        <div className="task-terminal-meta">
          <span>{hasConfiguredDirectory ? activeCwd : 'No run directory configured'}</span>
          <span>{shortenSessionId(sessionState.conversation_uuid)}</span>
          <span>{startedLabel ? `Started ${startedLabel}` : isRunning ? 'Starting session…' : 'Not started'}</span>
        </div>
      ) : null}

      <div className="task-terminal-stage">
        <div className="task-terminal-frame">
          <div className="task-terminal-frame-bar">
            <div className="task-terminal-frame-label">
              <span className={`task-terminal-frame-dot ${isRunning ? 'active' : ''}`} />
              <span>{task ? `${commandModeLabel} terminal` : 'Agent terminal'}</span>
            </div>
            {task ? (
              <span className="task-terminal-frame-path">{activeCwd ?? 'No working directory configured'}</span>
            ) : null}
          </div>

          <div
            className="task-terminal-surface"
            ref={containerRef}
            onMouseDown={focusTerminal}
            onClick={focusTerminal}
          />

          {!task ? (
            <div className="task-terminal-empty">
              <div className="task-terminal-empty-card">
                <h3>Open a task to start an agent session</h3>
                <p>The task terminal will appear here, following the compact terminal-first layout used in emdash.</p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {task && !hasConfiguredDirectory ? (
        <div className="task-terminal-warning">
          This task has no configured run directory, so the agent may start in your home directory.
        </div>
      ) : null}

      {error && <div className="task-terminal-error-banner">{error}</div>}
    </div>
  )
}
