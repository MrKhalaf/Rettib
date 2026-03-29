import { useCallback, useRef, useState } from 'react'

import type { TerminalSessionState, UpdateWorkstreamInput, WorkstreamListItem, WorkstreamStatus } from '../../shared/types'
import { useCreateTask, useDeleteTask, useTasks, useUpdateTask } from '../hooks/useTasks'
import { useUpdateWorkstream } from '../hooks/useWorkstreams'

interface Props {
  workstream: WorkstreamListItem
  expanded: boolean
  onToggle: () => void
  selectedTaskId: number | null
  activeSessions: TerminalSessionState[]
  onSelectTask: (taskId: number, workstreamId: number) => void
}

function formatStaleness(days: number): string {
  if (days < 1) return '<1d'
  return `${Math.round(days)}d`
}

function ProjectSettings({ workstream }: { workstream: WorkstreamListItem }) {
  const updateMutation = useUpdateWorkstream()

  const [name, setName] = useState(workstream.name)
  const [priority, setPriority] = useState(workstream.priority)
  const [cadence, setCadence] = useState(workstream.target_cadence_days)
  const [runDir, setRunDir] = useState(workstream.chat_run_directory ?? '')
  const [status, setStatus] = useState<WorkstreamStatus>(workstream.status)

  function save() {
    const data: UpdateWorkstreamInput = {}
    if (name !== workstream.name) data.name = name
    if (priority !== workstream.priority) data.priority = priority
    if (cadence !== workstream.target_cadence_days) data.target_cadence_days = cadence
    if (runDir !== (workstream.chat_run_directory ?? '')) data.chat_run_directory = runDir || null
    if (status !== workstream.status) data.status = status

    if (Object.keys(data).length > 0) {
      updateMutation.mutate({ id: workstream.id, data })
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      save()
    }
  }

  return (
    <div className="project-settings" onClick={(e) => e.stopPropagation()}>
      <div className="ps-row">
        <input className="ps-input ps-input-wide" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={handleKeyDown} onBlur={save} placeholder="Name" />
      </div>
      <div className="ps-row">
        <label className="ps-label">
          Priority
          <select className="ps-select" value={priority} onChange={(e) => { setPriority(Number(e.target.value)); }}>
            {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p}</option>)}
          </select>
        </label>
        <label className="ps-label">
          Cadence
          <input className="ps-input ps-input-sm" type="number" min={1} value={cadence} onChange={(e) => setCadence(Number(e.target.value))} onKeyDown={handleKeyDown} onBlur={save} />
        </label>
        <label className="ps-label">
          Status
          <select className="ps-select" value={status} onChange={(e) => { setStatus(e.target.value as WorkstreamStatus); }}>
            {(['active', 'blocked', 'waiting', 'done'] as const).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <div className="ps-row">
        <input className="ps-input ps-input-wide" value={runDir} onChange={(e) => setRunDir(e.target.value)} onKeyDown={handleKeyDown} onBlur={save} placeholder="Run directory (~/Projects/...)" />
      </div>
      <div className="ps-row ps-actions">
        <button type="button" className="ps-btn" onClick={save} disabled={updateMutation.isPending}>
          {updateMutation.isPending ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          className="ps-btn ps-btn-danger"
          onClick={() => updateMutation.mutate({ id: workstream.id, data: { status: 'done' } })}
        >
          Archive
        </button>
      </div>
    </div>
  )
}

export function ProjectFolder({
  workstream,
  expanded,
  onToggle,
  selectedTaskId,
  activeSessions,
  onSelectTask
}: Props) {
  const tasksQuery = useTasks(expanded ? workstream.id : null)
  const createMutation = useCreateTask(workstream.id)
  const updateMutation = useUpdateTask(workstream.id)
  const deleteMutation = useDeleteTask(workstream.id)

  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const tasks = tasksQuery.data ?? []

  const activeTaskIds = new Set(
    activeSessions.filter((s) => s.is_active && s.workstream_id === workstream.id).map((s) => s.task_id)
  )

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

  const staleDays = workstream.score.days_since_progress

  return (
    <div className="project-folder">
      <div className="project-header-row">
        <button type="button" className="project-header" onClick={onToggle}>
          <span className="project-arrow">{expanded ? '▾' : '▸'}</span>
          <span className="project-name">{workstream.name}</span>
          <span className="project-meta">
            <span className="project-priority">P{workstream.priority}</span>
            <span className="project-staleness">{formatStaleness(staleDays)}</span>
          </span>
        </button>
        <button
          type="button"
          className="project-menu-btn"
          onClick={(e) => { e.stopPropagation(); setShowSettings(!showSettings) }}
          title="Project settings"
        >
          ⋯
        </button>
      </div>

      {showSettings && <ProjectSettings workstream={workstream} />}

      {expanded && (
        <div className="project-tasks">
          {tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className={`task-row ${selectedTaskId === task.id ? 'selected' : ''}`}
              onClick={() => onSelectTask(task.id, workstream.id)}
            >
              <span className={`task-dot ${activeTaskIds.has(task.id) ? 'running' : task.status}`} />
              <span className="task-title">{task.title}</span>
              {activeTaskIds.has(task.id) && <span className="task-running-indicator" />}
            </button>
          ))}

          <div className="task-new-row">
            <input
              ref={inputRef}
              type="text"
              className="task-new-input"
              placeholder="Add task..."
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
        </div>
      )}
    </div>
  )
}
