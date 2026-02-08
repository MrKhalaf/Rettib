import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'

import { appApi } from '../api/app'
import { useConversations, useLinkConversation, useUnlinkConversation } from '../hooks/useChat'
import { useRunSync, useSyncDiagnostics, useSyncSource } from '../hooks/useSync'
import { useCreateTask, useDeleteTask, useUpdateTask } from '../hooks/useTasks'
import { useUpdateWorkstream, useWorkstreamDetail } from '../hooks/useWorkstreams'
import { formatDateTime } from '../utils/time'
import { StatusBadge } from './StatusBadge'
import { TaskCard } from './TaskCard'

interface Props {
  workstreamId: number | null
}

interface NotePart {
  kind: 'text' | 'link'
  value: string
  target?: string
}

function parseSourcePath(config: string): string {
  try {
    const parsed = JSON.parse(config) as { path?: unknown }
    return typeof parsed.path === 'string' ? parsed.path : ''
  } catch {
    return ''
  }
}

function parseObsidianNoteLine(line: string): NotePart[] {
  const parts: NotePart[] = []
  const regex = /\[\[([^\]]+)\]\]/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ kind: 'text', value: line.slice(lastIndex, match.index) })
    }

    const linkBody = match[1].trim()
    const [rawTarget, rawLabel] = linkBody.split('|')
    const target = rawTarget.trim()
    const label = rawLabel?.trim() || target
    parts.push({ kind: 'link', value: label, target })
    lastIndex = regex.lastIndex
  }

  if (lastIndex < line.length) {
    parts.push({ kind: 'text', value: line.slice(lastIndex) })
  }

  return parts.length > 0 ? parts : [{ kind: 'text', value: line }]
}

