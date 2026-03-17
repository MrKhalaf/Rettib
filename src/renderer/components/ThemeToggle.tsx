import type { CSSProperties } from 'react'

export type Theme = 'original' | 'horizon' | 'neon' | 'ember'

interface Props {
  theme: Theme
  onChange: (theme: Theme) => void
}

const THEMES: { id: Theme; label: string; accent: string }[] = [
  { id: 'original', label: 'Original', accent: '#c9a04e' },
  { id: 'horizon', label: 'Horizon', accent: '#3fc1c9' },
  { id: 'neon', label: 'Neon', accent: '#00ff88' },
  { id: 'ember', label: 'Ember', accent: '#d4915c' }
]

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

function buttonStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    border: 'none',
    borderRadius: 14,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    fontFamily: 'inherit',
    color: active ? '#fff' : 'rgba(255, 255, 255, 0.55)',
    background: active ? 'rgba(255, 255, 255, 0.12)' : 'transparent',
    transition: 'all 0.15s ease'
  }
}

function dotStyle(accent: string): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: accent,
    flexShrink: 0
  }
}

export function ThemeToggle({ theme, onChange }: Props) {
  return (
    <div style={containerStyle}>
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          style={buttonStyle(theme === t.id)}
          onClick={() => onChange(t.id)}
          title={t.label}
        >
          <span style={dotStyle(t.accent)} />
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  )
}
