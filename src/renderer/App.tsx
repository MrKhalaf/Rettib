import { useEffect, useMemo, useState } from 'react'

import type { CreateWorkstreamInput } from '../shared/types'
import { Dashboard } from './components/Dashboard'
import { QuickCapture } from './components/QuickCapture'
import { WorkstreamDetail } from './components/WorkstreamDetail'
import { useLogProgress } from './hooks/useProgress'
import { useCreateWorkstream, useWorkstreams } from './hooks/useWorkstreams'

export default function App() {
  const [selectedWorkstreamId, setSelectedWorkstreamId] = useState<number | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false)

  const workstreamsQuery = useWorkstreams()
  const createWorkstreamMutation = useCreateWorkstream()
  const logProgressMutation = useLogProgress()

  const workstreams = useMemo(() => workstreamsQuery.data ?? [], [workstreamsQuery.data])
  const archivedCount = useMemo(() => workstreams.filter((workstream) => workstream.status === 'done').length, [workstreams])
  const visibleWorkstreams = useMemo(
    () => (showArchived ? workstreams : workstreams.filter((workstream) => workstream.status !== 'done')),
    [workstreams, showArchived]
  )
  const workstreamsError =
    workstreamsQuery.error instanceof Error ? workstreamsQuery.error.message : workstreamsQuery.error ? 'Failed to load workstreams' : null

  useEffect(() => {
    if (visibleWorkstreams.length === 0) {
      if (selectedWorkstreamId !== null) {
        setSelectedWorkstreamId(null)
      }
      return
    }

    if (selectedWorkstreamId !== null && visibleWorkstreams.some((workstream) => workstream.id === selectedWorkstreamId)) {
      return
    }

    setSelectedWorkstreamId(visibleWorkstreams[0].id)
  }, [selectedWorkstreamId, visibleWorkstreams])

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
      <main className="app-main">
        <Dashboard
          workstreams={visibleWorkstreams}
          archivedCount={archivedCount}
          showArchived={showArchived}
          isLoading={workstreamsQuery.isLoading}
          errorMessage={workstreamsError}
          selectedWorkstreamId={selectedWorkstreamId}
          onSelectWorkstream={setSelectedWorkstreamId}
          onCreateWorkstream={handleCreateWorkstream}
          onOpenQuickCapture={() => setQuickCaptureOpen(true)}
          onToggleShowArchived={() => setShowArchived((current) => !current)}
        />
        <WorkstreamDetail workstreamId={selectedWorkstreamId} />
      </main>

      <QuickCapture
        open={quickCaptureOpen}
        workstreams={visibleWorkstreams}
        isSubmitting={logProgressMutation.isPending}
        onClose={() => setQuickCaptureOpen(false)}
        onSubmit={handleQuickCapture}
      />
    </div>
  )
}
