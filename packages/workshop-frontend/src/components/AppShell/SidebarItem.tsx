import { Link, useMatchRoute, useRouterState, type LinkProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { PendingIcon } from '../PendingIcon'

/**
 * A single nav row in the sidebar. Renders as a TanStack <Link>. Active state is computed from the
 * current router pathname so we can also tint the icon (TanStack's activeProps only swaps top-level
 * className, not child styles). When `collapsed` is true the label is hidden but kept in the DOM for
 * screen readers / hover-tooltips.
 */
export type SidebarItemProps = {
  icon: ReactNode
  label: string
  to: LinkProps['to']
  params?: LinkProps['params']
  trailing?: ReactNode
  collapsed?: boolean
  /** When true, match this item active when the current path starts with `to`. */
  matchPrefix?: boolean
}

export default function SidebarItem({
  icon,
  label,
  to,
  params,
  trailing,
  collapsed = false,
  matchPrefix = false,
}: SidebarItemProps) {
  // Resolve the active path manually so we can style the icon as well as the row. For parameterized
  // routes (e.g. "/gatekeepers/$appId"), substitute the params so the resolved path can match.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const matchRoute = useMatchRoute()
  let target = typeof to === 'string' ? to : ''
  if (params) {
    for (const [key, value] of Object.entries(params as Record<string, string>)) {
      target = target.replaceAll(`$${key}`, String(value))
    }
  }
  const isActive = matchPrefix
    ? pathname === target || pathname.startsWith(target + '/')
    : pathname === target
  const pending = !!matchRoute({ to, params, pending: true } as Parameters<typeof matchRoute>[0])

  const linkProps = { to, params } as unknown as LinkProps

  return (
    <Link
      {...linkProps}
      title={collapsed ? label : undefined}
      aria-busy={pending}
      className={[
        'group relative flex items-center rounded-md text-sm font-medium leading-5 tracking-normal transition-colors',
        collapsed ? 'h-7 justify-center' : 'h-7 gap-1',
        isActive
          ? 'bg-kumo-fill text-kumo-strong'
          : 'text-kumo-default hover:bg-kumo-tint',
      ].join(' ')}
    >
      <span
        className={[
          'flex w-7 shrink-0 items-center justify-center transition-colors',
          isActive ? 'text-kumo-brand' : 'text-kumo-subtle group-hover:text-kumo-default',
        ].join(' ')}
      >
        <PendingIcon pending={pending} size={14}>{icon}</PendingIcon>
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing && <span className="shrink-0 text-kumo-inactive">{trailing}</span>}
        </>
      )}
    </Link>
  )
}
