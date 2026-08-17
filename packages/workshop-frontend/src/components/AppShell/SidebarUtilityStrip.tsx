import { Link, useRouterState } from '@tanstack/react-router'
import { PendingIcon, useLinkPending } from '../PendingIcon'
import { Desktop, Moon, Plug, Sun } from '@phosphor-icons/react'
import { Tooltip } from '@cloudflare/kumo'
import UserMenu from '../UserMenu'
import { useTheme } from '../../ThemeContext'
import type { ThemeMode } from '../../theme'

const THEME_SEQUENCE: ThemeMode[] = ['system', 'light', 'dark']

function nextThemeMode(mode: ThemeMode): ThemeMode {
  return THEME_SEQUENCE[(THEME_SEQUENCE.indexOf(mode) + 1) % THEME_SEQUENCE.length]
}

function ThemeModeButton() {
  const { themeMode, resolvedThemeMode, setThemeMode } = useTheme()
  const label = themeMode === 'system'
    ? `Theme: system (${resolvedThemeMode})`
    : `Theme: ${themeMode}`
  const nextMode = nextThemeMode(themeMode)

  return (
    <Tooltip
      content={`${label}. Switch to ${nextMode}.`}
      render={(
        <button
          type="button"
          aria-label={`${label}. Switch to ${nextMode}.`}
          onClick={() => setThemeMode(nextMode)}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated"
        >
          {themeMode === 'system' ? (
            <Desktop size={15} />
          ) : themeMode === 'dark' ? (
            <Moon size={15} />
          ) : (
            <Sun size={15} />
          )}
        </button>
      )}
    />
  )
}

// Bottom strip on the sidebar: tiny iconography for connections, theme, and the user menu. Mirrors
// the very low-chrome bottom row in the reference design and surfaces Profile / Providers / Admin
// from the user-menu dropdown rather than duplicating them as separate icons.
function StripLink({
  to,
  label,
  children,
}: {
  to: '/gatekeepers'
  label: string
  children: React.ReactNode
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const pending = useLinkPending({ to })
  const active = pathname === to
  return (
    <Tooltip content={label}>
      <Link
        to={to}
        aria-label={label}
        aria-busy={pending}
        className={[
          'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
          active
            ? 'bg-kumo-fill text-kumo-brand'
            : 'text-kumo-inactive hover:bg-kumo-tint hover:text-kumo-default',
        ].join(' ')}
      >
        <PendingIcon pending={pending} size={15}>{children}</PendingIcon>
      </Link>
    </Tooltip>
  )
}

export default function SidebarUtilityStrip({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div
      className={[
        'shrink-0 flex items-center border-t border-kumo-line bg-kumo-elevated',
        collapsed ? 'flex-col justify-center gap-2 px-1.5 py-2' : 'gap-2 px-3 py-2',
      ].join(' ')}
    >
      <div className={collapsed ? '' : 'min-w-0 flex-1'}>
        <UserMenu showName={!collapsed} square />
      </div>
      {!collapsed && <div className="h-4 w-px shrink-0 bg-kumo-line" aria-hidden="true" />}
      <div className={collapsed ? 'flex flex-col items-center gap-2' : 'flex shrink-0 items-center gap-0.5'}>
        <ThemeModeButton />
        <StripLink to="/gatekeepers" label="Gatekeepers">
          <Plug size={15} />
        </StripLink>
      </div>
    </div>
  )
}
