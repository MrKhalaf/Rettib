import type { Workstream, WorkstreamListItem, WorkstreamScore, WorkstreamWithScore } from '../shared/types'
import { getLatestChatReference, getWorkstreamChatSession, listWorkstreams } from './database'

function safeCadence(cadence: number): number {
  return Math.max(1, cadence)
}

function resolveStalenessReference(
  workstream: Workstream,
  db: Parameters<typeof listWorkstreams>[0]
): { basis: WorkstreamScore['staleness_basis']; at: number } {
  const latestChat = getLatestChatReference(workstream.id, db)
  const latestSession = getWorkstreamChatSession(workstream.id, db)

  const candidates: Array<{ basis: WorkstreamScore['staleness_basis']; at: number }> = []

  if (typeof workstream.last_progress_at === 'number') {
    candidates.push({ basis: 'progress', at: workstream.last_progress_at })
  }

  const latestChatAt = latestChat ? (latestChat.chat_timestamp ?? latestChat.linked_at) : null
  if (typeof latestChatAt === 'number') {
    candidates.push({ basis: 'chat', at: latestChatAt })
  }

  if (typeof latestSession?.updated_at === 'number') {
    candidates.push({ basis: 'session', at: latestSession.updated_at })
  }

  candidates.push({ basis: 'created', at: workstream.created_at })

  return candidates.reduce((latest, current) => (current.at > latest.at ? current : latest))
}

export function calculateWorkstreamScore(
  workstream: Workstream,
  now = Date.now(),
  stalenessBasis: WorkstreamScore['staleness_basis'] = workstream.last_progress_at ? 'progress' : 'created',
  stalenessReferenceAt = workstream.last_progress_at ?? workstream.created_at
): WorkstreamScore {
  const priorityScore = workstream.priority * 20

  const daysSinceProgress = Math.max(0, (now - stalenessReferenceAt) / 86_400_000)

  const stalenessRatio = daysSinceProgress / safeCadence(workstream.target_cadence_days)
  const stalenessScore = Math.min(stalenessRatio, 3) * 30
  const blockedPenalty = workstream.status === 'blocked' ? -25 : 0

  return {
    priority_score: Number(priorityScore.toFixed(2)),
    staleness_ratio: Number(stalenessRatio.toFixed(2)),
    staleness_score: Number(stalenessScore.toFixed(2)),
    blocked_penalty: blockedPenalty,
    total_score: Number((priorityScore + stalenessScore + blockedPenalty).toFixed(2)),
    days_since_progress: Number(daysSinceProgress.toFixed(2)),
    staleness_basis: stalenessBasis,
    staleness_reference_at: stalenessReferenceAt
  }
}

export function getRankingExplanation(score: WorkstreamScore): string {
  const staleText = (() => {
    if (score.staleness_basis === 'created') {
      return `not started (${score.days_since_progress}d since created)`
    }

    if (score.staleness_basis === 'chat') {
      return `${score.days_since_progress}d since chat activity`
    }

    if (score.staleness_basis === 'session') {
      return `${score.days_since_progress}d since session activity`
    }

    return `${score.days_since_progress}d since progress`
  })()
  const penaltyText = score.blocked_penalty === 0 ? '' : `, blocked ${score.blocked_penalty}`
  return `priority ${score.priority_score} + staleness ${score.staleness_score} (${staleText}${penaltyText})`
}

export function calculateRankings(db: Parameters<typeof listWorkstreams>[0], now = Date.now()): WorkstreamWithScore[] {
  const workstreams = listWorkstreams(db)

  return workstreams
    .map((workstream) => {
      const stalenessReference = resolveStalenessReference(workstream, db)
      const score = calculateWorkstreamScore(workstream, now, stalenessReference.basis, stalenessReference.at)
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

      return a.score.staleness_reference_at - b.score.staleness_reference_at
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
