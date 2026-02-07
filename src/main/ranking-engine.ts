import type { Workstream, WorkstreamListItem, WorkstreamScore, WorkstreamWithScore } from '../shared/types'
import { getLatestChatReference, listWorkstreams } from './database'

function safeCadence(cadence: number): number {
  return Math.max(1, cadence)
}

export function calculateWorkstreamScore(workstream: Workstream, now = Date.now()): WorkstreamScore {
  const priorityScore = workstream.priority * 20

  const daysSinceProgress = workstream.last_progress_at
    ? (now - workstream.last_progress_at) / 86_400_000
    : 999

  const stalenessRatio = daysSinceProgress / safeCadence(workstream.target_cadence_days)
  const stalenessScore = Math.min(stalenessRatio, 3) * 30
  const blockedPenalty = workstream.status === 'blocked' ? -25 : 0

  return {
    priority_score: Number(priorityScore.toFixed(2)),
    staleness_ratio: Number(stalenessRatio.toFixed(2)),
    staleness_score: Number(stalenessScore.toFixed(2)),
    blocked_penalty: blockedPenalty,
    total_score: Number((priorityScore + stalenessScore + blockedPenalty).toFixed(2)),
    days_since_progress: Number(daysSinceProgress.toFixed(2))
  }
}

export function getRankingExplanation(score: WorkstreamScore): string {
  const staleText = score.days_since_progress >= 999 ? 'never updated' : `${score.days_since_progress}d since progress`
  const penaltyText = score.blocked_penalty === 0 ? '' : `, blocked ${score.blocked_penalty}`
  return `priority ${score.priority_score} + staleness ${score.staleness_score} (${staleText}${penaltyText})`
}

export function calculateRankings(db: Parameters<typeof listWorkstreams>[0], now = Date.now()): WorkstreamWithScore[] {
  const workstreams = listWorkstreams(db)

  return workstreams
    .map((workstream) => {
      const score = calculateWorkstreamScore(workstream, now)
      return {
        ...workstream,
        score,
        ranking_explanation: getRankingExplanation(score)
      }
    })
    .sort((a, b) => {
      if (b.score.total_score !== a.score.total_score) {
        return b.score.total_score - a.score.total_score
      }

      if (b.priority !== a.priority) {
        return b.priority - a.priority
      }

      return (a.last_progress_at ?? 0) - (b.last_progress_at ?? 0)
    })
}

export function calculateRankingsWithChat(
  db: Parameters<typeof listWorkstreams>[0],
  now = Date.now()
): WorkstreamListItem[] {
  return calculateRankings(db, now).map((workstream) => ({
    ...workstream,
    last_chat: getLatestChatReference(workstream.id, db)
  }))
}
