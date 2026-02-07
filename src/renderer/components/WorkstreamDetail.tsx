import { useMemo, useState, type FormEvent } from 'react'

import type { TaskStatus } from '../../shared/types'
import { useUnlinkConversation } from '../hooks/useChat'
import { useCreateTask, useUpdateTask } from '../hooks/useTasks'
import { useWorkstreamDetail } from '../hooks/useWorkstreams'
import { formatDateTime } from '../utils/time'
import { TaskCard } from './TaskCard'
import { StatusBadge } from './StatusBadge'

interface Props {
  workstreamId: number | null
}

export function WorkstreamDetail({ workstreamId }: Props) {
  const [newTaskTitle, setNewTaskTitle] = useState('')

  const detailQuery = useWorkstreamDetail(workstreamId)
  const unlinkMutation = useUnlinkConversation()
  const createTaskMutation = useCreateTask(workstreamId ?? 0)
  const updateTaskMutation = useUpdateTask(workstreamId ?? 0)

  const detail = detailQuery.data

  const nextTask = useMemo(() => {
    if (!detail) {
      return null
    }

    return detail.tasks.find((task) => task.status !== 'done') ?? null
  }, [detail])

  const nextActionText = detail?.workstream.next_action ?? null
  const noteLines = detail?.workstream.notes?.split('\n').filter((line) => line.trim().length > 0) ?? []

  if (workstreamId === null) {
    return (
      <section className="detail-pane empty-detail">
        <h2>Select a workstream</h2>
        <p>Pick a workstream from the ranked list to inspect tasks, progress updates, and linked chats.</p>
      </section>
    )
  }

  if (detailQuery.isLoading) {
    return (
      <section className="detail-pane">
        <p>Loading workstream details...</p>
      </section>
    )
  }

  if (!detail) {
    return (
      <section className="detail-pane">
        <p>Workstream not found.</p>
      </section>
    )
  }

  async function handleCreateTask(event: FormEvent) {
    event.preventDefault()
    if (!newTaskTitle.trim() || workstreamId === null) {
      return
    }

    await createTaskMutation.mutateAsync(newTaskTitle.trim())
    setNewTaskTitle('')
  }

  function handleSetTaskStatus(taskId: number, status: TaskStatus) {
    if (workstreamId === null) {
      return
    }

    updateTaskMutation.mutate({ id: taskId, data: { status } })
  }

  async function handleUnlink(conversationUuid: string) {
    if (workstreamId === null) {
      return
    }

    await unlinkMutation.mutateAsync({ workstreamId, conversationUuid })
  }

  return (
    <section className="detail-pane">
      <header className="detail-header">
        <div>
          <h2>{detail.workstream.name}</h2>
          <p>{detail.workstream.ranking_explanation}</p>
        </div>
        <StatusBadge status={detail.workstream.status} />
      </header>

      <div className="detail-section emphasis">
        <h3>Next action</h3>
        {nextActionText ? <p>{nextActionText}</p> : nextTask ? <p>{nextTask.title}</p> : <p>No active tasks. Add one below.</p>}
      </div>

      <div className="detail-section">
        <h3>Context & links</h3>
        {noteLines.length > 0 ? (
          <ul className="notes-list">
            {noteLines.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        ) : (
          <p>No notes yet.</p>
        )}
      </div>

      <div className="detail-section">
        <h3>Tasks</h3>
        <form className="task-create" onSubmit={handleCreateTask}>
          <input
            value={newTaskTitle}
            onChange={(event) => setNewTaskTitle(event.target.value)}
            placeholder="Add task"
            required
          />
          <button type="submit" disabled={createTaskMutation.isPending}>
            Add
          </button>
        </form>

        <div className="task-list">
          {detail.tasks.map((task) => (
            <TaskCard key={task.id} task={task} onSetStatus={handleSetTaskStatus} />
          ))}
          {detail.tasks.length === 0 && <p>No tasks yet.</p>}
        </div>
      </div>

      <div className="detail-section">
        <h3>Recent progress</h3>
        <div className="progress-list">
          {detail.progress.map((update) => (
            <article key={update.id} className="progress-item">
              <p>{update.note}</p>
              <time>{formatDateTime(update.created_at)}</time>
            </article>
          ))}
          {detail.progress.length === 0 && <p>No progress updates yet.</p>}
        </div>
      </div>

      <div className="detail-section">
        <h3>Linked Claude chats</h3>
        <div className="chat-list">
          {detail.chats.map((chat) => (
            <article key={`${chat.workstream_id}-${chat.conversation_uuid}`} className="chat-item">
              <div>
                <strong>{chat.conversation_title ?? chat.conversation_uuid}</strong>
                {chat.last_user_message && <p>{chat.last_user_message}</p>}
                <time>{formatDateTime(chat.chat_timestamp ?? chat.linked_at)}</time>
              </div>
              <button type="button" onClick={() => void handleUnlink(chat.conversation_uuid)}>
                Unlink
              </button>
            </article>
          ))}
          {detail.chats.length === 0 && <p>No linked chats.</p>}
        </div>
      </div>
    </section>
  )
}
