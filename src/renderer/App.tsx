import { useEffect, useMemo, useState } from 'react'

import type { CreateWorkstreamInput } from '../shared/types'
import { Dashboard } from './components/Dashboard'
import { QuickCapture } from './components/QuickCapture'
import { SyncSettings } from './components/SyncSettings'
import { WorkstreamDetail } from './components/WorkstreamDetail'
import { useLogProgress } from './hooks/useProgress'
import { useCreateWorkstream, useWorkstreams } from './hooks/useWorkstreams'

export default function App() {
  const [activeView, setActiveView] = useState<'dashboard' | 'sync'>('dashboard')
  const [selectedWorkstreamId, setSelectedWorkstreamId] = useState<number | null>(null)
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false)

  const workstreamsQuery = useWorkstreams()
  const createWorkstreamMutation = useCreateWorkstream()
  const logProgressMutation = useLogProgress()

  const workstreams = useMemo(() => workstreamsQuery.data ?? [], [workstreamsQuery.data])
  const workstreamsError =
    workstreamsQuery.error instanceof Error ? workstreamsQuery.error.message : workstreamsQuery.error ? 'Failed to load workstreams' : null

  useEffect(() => {
    if (selectedWorkstreamId === null && workstreams.length > 0) {
      setSelectedWorkstreamId(workstreams[0].id)
    }
  }, [selectedWorkstreamId, workstreams])

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setQuickCaptureOpen(true)
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [])

  async function handleCreateWorkstream(payload: CreateWorkstreamInput) {
    const created = await createWorkstreamMutation.mutateAsync(payload)
    setSelectedWorkstreamId(created.id)
  }

  async function handleQuickCapture(workstreamId: number, note: string) {
    await logProgressMutation.mutateAsync({ workstreamId, note })
    setSelectedWorkstreamId(workstreamId)
  }

  return (
    <div className="app-shell">
      <header className="top-nav">
        <div className="brand">
          <img src="/rettib-logo.svg" alt="Rettib logo" className="brand-logo" />
          <h1>Rettib</h1>
        </div>
        <nav>
          <button
            type="button"
            className={activeView === 'dashboard' ? 'active' : ''}
            onClick={() => setActiveView('dashboard')}
          >
            Dashboard
          </button>
          <button
            type="button"
            className={activeView === 'sync' ? 'active' : ''}
            onClick={() => setActiveView('sync')}
          >
            Sync
          </button>
        </nav>
      </header>

      {activeView === 'dashboard' ? (
        <main className="main-layout">
          <Dashboard
            workstreams={workstreams}
            isLoading={workstreamsQuery.isLoading}
            errorMessage={workstreamsError}
            selectedWorkstreamId={selectedWorkstreamId}
            onSelectWorkstream={setSelectedWorkstreamId}
            onCreateWorkstream={handleCreateWorkstream}
            onOpenQuickCapture={() => setQuickCaptureOpen(true)}
          />
          <WorkstreamDetail workstreamId={selectedWorkstreamId} />
        </main>
      ) : (
        <main className="sync-layout">
          <SyncSettings workstreams={workstreams} />
        </main>
      )}

      <QuickCapture
        open={quickCaptureOpen}
        workstreams={workstreams}
        isSubmitting={logProgressMutation.isPending}
        onClose={() => setQuickCaptureOpen(false)}
        onSubmit={handleQuickCapture}
      />
    </div>
  )
}