export function WorkstreamDetail({ workstreamId }: Props) {
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [noteLinkError, setNoteLinkError] = useState<string | null>(null)
  const [isEditingNotes, setIsEditingNotes] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [priorityDraft, setPriorityDraft] = useState('')
  const [cadenceDraft, setCadenceDraft] = useState('')
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsSaved, setSettingsSaved] = useState(false)

  const detailQuery = useWorkstreamDetail(workstreamId)
  const sourceQuery = useSyncSource()
  const diagnosticsQuery = useSyncDiagnostics()
  const conversationsQuery = useConversations()
  const runSyncMutation = useRunSync()
  const linkMutation = useLinkConversation()
  const unlinkMutation = useUnlinkConversation()
  const createTaskMutation = useCreateTask(workstreamId ?? 0)
  const updateTaskMutation = useUpdateTask(workstreamId ?? 0)
  const deleteTaskMutation = useDeleteTask(workstreamId ?? 0)
  const updateSettingsMutation = useUpdateWorkstream()
  const updateNotesMutation = useUpdateWorkstream()

  const detail = detailQuery.data
  const sourceId = sourceQuery.data?.id ?? null
  const sourcePath = sourceQuery.data ? parseSourcePath(sourceQuery.data.config) : ''

  const activeTasks = useMemo(() => {
    if (!detail) {
      return []
    }

    return detail.tasks.filter((task) => task.status !== 'done')
  }, [detail])

  const nextTask = useMemo(() => {
    if (activeTasks.length === 0) {
      return null
    }

    return activeTasks.find((task) => task.status === 'in_progress') ?? activeTasks[0]
  }, [activeTasks])

  const latestChat = useMemo(() => {
    if (!detail || detail.chats.length === 0) {
      return null
    }

    return detail.chats.reduce((latest, current) => {
      const latestTimestamp = latest.chat_timestamp ?? latest.linked_at
      const currentTimestamp = current.chat_timestamp ?? current.linked_at
      return currentTimestamp > latestTimestamp ? current : latest
    })
  }, [detail])

  const linkedConversationIds = useMemo(() => {
    return new Set((detail?.chats ?? []).map((chat) => chat.conversation_uuid))
  }, [detail])

  const suggestedConversations = useMemo(() => {
    return (conversationsQuery.data ?? [])
      .filter((conversation) => !linkedConversationIds.has(conversation.conversation_uuid))
      .slice(0, 5)
  }, [conversationsQuery.data, linkedConversationIds])

  const nextActionText = detail?.workstream.next_action?.trim() || null
  const nextActionSource = nextActionText
    ? 'Source: workstream next_action'
    : nextTask
      ? 'Source: first active task'
      : 'Source: none'
  const noteLines = detail?.workstream.notes?.split('\n').filter((line) => line.trim().length > 0) ?? []

  useEffect(() => {
    if (detail && !isEditingNotes) {
      setNoteDraft(detail.workstream.notes ?? '')
    }
  }, [detail, isEditingNotes])

  useEffect(() => {
    if (!detail) {
      return
    }

    setPriorityDraft(String(detail.workstream.priority))
    setCadenceDraft(String(detail.workstream.target_cadence_days))
  }, [detail?.workstream.id, detail?.workstream.priority, detail?.workstream.target_cadence_days])

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

  function handleStartTask(taskId: number) {
    if (workstreamId === null) {
      return
    }

    updateTaskMutation.mutate({ id: taskId, data: { status: 'in_progress' } })
  }

  async function handleCompleteTask(taskId: number) {
    await deleteTaskMutation.mutateAsync(taskId)
  }

  async function handleDeleteTask(taskId: number) {
    await deleteTaskMutation.mutateAsync(taskId)
  }

  async function handleLinkConversation(conversationUuid: string) {
    if (workstreamId === null) {
      return
    }

    await linkMutation.mutateAsync({ workstreamId, conversationUuid })
  }

  async function handleUnlink(conversationUuid: string) {
    if (workstreamId === null) {
      return
    }

    await unlinkMutation.mutateAsync({ workstreamId, conversationUuid })
  }

  async function handleRunSync() {
    if (!sourceId) {
      return
    }

    await runSyncMutation.mutateAsync(sourceId)
  }

  async function handleOpenObsidianNote(noteRef: string) {
    setNoteLinkError(null)
    const result = await appApi.openObsidianNote(noteRef)
    if (!result.ok) {
      setNoteLinkError(result.error ?? `Could not open [[${noteRef}]]`)
    }
  }

  async function handleSaveNotes() {
    if (!detail) {
      return
    }

    await updateNotesMutation.mutateAsync({
      id: detail.workstream.id,
      data: {
        notes: noteDraft.trim() ? noteDraft : null
      }
    })
    setIsEditingNotes(false)
  }

  async function handleSaveWorkstreamSettings() {
    if (!detail || updateSettingsMutation.isPending) {
      return
    }

    const parsedPriority = Number(priorityDraft)
    const parsedCadence = Number(cadenceDraft)
    const nextPriority = Math.round(parsedPriority)
    const nextCadence = Math.round(parsedCadence)

    if (!Number.isFinite(parsedPriority) || nextPriority < 1 || nextPriority > 5) {
      setSettingsError('Priority must be between 1 and 5.')
      setSettingsSaved(false)
      return
    }

    if (!Number.isFinite(parsedCadence) || nextCadence < 1 || nextCadence > 365) {
      setSettingsError('Cadence must be between 1 and 365 days.')
      setSettingsSaved(false)
      return
    }

    setSettingsError(null)
    setSettingsSaved(false)

    if (
      nextPriority === detail.workstream.priority &&
      nextCadence === detail.workstream.target_cadence_days
    ) {
      return
    }

    await updateSettingsMutation.mutateAsync({
      id: detail.workstream.id,
      data: {
        priority: nextPriority,
        target_cadence_days: nextCadence
      }
    })

    setPriorityDraft(String(nextPriority))
    setCadenceDraft(String(nextCadence))
    setSettingsSaved(true)
    window.setTimeout(() => {
      setSettingsSaved(false)
    }, 1200)
  }

  function handleSettingsInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') {
      return
    }

    event.preventDefault()
    void handleSaveWorkstreamSettings()
    event.currentTarget.blur()
  }

  return (
    <section className="detail-pane">
      <header className="detail-header">
        <h2>{detail.workstream.name}</h2>
        <div className="detail-header-meta">
          <StatusBadge status={detail.workstream.status} />
          <div className="detail-queue-controls">
            <label className="detail-queue-field">
              <span>Priority</span>
              <input
                type="number"
                min={1}
                max={5}
                value={priorityDraft}
                onChange={(event) => setPriorityDraft(event.target.value)}
                onBlur={() => void handleSaveWorkstreamSettings()}
                onKeyDown={handleSettingsInputKeyDown}
              />
            </label>
            <label className="detail-queue-field">
              <span>Cadence (d)</span>
              <input
                type="number"
                min={1}
                max={365}
                value={cadenceDraft}
                onChange={(event) => setCadenceDraft(event.target.value)}
                onBlur={() => void handleSaveWorkstreamSettings()}
                onKeyDown={handleSettingsInputKeyDown}
              />
            </label>
          </div>
        </div>
      </header>
      <p className="detail-queue-hint">Affects ranking order.</p>
      {settingsError && <p className="detail-queue-error">{settingsError}</p>}
      {!settingsError && settingsSaved && <p className="detail-queue-saved">Saved</p>}

      <div className="detail-section emphasis next-action-emphasis">
        <h3>Next action</h3>
        {nextActionText ? <p>{nextActionText}</p> : nextTask ? <p>{nextTask.title}</p> : <p>No active tasks. Add one below.</p>}
        <p className="next-action-source">{nextActionSource}</p>
      </div>

      <div className="detail-section resume-context">
        <h3>Resume context</h3>
        {latestChat ? (
          <article className="resume-chat">
            <strong className="truncate-one-line" title={latestChat.conversation_title ?? latestChat.conversation_uuid}>
              {latestChat.conversation_title ?? latestChat.conversation_uuid}
            </strong>
            <p>{latestChat.last_user_message ?? 'No recent user message captured.'}</p>
            <time>{formatDateTime(latestChat.chat_timestamp ?? latestChat.linked_at)}</time>
            <p className="source-note">Source: linked Claude Desktop chat</p>
          </article>
        ) : (
          <p>No linked chat context yet.</p>
        )}
      </div>

      <div className="detail-section claude-linking">
        <h3>Claude link</h3>
        <p className="source-note">Source path: {sourcePath || 'Not configured'}</p>
        <p className="source-note">
          {diagnosticsQuery.isLoading
            ? 'Checking Claude Desktop connector...'
            : diagnosticsQuery.data?.exists
              ? 'Claude Desktop source connected'
              : 'Claude Desktop source not reachable'}
        </p>
        <button type="button" onClick={() => void handleRunSync()} disabled={!sourceId || runSyncMutation.isPending}>
          {runSyncMutation.isPending ? 'Syncing...' : 'Sync Claude now'}
        </button>

        <div className="chat-list compact-chat-list">
          {suggestedConversations.map((conversation) => (
            <article key={conversation.conversation_uuid} className="chat-item">
              <div>
                <strong>{conversation.title ?? conversation.conversation_uuid}</strong>
                {conversation.last_user_message && <p>{conversation.last_user_message}</p>}
                <time>{formatDateTime(conversation.chat_timestamp)}</time>
              </div>
              <button
                type="button"
                onClick={() => void handleLinkConversation(conversation.conversation_uuid)}
                disabled={linkMutation.isPending}
              >
                Link
              </button>
            </article>
          ))}
          {!suggestedConversations.length && <p>No unlinked recent Claude chats found.</p>}
        </div>
      </div>

      <details className="detail-collapsible" open={activeTasks.length > 0}>
        <summary>Tasks ({activeTasks.length} active)</summary>
        <div className="detail-collapsible-content">
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
            {activeTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onStart={handleStartTask}
                onComplete={(taskId) => void handleCompleteTask(taskId)}
                onDelete={(taskId) => void handleDeleteTask(taskId)}
              />
            ))}
            {activeTasks.length === 0 && <p>No active tasks. Add one above.</p>}
          </div>
        </div>
      </details>

      <details className="detail-collapsible">
        <summary>Progress timeline ({detail.progress.length})</summary>
        <div className="detail-collapsible-content">
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
      </details>

      <details className="detail-collapsible">
        <summary>Notes ({noteLines.length})</summary>
        <div className="detail-collapsible-content">
          <div className="notes-toolbar">
            {!isEditingNotes ? (
              <button type="button" className="notes-edit-toggle" onClick={() => setIsEditingNotes(true)}>
                Edit
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="notes-edit-toggle"
                  onClick={() => {
                    setNoteDraft(detail.workstream.notes ?? '')
                    setIsEditingNotes(false)
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="notes-edit-toggle notes-save-toggle"
                  onClick={() => void handleSaveNotes()}
                  disabled={updateNotesMutation.isPending}
                >
                  {updateNotesMutation.isPending ? 'Saving...' : 'Save'}
                </button>
              </>
            )}
          </div>

          {isEditingNotes ? (
            <textarea
              className="notes-editor"
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="Add notes... use [[My Note]] or [[Folder/Note|Label]]"
              rows={6}
            />
          ) : noteLines.length > 0 ? (
            <ul className="notes-list">
              {noteLines.map((line, index) => (
                <li key={`${line}-${index}`}>
                  {parseObsidianNoteLine(line).map((part, partIndex) => {
                    if (part.kind === 'link' && part.target) {
                      const target = part.target
                      return (
                        <button
                          key={`${part.value}-${partIndex}`}
                          type="button"
                          className="note-link"
                          onClick={() => void handleOpenObsidianNote(target)}
                        >
                          {part.value}
                        </button>
                      )
                    }

                    return <span key={`${part.value}-${partIndex}`}>{part.value}</span>
                  })}
                </li>
              ))}
            </ul>
          ) : (
            <p>No notes yet.</p>
          )}
          {noteLinkError && <p className="note-link-error">{noteLinkError}</p>}
        </div>
      </details>

      <details className="detail-collapsible">
        <summary>Linked Claude chats ({detail.chats.length})</summary>
        <div className="detail-collapsible-content">
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
      </details>
    </section>
  )
}
