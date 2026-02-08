import type { WorkstreamListItem } from '../../shared/types'
import { ScoreTooltip } from './ScoreTooltip'
import { StatusBadge } from './StatusBadge'

interface Props {
  workstream: WorkstreamListItem
  rank: number
  selected: boolean
  onClick: () => void
}

function formatScore(score: number) {
  return String(Math.round(score))
}

function buildStalenessText(workstream: WorkstreamListItem): string {
  const days = `${Math.round(workstream.score.days_since_progress)}d`
  return workstream.score.staleness_basis === 'created' ? `Not started (${days} since created)` : `${days} since progress`
}

function getRankingReasons(workstream: WorkstreamListItem): { primary: string; secondary: string[] } {
  const reasons: string[] = []
  const stalenessText = buildStalenessText(workstream)

  if (workstream.score.staleness_ratio >= 1) {
    reasons.push(`Overdue (${stalenessText})`)
  } else if (workstream.score.staleness_ratio >= 0.5) {
    reasons.push(`Approaching cadence (${stalenessText})`)
  } else if (workstream.score.staleness_basis === 'created') {
    reasons.push(`Recently created (${Math.round(workstream.score.days_since_progress)}d)`)
  }

  if (workstream.score.priority_score >= 4) {
    reasons.push(`High priority (${workstream.score.priority_score})`)
  }

  if (workstream.score.blocked_penalty < 0) {
    reasons.push(`Blocked penalty (${workstream.score.blocked_penalty})`)
  }

  if (workstream.next_action) {
    reasons.push('Action-ready next step')
  }

  if (reasons.length === 0) {
    reasons.push('Composite score keeps this in focus')
  }

  return {
    primary: reasons[0],
    secondary: reasons.slice(1, 3)
  }
}

export function WorkstreamCard({ workstream, rank, selected, onClick }: Props) {
  const lastChatTitle = workstream.last_chat?.conversation_title ?? workstream.last_chat?.conversation_uuid ?? 'No linked chat yet'
  const rankingReasons = getRankingReasons(workstream)

  return (
    <button className={`workstream-card ${selected ? 'selected' : ''}`} onClick={onClick} type="button">
      <div className="workstream-card-header">
        <div className="rank">#{rank}</div>
        <h3 className="workstream-name truncate-one-line" title={workstream.name}>
          {workstream.name}
        </h3>
        <StatusBadge status={workstream.status} />
        <ScoreTooltip
          score={workstream.score}
          primaryReason={rankingReasons.primary}
          secondaryReasons={rankingReasons.secondary}
        >
          <span className="score-pill">{formatScore(workstream.score.total_score)}</span>
        </ScoreTooltip>
      </div>

      <div className="workstream-line next-action-line" title={workstream.next_action ?? 'No next action set'}>
        <span className="truncate-one-line">{workstream.next_action ?? 'No next action set'}</span>
      </div>

      <div className={`workstream-line last-chat-line ${workstream.last_chat ? '' : 'empty-line'}`} title={lastChatTitle}>
        <span className="truncate-one-line">{lastChatTitle}</span>
      </div>
    </button>
  )
}
