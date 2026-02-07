interface Props {
  stalenessRatio: number
  daysSinceProgress: number
  stalenessBasis: 'progress' | 'created'
}

function getStalenessTone(stalenessRatio: number): 'fresh' | 'warning' | 'overdue' {
  if (stalenessRatio >= 1) {
    return 'overdue'
  }

  if (stalenessRatio >= 0.5) {
    return 'warning'
  }

  return 'fresh'
}

export function StalenessIndicator({ stalenessRatio, daysSinceProgress, stalenessBasis }: Props) {
  const tone = getStalenessTone(stalenessRatio)
  const fillPercent = Math.min(100, Math.max(12, Math.round(stalenessRatio * 100)))
  const roundedDays = Math.round(daysSinceProgress)
  const label =
    stalenessBasis === 'created'
      ? `${roundedDays}d since created (no progress yet)`
      : `${roundedDays}d since progress`

  return (
    <span className="staleness-indicator" title={label} aria-label={label}>
      <span className={`staleness-indicator-fill staleness-${tone}`} style={{ width: `${fillPercent}%` }} />
    </span>
  )
}
