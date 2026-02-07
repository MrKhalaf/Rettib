import type { WorkstreamScore } from '../../shared/types'

interface Props {
  score: WorkstreamScore
}

export function RankingExplainer({ score }: Props) {
  return (
    <div className="ranking-explainer">
      <div>
        <span className="metric-label">Priority</span>
        <strong>{score.priority_score}</strong>
      </div>
      <div>
        <span className="metric-label">Staleness</span>
        <strong>{score.staleness_score}</strong>
      </div>
      <div>
        <span className="metric-label">Penalty</span>
        <strong>{score.blocked_penalty}</strong>
      </div>
      <div>
        <span className="metric-label">Total</span>
        <strong>{score.total_score}</strong>
      </div>
    </div>
  )
}
