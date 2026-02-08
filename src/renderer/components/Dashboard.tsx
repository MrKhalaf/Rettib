import { useState, type FormEvent } from 'react'

import type { CreateWorkstreamInput, WorkstreamListItem, WorkstreamStatus } from '../../shared/types'
import { WorkstreamCard } from './WorkstreamCard'

interface Props {
  workstreams: WorkstreamListItem[]
  isLoading: boolean
  errorMessage?: string | null
  selectedWorkstreamId: number | null
  onSelectWorkstream: (id: number) => void
  onCreateWorkstream: (data: CreateWorkstreamInput) => Promise<void>
  onOpenQuickCapture: () => void
  onOpenSync: () => void
}

const STATUS_OPTIONS: WorkstreamStatus[] = ['active', 'blocked', 'waiting', 'done']

export function Dashboard({
  workstreams,
  isLoading,
  errorMessage,
  selectedWorkstreamId,
  onSelectWorkstream,
  onCreateWorkstream,
  onOpenQuickCapture,
  onOpenSync
}: Props) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [priority, setPriority] = useState(3)
  const [cadence, setCadence] = useState(7)
  const [status, setStatus] = useState<WorkstreamStatus>('active')

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      return
    }

    await onCreateWorkstream({
      name: name.trim(),
      priority,
      target_cadence_days: cadence,
      status
    })

    setName('')
    setPriority(3)
    setCadence(7)
    setStatus('active')
    setCreating(false)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
          <h1>Rettib</h1>
        </div>
        <div className="sidebar-label">Workstreams</div>
      </div>

      <div className="sidebar-controls">
        <button type="button" className="sidebar-control" onClick={() => setCreating((current) => !current)}>
          {creating ? 'Cancel' : '+ New Workstream'}
        </button>
        <button type="button" className="sidebar-control" onClick={onOpenQuickCapture}>
          Quick Capture
        </button>
        <button type="button" className="sidebar-control" onClick={onOpenSync}>
          Sync
        </button>
      </div>

      {creating && (
        <form className="create-workstream" onSubmit={handleCreate}>
          <input
            placeholder="Workstream name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <div className="create-workstream-grid">
            <label>
              Priority
              <input
                type="number"
                min={1}
                max={5}
                value={priority}
                onChange={(event) => setPriority(Number(event.target.value))}
                required
              />
            </label>
            <label>
              Cadence
              <input
                type="number"
                min={1}
                value={cadence}
                onChange={(event) => setCadence(Number(event.target.value))}
                required
              />
            </label>
            <label>
              Status
              <select value={status} onChange={(event) => setStatus(event.target.value as WorkstreamStatus)}>
                {STATUS_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="submit" className="sidebar-control sidebar-control-primary">
            Create
          </button>
        </form>
      )}

      {isLoading ? <p className="sidebar-state">Loading workstreams...</p> : null}

      {errorMessage ? (
        <div className="sidebar-state sidebar-error">
          <p>{errorMessage}</p>
        </div>
      ) : null}

      {!isLoading && workstreams.length === 0 ? (
        <div className="sidebar-state sidebar-empty">
          <p>No workstreams yet. Create one to start ranking.</p>
        </div>
      ) : null}

      <div className="workstream-list">
        {workstreams.map((workstream, index) => (
          <WorkstreamCard
            key={workstream.id}
            workstream={workstream}
            rank={index + 1}
            selected={workstream.id === selectedWorkstreamId}
            onClick={() => onSelectWorkstream(workstream.id)}
          />
        ))}
      </div>
    </aside>
  )
}
