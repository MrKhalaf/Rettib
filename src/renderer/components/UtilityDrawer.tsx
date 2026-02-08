import { useEffect, type ReactNode } from 'react'

interface Props {
  open: boolean
  title: string
  children: ReactNode
  onClose: () => void
}

export function UtilityDrawer({ open, title, children, onClose }: Props) {
  useEffect(() => {
    if (!open) {
      return
    }

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [open, onClose])

  if (!open) {
    return null
  }

  return (
    <div className="utility-drawer-overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <aside className="utility-drawer" onClick={(event) => event.stopPropagation()}>
        <header className="utility-drawer-header">
          <h2>{title}</h2>
          <button type="button" className="utility-drawer-close" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="utility-drawer-content">{children}</div>
      </aside>
    </div>
  )
}
