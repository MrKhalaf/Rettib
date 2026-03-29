import { useCallback, useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

import type { Task } from '../../shared/types'
import { getElectronApi } from '../api/electron-api'
import { useTaskTerminal } from '../hooks/useTerminal'

interface Props {
  task: Task | null
  workstreamId: number | null
  projectName: string | null
}

const RESIZE_DEBOUNCE_MS = 60

export function TaskTerminalView({ task, workstreamId, projectName }: Props) {
  const { isRunning, error, output, start, stop, sendInput, resize, saveScroll } = useTaskTerminal(
    task?.id ?? null,
    workstreamId
  )

  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const outputLengthRef = useRef(0)
  const taskIdRef = useRef<number | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Initialize xterm once
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new Terminal({
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      convertEol: true,
      cursorBlink: true,
      scrollback: 10_000,
      theme: {
        background: '#0f1116',
        foreground: '#cfd7e6',
        cursor: '#d9c6a0',
        selectionBackground: '#283147'
      }
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    resize(terminal.cols, terminal.rows)

    const dataDisposable = terminal.onData((data) => {
      sendInput(data)
    })

    const scrollDisposable = terminal.onScroll(() => {
      const viewport = terminal.buffer.active
      const atBottom = viewport.baseY + terminal.rows >= viewport.length
      saveScroll(atBottom ? -1 : viewport.viewportY)
    })

    let resizeObserver: ResizeObserver | null = null
    if (typeof window.ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = setTimeout(() => {
          if (!fitAddonRef.current || !terminalRef.current) return
          fitAddonRef.current.fit()
          resize(terminalRef.current.cols, terminalRef.current.rows)
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

  // Handle output + task switches
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    const currentTaskId = task?.id ?? null

    if (taskIdRef.current !== currentTaskId) {
      taskIdRef.current = currentTaskId
      terminal.reset()
      if (output) terminal.write(output)
      outputLengthRef.current = output.length
      return
    }

    if (output.length < outputLengthRef.current) {
      terminal.reset()
      terminal.write(output)
      outputLengthRef.current = output.length
      return
    }

    if (output.length === outputLengthRef.current) return

    const delta = output.slice(outputLengthRef.current)
    terminal.write(delta)
    outputLengthRef.current = output.length
  }, [output, task?.id])

  if (!task) {
    return (
      <div className="terminal-view-empty">
        <p>Select a task to run an agent</p>
      </div>
    )
  }

  return (
    <div className="terminal-view">
      <header className="terminal-view-header">
        <div className="terminal-view-info">
          <h2 className="terminal-view-title">{task.title}</h2>
          {projectName && <span className="terminal-view-project">{projectName}</span>}
        </div>
        <div className="terminal-view-controls">
          <span className={`terminal-view-status ${isRunning ? 'active' : ''}`}>
            {isRunning ? 'Running' : 'Ready'}
          </span>
          {isRunning ? (
            <button type="button" className="tv-btn tv-btn-stop" onClick={stop}>Stop</button>
          ) : (
            <button
              type="button"
              className="tv-btn tv-btn-run"
              onClick={() => start(task.command_mode ?? 'claude')}
            >
              Run Agent
            </button>
          )}
        </div>
      </header>

      <div className="terminal-view-surface" ref={containerRef} />

      {error && <div className="terminal-view-error">{error}</div>}
    </div>
  )
}
