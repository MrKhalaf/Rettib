import type { CSSProperties } from 'react'

const THEMES = [
  { id: 'original', label: 'Original', accent: '#c9a04e' },
  { id: 'horizon', label: 'Horizon', accent: '#58a6ff' },
  { id: 'neon', label: 'Neon', accent: '#00ff88' },
  { id: 'ember', label: 'Ember', accent: '#d4915c' }
] as const

export type Theme = (typeof THEMES)[number]['id']

interface Props {
  theme: Theme
  onChange: (theme: Theme) => void
}

const containerStyle: CSSProperties = {
  position: 'fixed',
  bottom: 16,
  right: 16,
  zIndex: 9999,
  display: 'flex',
  gap: 4,
  alignItems: 'center',
  background: 'rgba(30, 30, 30, 0.85)',
  backdropFilter: 'blur(12px)',
  borderRadius: 20,
  padding: '4px 6px',
  boxShadow: '0 2px 12px rgba(0, 0, 0, 0.4)',
  border: '1px solid rgba(255, 255, 255, 0.08)'
}

const buttonStyles = {
  active: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    border: 'none',
    borderRadius: 14,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'inherit',
    color: '#fff',
    background: 'rgba(255, 255, 255, 0.12)',
    transition: 'all 0.15s ease'
  } as CSSProperties,
  inactive: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    border: 'none',
    borderRadius: 14,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 400,
    fontFamily: 'inherit',
    color: 'rgba(255, 255, 255, 0.55)',
    background: 'transparent',
    transition: 'all 0.15s ease'
  } as CSSProperties
}

const dotStyles: Record<Theme, CSSProperties> = Object.fromEntries(
  THEMES.map((t) => [
    t.id,
    {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: t.accent,
      flexShrink: 0
    } as CSSProperties
  ])
) as Record<Theme, CSSProperties>

export function ThemeToggle({ theme, onChange }: Props) {
  return (
    <div style={containerStyle}>
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          style={theme === t.id ? buttonStyles.active : buttonStyles.inactive}
          onClick={() => onChange(t.id)}
          title={t.label}
        >
          <span style={dotStyles[t.id]} />
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  )
}
