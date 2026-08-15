import type { ReactNode } from 'react'

// Shared visual primitives for the communications surfaces (conversations, channels, email,
// calendar): avatars with photo/monogram fallback, list rows, and full-height pane headers.
// Kumo-styled and reused across the sidebar sections and detail pages.

export function monogram(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** Avatar with photo when available, monogram fallback otherwise. */
export function Avatar({ photo, title, size = 'md' }: {
  photo?: string
  title: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const classes = {
    sm: 'size-4.5 text-[8px]',
    md: 'size-8 text-[11px]',
    lg: 'size-9 text-[12px]',
  }[size]
  return photo ? (
    <img src={photo} alt="" className={`${classes} shrink-0 rounded-full object-cover`} />
  ) : (
    <span className={`${classes} flex shrink-0 items-center justify-center rounded-full bg-kumo-elevated font-semibold text-kumo-subtle`}>
      {monogram(title)}
    </span>
  )
}

/** One row in a communications list pane (conversation, channel, email). */
export function ListRow({ selected, onClick, avatar, title, meta, preview, unread }: {
  selected?: boolean
  onClick(): void
  avatar: ReactNode
  title: string
  meta?: string
  preview?: string
  unread?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-kumo-elevated ${
        selected ? 'bg-kumo-elevated' : ''
      }`}
    >
      {avatar}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={`truncate text-[13px] ${unread ? 'font-semibold' : 'font-medium'} text-kumo-default`}>
            {title}
          </span>
          {meta && <span className="shrink-0 text-[10.5px] text-kumo-inactive">{meta}</span>}
        </span>
        {preview !== undefined && (
          <span className={`block truncate text-[12px] ${unread ? 'text-kumo-subtle' : 'text-kumo-inactive'}`}>
            {preview}
          </span>
        )}
      </span>
    </button>
  )
}

/** The detail pane's header: avatar + title + subtitle + optional actions, full-width hairline. */
export function PaneHeader({ avatar, title, subtitle, actions }: {
  avatar?: ReactNode
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-kumo-line px-4">
      {avatar}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium text-kumo-default">{title}</p>
        {subtitle && <p className="truncate text-[11.5px] text-kumo-inactive">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  )
}

export function formatTime(date: Date | undefined): string {
  if (!date) return ''
  const d = new Date(date)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
