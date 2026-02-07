import type { Task, TaskStatus } from '../../shared/types'

interface Props {
  task: Task
  onSetStatus: (taskId: number, status: TaskStatus) => void
}

const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: 'in_progress',
  in_progress: 'done',
  done: 'todo'
}

export function TaskCard({ task, onSetStatus }: Props) {
  return (
    <div className="task-card">
      <div>
        <strong>{task.title}</strong>
        <p>Status: {task.status}</p>
      </div>
      <button type="button" onClick={() => onSetStatus(task.id, NEXT_STATUS[task.status])}>
        Mark {NEXT_STATUS[task.status]}
      </button>
    </div>
  )
}
