import { useCallback, useRef, useState } from 'react'

import type { Task, TerminalSessionState, WorkstreamListItem } from '../../shared/types'
import { useCreateTask, useDeleteTask, useTasks, useUpdateTask } from '../hooks/useTasks'

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
      <button type="button" className="project-header" onClick={onToggle}>
        <span className="project-arrow">{expanded ? '▾' : '▸'}</span>
        <span className="project-name">{workstream.name}</span>
        <span className="project-meta">
          <span className="project-priority">P{workstream.priority}</span>
          <span className="project-staleness">{formatStaleness(staleDays)}</span>
        </span>
      </button>

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
