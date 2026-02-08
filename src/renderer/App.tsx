import { useEffect, useMemo, useState } from 'react'

import type { CreateWorkstreamInput } from '../shared/types'
import { Dashboard } from './components/Dashboard'
import { QuickCapture } from './components/QuickCapture'
import { SyncSettings } from './components/SyncSettings'
import { UtilityDrawer } from './components/UtilityDrawer'
import { WorkstreamDetail } from './components/WorkstreamDetail'
import { useLogProgress } from './hooks/useProgress'
import { useCreateWorkstream, useWorkstreams } from './hooks/useWorkstreams'

export default function App() {
  const [selectedWorkstreamId, setSelectedWorkstreamId] = useState<number | null>(null)
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false)
  const [syncDrawerOpen, setSyncDrawerOpen] = useState(false)

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

      if (event.key === 'Escape') {
        setSyncDrawerOpen(false)
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
      <main className="app-main">
        <Dashboard
          workstreams={workstreams}
          isLoading={workstreamsQuery.isLoading}
          errorMessage={workstreamsError}
          selectedWorkstreamId={selectedWorkstreamId}
          onSelectWorkstream={setSelectedWorkstreamId}
          onCreateWorkstream={handleCreateWorkstream}
          onOpenQuickCapture={() => setQuickCaptureOpen(true)}
          onOpenSync={() => setSyncDrawerOpen(true)}
        />
        <WorkstreamDetail workstreamId={selectedWorkstreamId} />
      </main>

      <UtilityDrawer open={syncDrawerOpen} title="Sync" onClose={() => setSyncDrawerOpen(false)}>
        <SyncSettings workstreams={workstreams} />
      </UtilityDrawer>

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
