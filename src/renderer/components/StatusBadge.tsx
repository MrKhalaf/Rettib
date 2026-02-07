import type { WorkstreamStatus } from '../../shared/types'

interface Props {
  status: WorkstreamStatus
}

const LABELS: Record<WorkstreamStatus, string> = {
  active: 'Active',
  blocked: 'Blocked',
  waiting: 'Waiting',
  done: 'Done'
}

export function StatusBadge({ status }: Props) {
  return <span className={`status-badge status-${status}`}>{LABELS[status]}</span>
}
