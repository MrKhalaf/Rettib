import type { WorkstreamListItem } from '../../shared/types'
import { formatRelativeTime } from '../utils/time'
import { RankingExplainer } from './RankingExplainer'
import { StatusBadge } from './StatusBadge'

interface Props {
  workstream: WorkstreamListItem
  rank: number
  selected: boolean
  onClick: () => void
}

export function WorkstreamCard({ workstream, rank, selected, onClick }: Props) {
  return (
    <button className={`workstream-card ${selected ? 'selected' : ''}`} onClick={onClick} type="button">
      <div className="workstream-card-header">
        <div className="rank">#{rank}</div>
        <div className="workstream-title-wrap">
          <h3>{workstream.name}</h3>
          <StatusBadge status={workstream.status} />
        </div>
        <div className="score-pill">{workstream.score.total_score}</div>
      </div>

      <p className="ranking-why">{workstream.ranking_explanation}</p>
      <RankingExplainer score={workstream.score} />

      <div className="workstream-meta">
        <span>Cadence: every {workstream.target_cadence_days}d</span>
        <span>Last progress: {formatRelativeTime(workstream.last_progress_at)}</span>
      </div>

      {workstream.next_action && (
        <div className="next-action">
          <span className="next-action-label">Next Action</span>
          <span>{workstream.next_action}</span>
        </div>
      )}

      {workstream.last_chat && (
        <div className="last-chat">
          <span className="last-chat-label">Last Claude chat</span>
          <span className="last-chat-title">
            {workstream.last_chat.conversation_title ?? workstream.last_chat.conversation_uuid}
          </span>
          {workstream.last_chat.last_user_message && (
            <span className="last-chat-message">{workstream.last_chat.last_user_message}</span>
          )}
        </div>
      )}
    </button>
  )
}
