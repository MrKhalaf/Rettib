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
}

const STATUS_OPTIONS: WorkstreamStatus[] = ['active', 'blocked', 'waiting', 'done']

export function Dashboard({
  workstreams,
  isLoading,
  errorMessage,
  selectedWorkstreamId,
  onSelectWorkstream,
  onCreateWorkstream,
  onOpenQuickCapture
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
    <section className="dashboard-pane">
      <header className="dashboard-header">
        <div>
          <h1>Workstreams</h1>
          <p>Priority + staleness ranked queue</p>
        </div>
        <div className="dashboard-actions">
          <button type="button" onClick={onOpenQuickCapture}>
            Quick Capture
          </button>
          <button type="button" onClick={() => setCreating((current) => !current)}>
            {creating ? 'Cancel' : '+ New Workstream'}
          </button>
        </div>
      </header>

      {creating && (
        <form className="create-workstream" onSubmit={handleCreate}>
          <input
            placeholder="Workstream name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
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
            Cadence (days)
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
          <button type="submit">Create</button>
        </form>
      )}

      {isLoading ? <p>Loading...</p> : null}

      {errorMessage ? (
        <div className="error-state">
          <p>{errorMessage}</p>
        </div>
      ) : null}

      {!isLoading && workstreams.length === 0 ? (
        <div className="empty-state">
          <p>No workstreams yet. Create your first workstream to start ranking.</p>
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
    </section>
  )
}
