import type { WorkstreamListItem } from '../../shared/types'

interface Props {
  workstream: WorkstreamListItem
  rank: number
  selected: boolean
  onClick: () => void
}

function resolveStatusDot(status: WorkstreamListItem['status']): string {
  if (status === 'blocked') {
    return 'blocked'
  }

  if (status === 'waiting') {
    return 'waiting'
  }

  return 'active'
}

export function WorkstreamCard({ workstream, rank, selected, onClick }: Props) {
  const stalenessDays = Math.round(workstream.score.days_since_progress)

  return (
    <button className={`workstream-item ${selected ? 'active' : ''}`} onClick={onClick} type="button">
      <span className="ws-rank">{rank}</span>
      <div className="ws-info">
        <div className="ws-name" title={workstream.name}>
          {workstream.name}
        </div>
        <div className="ws-meta">
          <span className={`ws-dot ${resolveStatusDot(workstream.status)}`} />
          <span>P{workstream.priority}</span>
          <span>{stalenessDays}d</span>
          <span>{workstream.status}</span>
        </div>
      </div>
    </button>
  )
}
