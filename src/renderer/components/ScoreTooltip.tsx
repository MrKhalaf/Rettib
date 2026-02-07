import { useEffect, useRef, useState, type ReactNode } from 'react'

import type { WorkstreamScore } from '../../shared/types'
import { RankingExplainer } from './RankingExplainer'

interface Props {
  score: WorkstreamScore
  rankingExplanation: string
  primaryReason: string
  secondaryReasons?: string[]
  children: ReactNode
}

const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 200
const MIN_TOP_SPACE = 220

export function ScoreTooltip({ score, rankingExplanation, primaryReason, secondaryReasons = [], children }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const [placement, setPlacement] = useState<'top' | 'bottom'>('top')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  function clearTimers() {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }

    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  function resolvePlacement() {
    if (!rootRef.current) {
      return
    }

    const { top } = rootRef.current.getBoundingClientRect()
    setPlacement(top < MIN_TOP_SPACE ? 'bottom' : 'top')
  }

  function handleMouseEnter() {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }

    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }

    resolvePlacement()
    openTimerRef.current = window.setTimeout(() => {
      setIsOpen(true)
      openTimerRef.current = null
    }, OPEN_DELAY_MS)
  }

  function handleMouseLeave() {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }

    closeTimerRef.current = window.setTimeout(() => {
      setIsOpen(false)
      closeTimerRef.current = null
    }, CLOSE_DELAY_MS)
  }

  useEffect(() => {
    return () => {
      clearTimers()
    }
  }, [])

  return (
    <div className="score-tooltip" ref={rootRef} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      {children}

      {isOpen && (
        <div className={`score-tooltip-popover score-tooltip-${placement}`} role="tooltip">
          <strong className="score-tooltip-reason">{primaryReason}</strong>
          {secondaryReasons.length > 0 && <p className="score-tooltip-secondary">{secondaryReasons.slice(0, 2).join(' • ')}</p>}
          <p className="source-note">Source: ranking engine (priority, cadence staleness, blocked penalty)</p>
          <RankingExplainer score={score} />
          <p className="score-tooltip-explanation">{rankingExplanation}</p>
        </div>
      )}
    </div>
  )
}
