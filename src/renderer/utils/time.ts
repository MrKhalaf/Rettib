export function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) {
    return 'Never'
  }

  const now = Date.now()
  const diffMs = now - timestamp
  const diffMinutes = Math.floor(diffMs / 60_000)

  if (diffMinutes < 1) {
    return 'Just now'
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours}h ago`
  }

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) {
    return `${diffDays}d ago`
  }

  return new Date(timestamp).toLocaleDateString()
}

export function formatDateTime(timestamp: number | null): string {
  if (!timestamp) {
    return 'Never'
  }

  return new Date(timestamp).toLocaleString()
}
