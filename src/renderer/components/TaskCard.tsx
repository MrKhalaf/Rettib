import type { Task } from '../../shared/types'

interface Props {
  task: Task
  onStart: (taskId: number) => void
  onComplete: (taskId: number) => void
  onDelete: (taskId: number) => void
}

export function TaskCard({ task, onStart, onComplete, onDelete }: Props) {
  const isInProgress = task.status === 'in_progress'

  return (
    <div className="task-card">
      <div>
        <strong>{task.title}</strong>
        <p>{isInProgress ? 'In progress' : 'Queued'}</p>
      </div>
      <div className="task-card-actions">
        {!isInProgress && (
          <button type="button" onClick={() => onStart(task.id)}>
            Start
          </button>
        )}
        <button type="button" className="task-complete" onClick={() => onComplete(task.id)}>
          Done
        </button>
        <button type="button" className="task-delete" onClick={() => onDelete(task.id)}>
          Remove
        </button>
      </div>
    </div>
  )
}
