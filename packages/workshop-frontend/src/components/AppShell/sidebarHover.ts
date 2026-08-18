import type { ReactNode } from 'react'
import { asTime } from '../../query/time'

export const SIDEBAR_PREVIEW_DELAY_MS = 160
export const SIDEBAR_PREVIEW_HANDOFF_MS = 80

export type SidebarHoverAction = {
  label: string
  icon: ReactNode
  onSelect: () => void
  danger?: boolean
}

export type SidebarHoverPreview = {
  title: string
  meta?: string
  body?: string
  footer?: string
}

export function formatPreviewTime(value: Date | string | number | undefined): string {
  if (value == null) return ''
  const minutes = Math.floor(Math.max(0, Date.now() - asTime(value)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function hoverRowClassName(options: {
  active?: boolean
  pending?: boolean
  hasActions?: boolean
  className?: string
}): string {
  return [
    'group/hover-row relative flex w-full cursor-pointer items-center text-left text-sm font-medium leading-5 tracking-normal transition-colors',
    options.hasActions ? 'sidebar-hover-has-actions' : '',
    options.active ? 'bg-kumo-fill text-kumo-strong' : 'hover:bg-kumo-tint',
    options.pending ? 'opacity-70' : '',
    options.className ?? '',
  ].filter(Boolean).join(' ')
}
