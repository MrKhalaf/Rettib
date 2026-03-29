import { useCallback, useEffect, useMemo, useState } from 'react'

import type { Task } from '../shared/types'
import { tasksApi } from './api/tasks'
import { ProjectSidebar } from './components/ProjectSidebar'
import { TaskTerminalView } from './components/TaskTerminalView'
import type { Theme } from './components/ThemeToggle'
import { useWorkstreams } from './hooks/useWorkstreams'

export default function App() {
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [selectedWorkstreamId, setSelectedWorkstreamId] = useState<number | null>(null)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [theme, setTheme] = useState<Theme>('dark')

  const workstreamsQuery = useWorkstreams()
  const workstreams = useMemo(() => workstreamsQuery.data ?? [], [workstreamsQuery.data])

  const selectedProjectName = useMemo(
    () => workstreams.find((w) => w.id === selectedWorkstreamId)?.name ?? null,
    [workstreams, selectedWorkstreamId]
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

  // Fetch task details when selection changes
  useEffect(() => {
    if (selectedTaskId === null) {
      setSelectedTask(null)
      return
    }

    // Fetch from the tasks list for the workstream
    if (selectedWorkstreamId !== null) {
      tasksApi.list(selectedWorkstreamId).then((tasks) => {
        const found = tasks.find((t) => t.id === selectedTaskId) ?? null
        setSelectedTask(found)
      }).catch(() => {
        setSelectedTask(null)
      })
    }
  }, [selectedTaskId, selectedWorkstreamId])

  const handleSelectTask = useCallback((taskId: number, workstreamId: number) => {
    setSelectedTaskId(taskId)
    setSelectedWorkstreamId(workstreamId)
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  return (
    <div className="app-shell">
      <ProjectSidebar
        selectedTaskId={selectedTaskId}
        onSelectTask={handleSelectTask}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <TaskTerminalView
        task={selectedTask}
        workstreamId={selectedWorkstreamId}
        projectName={selectedProjectName}
      />
    </div>
  )
}
