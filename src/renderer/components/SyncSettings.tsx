import { useMemo, useState, type FormEvent } from 'react'

import type { WorkstreamListItem } from '../../shared/types'
import { useConversations, useLinkConversation } from '../hooks/useChat'
import { useRunSync, useSyncDiagnostics, useSyncRuns, useSyncSource, useUpdateSyncPath } from '../hooks/useSync'
import { formatDateTime } from '../utils/time'

interface Props {
  workstreams: WorkstreamListItem[]
}

function parseSourcePath(config: string): string {
  try {
    const parsed = JSON.parse(config) as { path?: unknown }
    return typeof parsed.path === 'string' ? parsed.path : ''
  } catch {
    return ''
  }
}

export function SyncSettings({ workstreams }: Props) {
  const sourceQuery = useSyncSource()
  const diagnosticsQuery = useSyncDiagnostics()
  const conversationsQuery = useConversations()
  const updatePathMutation = useUpdateSyncPath()
  const runSyncMutation = useRunSync()
  const linkMutation = useLinkConversation()

  const sourceId = sourceQuery.data?.id ?? null
  const runsQuery = useSyncRuns(sourceId)

  const [pathInput, setPathInput] = useState('')
  const [selectedWorkstreamId, setSelectedWorkstreamId] = useState<number | null>(null)

  const currentPath = useMemo(() => {
    if (!sourceQuery.data) {
      return ''
    }

    return parseSourcePath(sourceQuery.data.config)
  }, [sourceQuery.data])

  const selectedId = selectedWorkstreamId ?? workstreams[0]?.id ?? null

  async function handleSavePath(event: FormEvent) {
    event.preventDefault()
    const nextPath = pathInput.trim() || currentPath
    if (!nextPath) {
      return
    }

    await updatePathMutation.mutateAsync(nextPath)
    setPathInput('')
  }

  async function handleRunSync() {
    if (!sourceId) {
      return
    }

    await runSyncMutation.mutateAsync(sourceId)
  }

  async function handleLinkConversation(conversationUuid: string) {
    if (!selectedId) {
      return
    }

    await linkMutation.mutateAsync({ workstreamId: selectedId, conversationUuid })
  }

  return (
    <section className="sync-settings">
      <header>
        <h2>Claude Code Sync</h2>
        <p>Configure session path, validate connector, and link sessions to workstreams.</p>
      </header>

      <div className="sync-grid">
        <div className="panel">
          <h3>Source</h3>
          <p>Current path: {currentPath || 'Not configured'}</p>
          <form onSubmit={handleSavePath} className="inline-form">
            <input
              placeholder="/Users/you/.claude/projects"
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
            />
            <button type="submit" disabled={updatePathMutation.isPending}>
              Save Path
            </button>
          </form>

          <div className="diagnostics">
            <strong>Diagnostics</strong>
            {diagnosticsQuery.isLoading ? (
              <p>Checking...</p>
            ) : (
              <p>
                {diagnosticsQuery.data?.exists ? 'Path reachable' : 'Path unavailable or empty'}
                {diagnosticsQuery.data?.error ? `: ${diagnosticsQuery.data.error}` : ''}
              </p>
            )}
          </div>

          <button type="button" onClick={() => void handleRunSync()} disabled={!sourceId || runSyncMutation.isPending}>
            {runSyncMutation.isPending ? 'Importing...' : 'Import Sessions'}
          </button>
        </div>

        <div className="panel">
          <h3>Recent sync runs</h3>
          <div className="sync-runs-list">
            {runsQuery.data?.map((run) => (
              <article key={run.id} className="sync-run-item">
                <strong>{run.status}</strong>
                <time>{formatDateTime(run.started_at)}</time>
                {run.details && <p>{run.details}</p>}
              </article>
            ))}
            {!runsQuery.data?.length && <p>No sync runs yet.</p>}
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>Sessions</h3>
        <label>
          Link selected session to workstream
          <select
            value={selectedId ?? ''}
            onChange={(event) => setSelectedWorkstreamId(Number(event.target.value))}
          >
            {workstreams.map((workstream) => (
              <option key={workstream.id} value={workstream.id}>
                {workstream.name}
              </option>
            ))}
          </select>
        </label>

        <div className="conversations-list">
          {conversationsQuery.data?.map((conversation) => (
            <article key={conversation.conversation_uuid} className="conversation-item">
              <div>
                <strong>{conversation.title ?? conversation.conversation_uuid}</strong>
                {conversation.last_user_message && <p>{conversation.last_user_message}</p>}
                <time>{formatDateTime(conversation.chat_timestamp)}</time>
              </div>
              <button type="button" onClick={() => void handleLinkConversation(conversation.conversation_uuid)}>
                Link
              </button>
            </article>
          ))}

          {!conversationsQuery.data?.length && <p>No sessions found at current source path.</p>}
        </div>
      </div>
    </section>
  )
}
