import { useCallback, useEffect, useMemo, useState } from 'react'

import { ProjectSidebar } from './components/ProjectSidebar'
import { TaskTerminalView } from './components/TaskTerminalView'
import type { Theme } from './components/ThemeToggle'
import { useTasks } from './hooks/useTasks'
import { useWorkstreams } from './hooks/useWorkstreams'

export default function App() {
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [selectedWorkstreamId, setSelectedWorkstreamId] = useState<number | null>(null)
  const [theme, setTheme] = useState<Theme>('dark')

  const workstreamsQuery = useWorkstreams()
  const workstreams = useMemo(() => workstreamsQuery.data ?? [], [workstreamsQuery.data])
  const selectedTasksQuery = useTasks(selectedWorkstreamId)
  const selectedWorkstream = useMemo(
    () => workstreams.find((workstream) => workstream.id === selectedWorkstreamId) ?? null,
    [workstreams, selectedWorkstreamId]
  )

  const selectedTask = useMemo(
    () => (selectedTasksQuery.data ?? []).find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, selectedTasksQuery.data]
  )

  // Apply theme
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.removeAttribute('data-theme')
    } else {
      document.documentElement.setAttribute('data-theme', theme)
    }
    return () => {
      document.documentElement.removeAttribute('data-theme')
    }
  }, [theme])

  useEffect(() => {
    if (selectedTaskId === null || selectedWorkstreamId === null || selectedTasksQuery.isLoading) {
      return
    }

    if ((selectedTasksQuery.data ?? []).every((task) => task.id !== selectedTaskId)) {
      setSelectedTaskId(null)
    }
  }, [selectedTaskId, selectedTasksQuery.data, selectedTasksQuery.isLoading, selectedWorkstreamId])

  const handleSelectTask = useCallback((taskId: number, workstreamId: number) => {
    setSelectedTaskId(taskId)
    setSelectedWorkstreamId(workstreamId)
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  return (
    <div className="app-shell">
      <div className="app-main">
        <ProjectSidebar
          selectedTaskId={selectedTaskId}
          onSelectTask={handleSelectTask}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        <TaskTerminalView
          key={selectedTask ? `task-terminal-${selectedTask.id}` : 'task-terminal-empty'}
          task={selectedTask}
          workstreamId={selectedWorkstreamId}
          projectName={selectedWorkstream?.name ?? null}
          projectRunDirectory={selectedWorkstream?.chat_run_directory ?? null}
        />
      </div>
    </div>
  )
}
