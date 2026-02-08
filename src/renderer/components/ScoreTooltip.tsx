import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { WorkstreamScore } from '../../shared/types'
import { RankingExplainer } from './RankingExplainer'

interface Props {
  score: WorkstreamScore
  primaryReason: string
  secondaryReasons?: string[]
  children: ReactNode
}

const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 200
const MIN_TOP_SPACE = 220
const VERTICAL_GAP_PX = 10
const HORIZONTAL_MARGIN_PX = 12
const ESTIMATED_TOOLTIP_WIDTH = 320

export function ScoreTooltip({ score, primaryReason, secondaryReasons = [], children }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const [placement, setPlacement] = useState<'top' | 'bottom'>('top')
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: 0, top: 0 })
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

    const rect = rootRef.current.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const centeredLeft = rect.left + rect.width / 2
    const clampedLeft = Math.min(
      viewportWidth - HORIZONTAL_MARGIN_PX,
      Math.max(HORIZONTAL_MARGIN_PX, centeredLeft)
    )

    setPosition({
      left: clampedLeft,
      top: rect.top
    })

    const { top } = rect
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
    function handleViewportChange() {
      if (!isOpen) {
        return
      }

      resolvePlacement()
    }

    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)

    return () => {
      clearTimers()
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [isOpen])

  const tooltip = isOpen
    ? createPortal(
        <div
          className={`score-tooltip-popover score-tooltip-${placement}`}
          role="tooltip"
          style={{
            left: `${position.left}px`,
            top: placement === 'top' ? `${position.top - VERTICAL_GAP_PX}px` : `${position.top + VERTICAL_GAP_PX}px`,
            maxWidth: `min(${ESTIMATED_TOOLTIP_WIDTH}px, calc(100vw - ${HORIZONTAL_MARGIN_PX * 2}px))`
          }}
        >
          <strong className="score-tooltip-reason">{primaryReason}</strong>
          {secondaryReasons.length > 0 && <p className="score-tooltip-secondary">{secondaryReasons.slice(0, 2).join(' • ')}</p>}
          <RankingExplainer score={score} />
        </div>,
        document.body
      )
    : null

  return (
    <div className="score-tooltip" ref={rootRef} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      {children}
      {tooltip}
    </div>
  )
}
