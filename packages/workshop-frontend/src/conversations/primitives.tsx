import { Link, useMatchRoute, type LinkProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'

export function monogram(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

const AVATAR_SIZE = {
  sm: 'size-4.5 text-[8px]',
  md: 'size-8 text-[11px]',
  lg: 'size-9 text-[12px]',
} as const

export type AvatarSize = keyof typeof AVATAR_SIZE

export function Avatar({ photo, title, size = 'md' }: {
  photo?: string
  title?: string
  size?: AvatarSize
}) {
  const classes = AVATAR_SIZE[size]
  if (!title) {
    return (
      <span className={`${classes} flex shrink-0 items-center justify-center rounded-full bg-kumo-elevated font-semibold text-kumo-subtle`}>
        ?
      </span>
    )
  }
  return photo ? (
    <img src={photo} alt="" className={`${classes} shrink-0 rounded-full object-cover`} />
  ) : (
    <span className={`${classes} flex shrink-0 items-center justify-center rounded-full bg-kumo-elevated font-semibold text-kumo-subtle`}>
      {monogram(title)}
    </span>
  )
}

type ListRowProps = {
  selected?: boolean
  to?: LinkProps['to']
  search?: LinkProps['search']
  onClick?(): void
  avatar?: ReactNode
  title: string
  meta?: string
  preview?: string
  unread?: boolean
}

export function ListRow({ selected, to, search, onClick, avatar, title, meta, preview, unread }: ListRowProps) {
  const matchRoute = useMatchRoute()
  const pending = to ? !!matchRoute({ to, search, pending: true } as Parameters<typeof matchRoute>[0]) : false
  const className = `flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-kumo-elevated ${
    selected ? 'bg-kumo-elevated' : ''
  } ${pending ? 'opacity-70' : ''}`
  const body = (
    <>
      {avatar}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={`text-[13px] ${unread ? 'font-semibold' : 'font-medium'} text-kumo-default`}>
            {title}
          </span>
          {meta !== undefined && (
            <span className="shrink-0 text-[10.5px] text-kumo-inactive">{meta}</span>
          )}
        </span>
        {preview !== undefined && (
          <span className={`text-[12px] ${unread ? 'text-kumo-subtle' : 'text-kumo-inactive'}`}>
            {preview}
          </span>
        )}
      </span>
    </>
  )
  if (to) {
    return (
      <Link to={to} search={search} aria-busy={pending} className={className}>
        {body}
      </Link>
    )
  }
  return (
    <button type="button" onClick={onClick} aria-busy={pending} className={className}>
      {body}
    </button>
  )
}

export function PaneHeader({ avatar, title, subtitle, actions }: {
  avatar?: ReactNode
  title?: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-kumo-line px-4">
      {avatar}
      <div className="min-w-0 flex-1">
        {title !== undefined && (
          <span className="text-[14px] font-medium text-kumo-default">{title}</span>
        )}
        {subtitle !== undefined && (
          <span className="block text-[11.5px] text-kumo-inactive">{subtitle}</span>
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
