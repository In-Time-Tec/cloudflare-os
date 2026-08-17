import type { ReactNode } from 'react'
import { Skeleton, SkeletonText } from '../components/Skeleton'

// Shared visual primitives for the communications surfaces (conversations, channels, email,
// calendar): avatars with photo/monogram fallback, list rows, and full-height pane headers.
// Kumo-styled and reused across the sidebar sections and detail pages.

export function monogram(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** Avatar box sizes, shared with the loading placeholder so both reserve the same space. */
const AVATAR_SIZE = {
  sm: 'size-4.5 text-[8px]',
  md: 'size-8 text-[11px]',
  lg: 'size-9 text-[12px]',
} as const

export type AvatarSize = keyof typeof AVATAR_SIZE

/** Avatar with photo when available, monogram fallback otherwise. A `title` of `undefined` is
 * still loading and renders as a circle of the same diameter. */
export function Avatar({ photo, title, size = 'md' }: {
  photo?: string
  title?: string
  size?: AvatarSize
}) {
  const classes = AVATAR_SIZE[size]
  if (title === undefined) {
    return <Skeleton className={`${classes} rounded-full`} />
  }
  return photo ? (
    <img src={photo} alt="" className={`${classes} shrink-0 rounded-full object-cover`} />
  ) : (
    <span className={`${classes} flex shrink-0 items-center justify-center rounded-full bg-kumo-elevated font-semibold text-kumo-subtle`}>
      {monogram(title)}
    </span>
  )
}

/**
 * One row in a communications list pane (conversation, channel, email).
 *
 * A row with no `title` is still loading: the same box renders with placeholder leaves, so a
 * loading list and a loaded list are the same height and a list can't jump when it resolves.
 */
export function ListRow({ selected, onClick, avatar, title, meta, preview, unread }: {
  selected?: boolean
  onClick?(): void
  avatar?: ReactNode
  title?: string
  meta?: string
  preview?: string
  unread?: boolean
}) {
  const loading = title === undefined
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      aria-hidden={loading || undefined}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
        loading ? '' : 'cursor-pointer hover:bg-kumo-elevated'
      } ${selected ? 'bg-kumo-elevated' : ''}`}
    >
      {avatar ?? <Avatar size="md" />}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <SkeletonText width="w-28"
              className={`text-[13px] ${unread ? 'font-semibold' : 'font-medium'} text-kumo-default`}>
            {title}
          </SkeletonText>
          {(meta !== undefined || loading) && (
            <SkeletonText width="w-8" className="shrink-0 text-[10.5px] text-kumo-inactive">
              {meta}
            </SkeletonText>
          )}
        </span>
        {(preview !== undefined || loading) && (
          <SkeletonText width="w-40"
              className={`text-[12px] ${unread ? 'text-kumo-subtle' : 'text-kumo-inactive'}`}>
            {preview}
          </SkeletonText>
        )}
      </span>
    </button>
  )
}

/**
 * The detail pane's header: avatar + title + subtitle + optional actions, full-width hairline.
 *
 * Always `h-14`, loading or not — it is the band the page header and (on Calendar) the day header
 * align to, so it has to hold its height before the record arrives or the body below it shifts.
 */
export function PaneHeader({ avatar, title, subtitle, actions }: {
  avatar?: ReactNode
  title?: string
  subtitle?: string
  actions?: ReactNode
}) {
  const loading = title === undefined
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-kumo-line px-4">
      {avatar ?? (loading ? <Avatar size="lg" /> : null)}
      <div className="min-w-0 flex-1">
        <SkeletonText width="w-44" className="text-[14px] font-medium text-kumo-default">
          {title}
        </SkeletonText>
        {(subtitle !== undefined || loading) && (
          <SkeletonText width="w-28" className="text-[11.5px] text-kumo-inactive">
            {subtitle}
          </SkeletonText>
        )}
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
