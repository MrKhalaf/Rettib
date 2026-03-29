import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

import type { Task } from '../../shared/types'
import { useCreateTask, useDeleteTask, useTasks, useUpdateTask } from '../hooks/useTasks'
import { useTaskTerminal } from '../hooks/useTerminal'

interface Props {
  workstreamId: number
}

function TaskTerminalPane({ task, workstreamId }: { task: Task; workstreamId: number }) {
  const { isRunning, error, output, start, stop, sendInput, resize, saveScroll } = useTaskTerminal(
    task.id,
    workstreamId
  )

  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const outputLengthRef = useRef(0)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new Terminal({
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
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
        }, 60)
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
    if (!terminal) return

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
  }, [output])

  return (
    <div className="task-terminal-pane">
      <div className="task-terminal-toolbar">
        <span className={`task-terminal-status ${isRunning ? 'active' : ''}`}>
          {isRunning ? 'Running' : 'Ready'}
        </span>
        {isRunning ? (
          <button type="button" className="task-btn task-btn-stop" onClick={stop}>Stop</button>
        ) : (
          <button type="button" className="task-btn task-btn-run" onClick={() => start(task.command_mode ?? 'claude')}>
            Run
          </button>
        )}
      </div>
      <div className="task-terminal-surface" ref={containerRef} />
      {error && <p className="task-terminal-error">{error}</p>}
    </div>
  )
}

export function TaskRunnerSection({ workstreamId }: Props) {
  const tasksQuery = useTasks(workstreamId)
  const createMutation = useCreateTask(workstreamId)
  const updateMutation = useUpdateTask(workstreamId)
  const deleteMutation = useDeleteTask(workstreamId)

  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [expandedTaskId, setExpandedTaskId] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const tasks = tasksQuery.data ?? []

  const handleCreateTask = useCallback(async () => {
    const title = newTaskTitle.trim() || 'Untitled task'
    await createMutation.mutateAsync(title)
    setNewTaskTitle('')
    inputRef.current?.focus()
  }, [newTaskTitle, createMutation])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void handleCreateTask()
      }
    },
    [handleCreateTask]
  )

  return (
    <section className="info-section task-runner-section">
      <div className="info-section-header">Tasks</div>

      <div className="task-runner-list">
        {tasks.map((task) => (
          <div key={task.id} className={`task-runner-item ${expandedTaskId === task.id ? 'expanded' : ''}`}>
            <div className="task-runner-row">
              <span className={`task-runner-status-dot ${task.status}`} />
              <span className="task-runner-title">{task.title}</span>
              <div className="task-runner-actions">
                <button
                  type="button"
                  className="task-btn task-btn-expand"
                  onClick={() => setExpandedTaskId(expandedTaskId === task.id ? null : task.id)}
                  title={expandedTaskId === task.id ? 'Collapse' : 'Open terminal'}
                >
                  {expandedTaskId === task.id ? '▾' : '▸'}
                </button>
                <button
                  type="button"
                  className="task-btn task-btn-done"
                  onClick={() => updateMutation.mutate({ id: task.id, data: { status: 'done' } })}
                  title="Mark done"
                >
                  ✓
                </button>
                <button
                  type="button"
                  className="task-btn task-btn-delete"
                  onClick={() => deleteMutation.mutate(task.id)}
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </div>

            {expandedTaskId === task.id && (
              <TaskTerminalPane task={task} workstreamId={workstreamId} />
            )}
          </div>
        ))}
      </div>

      <div className="task-runner-new">
        <input
          ref={inputRef}
          type="text"
          className="task-runner-input"
          placeholder="Add a task..."
          value={newTaskTitle}
          onChange={(e) => setNewTaskTitle(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
    </section>
  )
}
