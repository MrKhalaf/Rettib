import { useEffect, useMemo, useState } from 'react'

import type { TerminalSessionState } from '../../shared/types'
import { terminalApi } from '../api/terminal'
import { useCreateWorkstream, useWorkstreams } from '../hooks/useWorkstreams'
import { ProjectFolder } from './ProjectFolder'
import type { Theme } from './ThemeToggle'
import { ThemeToggle } from './ThemeToggle'

interface Props {
  selectedTaskId: number | null
  onSelectTask: (taskId: number, workstreamId: number) => void
  theme: Theme
  onToggleTheme: () => void
}

export function ProjectSidebar({ selectedTaskId, onSelectTask, theme, onToggleTheme }: Props) {
  const workstreamsQuery = useWorkstreams()
  const createWorkstream = useCreateWorkstream()
  const [showArchived, setShowArchived] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [activeSessions, setActiveSessions] = useState<TerminalSessionState[]>([])

  const workstreams = useMemo(() => workstreamsQuery.data ?? [], [workstreamsQuery.data])
  const visible = useMemo(
    () => (showArchived ? workstreams : workstreams.filter((w) => w.status !== 'done')),
    [workstreams, showArchived]
  )
  const archivedCount = useMemo(
    () => workstreams.filter((w) => w.status === 'done').length,
    [workstreams]
  )

  // Auto-expand first project
  useEffect(() => {
    if (expandedIds.size === 0 && visible.length > 0) {
      setExpandedIds(new Set([visible[0].id]))
    }
  }, [visible])

  // Poll active terminal sessions
  useEffect(() => {
    let cancelled = false

    function refresh() {
      terminalApi.sessions().then((sessions) => {
        if (!cancelled) {
          setActiveSessions(sessions.filter((session) => session.is_active))
        }
      }).catch(() => {})
    }

    refresh()
    const unsubscribe = terminalApi.onEvent((event) => {
      const startedState = event.type === 'started' ? event.state : undefined

      if (startedState?.task_id !== null && startedState?.is_active) {
        setActiveSessions((current) => {
          const next = current.filter((session) => session.task_id !== startedState.task_id)
          next.push(startedState as TerminalSessionState)
          return next
        })
      }

      if ((event.type === 'stopped' || event.type === 'exit') && event.task_id !== null) {
        setActiveSessions((current) => current.filter((session) => session.task_id !== event.task_id))
      }
    })

    const interval = setInterval(refresh, 30_000)
    return () => {
      cancelled = true
      unsubscribe()
      clearInterval(interval)
    }
  }, [])

  function toggleExpanded(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  return (
    <aside className="project-sidebar">
      <header className="sidebar-brand">
        <h1 className="sidebar-logo">Rettib</h1>
      </header>

      <div className="project-list">
        <button
          type="button"
          className="new-project-btn"
          onClick={() => createWorkstream.mutate({ name: 'New Project', priority: 3, target_cadence_days: 7 })}
        >
          + New Project
        </button>

        {workstreamsQuery.isLoading && <p className="sidebar-loading">Loading...</p>}

        {visible.map((workstream) => (
          <ProjectFolder
            key={workstream.id}
            workstream={workstream}
            expanded={expandedIds.has(workstream.id)}
            onToggle={() => toggleExpanded(workstream.id)}
            selectedTaskId={selectedTaskId}
            activeSessions={activeSessions}
            onSelectTask={onSelectTask}
          />
        ))}
      </div>

      <footer className="sidebar-footer">
        {archivedCount > 0 && (
          <button
            type="button"
            className="sidebar-archive-toggle"
            onClick={() => setShowArchived((c) => !c)}
          >
            {showArchived ? 'Hide done' : `Show done (${archivedCount})`}
          </button>
        )}
        <ThemeToggle theme={theme} onChange={() => onToggleTheme()} />
      </footer>
    </aside>
  )
}
