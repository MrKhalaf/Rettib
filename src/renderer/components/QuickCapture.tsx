import { useEffect, useState, type FormEvent } from 'react'

import type { WorkstreamListItem } from '../../shared/types'

interface Props {
  open: boolean
  workstreams: WorkstreamListItem[]
  isSubmitting: boolean
  onClose: () => void
  onSubmit: (workstreamId: number, note: string) => Promise<void>
}

export function QuickCapture({ open, workstreams, isSubmitting, onClose, onSubmit }: Props) {
  const [selectedWorkstreamId, setSelectedWorkstreamId] = useState<number | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!open) {
      return
    }

    setSelectedWorkstreamId(workstreams[0]?.id ?? null)
  }, [open, workstreams])

  if (!open) {
    return null
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!selectedWorkstreamId || !note.trim()) {
      return
    }

    await onSubmit(selectedWorkstreamId, note.trim())
    setNote('')
    onClose()
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <form className="modal" onSubmit={handleSubmit}>
        <header>
          <h2>Quick Capture</h2>
          <p>Log the most recent progress update.</p>
        </header>

        <label>
          Workstream
          <select
            value={selectedWorkstreamId ?? ''}
            onChange={(event) => setSelectedWorkstreamId(Number(event.target.value))}
            required
          >
            {workstreams.map((workstream) => (
              <option key={workstream.id} value={workstream.id}>
                {workstream.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          What moved forward?
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={5}
            placeholder="Implemented X, decided Y, blocked by Z..."
            required
          />
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={isSubmitting || !selectedWorkstreamId}>
            {isSubmitting ? 'Saving...' : 'Save Update'}
          </button>
        </div>
      </form>
    </div>
  )
}
