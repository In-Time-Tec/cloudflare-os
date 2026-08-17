import { Link } from '@tanstack/react-router'
import {
  Blueprint,
  BookOpen,
  CalendarBlank,
  Compass,
  Hexagon,
  House,
  MagnifyingGlass,
  SidebarSimple,
  SquaresFour,
  Stack,
} from '@phosphor-icons/react'
import { useSiteName } from '../../ServerConfigContext'
import SiteLogo from '../SiteLogo'
import { useGatekeeperApps } from '../../useGatekeeperApps'
import { openCommandPalette } from './commandPaletteBus'
import { PendingIcon, useLinkPending } from '../PendingIcon'
import SidebarItem from './SidebarItem'
import {
  SidebarWorkspacesProvider,
  SidebarFavorites,
  SidebarRecentWorkspaces,
} from './SidebarWorkspaces'
import SidebarConversations from '../../conversations/SidebarConversations'
import SidebarUtilityStrip from './SidebarUtilityStrip'
import SidebarScrollRegion from './SidebarScrollRegion'

/**
 * The persistent left rail. The brand row and the bottom utility strip stay pinned; everything
 * between them — primary nav, communications sections, Favorites / Recent workspaces — scrolls as
 * one region with edge fades that appear only while content is actually beneath them.
 *
 * Layout (top → bottom):
 *   • brand row                                    pinned
 *   • nav + conversations + workspace lists        SCROLLS (fades top/bottom)
 *   • utility strip (plug, avatar)                 pinned
 */
export default function Sidebar({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  const siteName = useSiteName()
  const homePending = useLinkPending({ to: '/' })
  const gatekeeperApps = useGatekeeperApps()
  const brand = (
    <PendingIcon pending={homePending} size={20}>
      <SiteLogo size={20} className="shrink-0">
        <Hexagon size={20} weight="bold" className="text-kumo-brand shrink-0" />
      </SiteLogo>
    </PendingIcon>
  )

  return (
    <aside
      aria-label="Primary"
      className={[
        // Sidebar is the app chrome: a hair greyer than the (lighter) content canvas so the two
        // surfaces read as distinct without a heavy divider.
        'group/sidebar flex h-full flex-col border-r border-kumo-line bg-kumo-elevated',
        collapsed ? 'w-[56px]' : 'w-[260px]',
        'shrink-0 transition-[width] duration-200 ease-out',
      ].join(' ')}
    >
      <div
        className={[
          'flex h-14 shrink-0 items-center border-b border-kumo-line',
          collapsed ? 'justify-center px-1.5' : 'justify-between gap-2 px-3',
        ].join(' ')}
      >
        {collapsed ? (
          <div className="relative flex h-7 w-7 items-center justify-center">
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="peer absolute inset-0 z-10 flex cursor-pointer items-center justify-center rounded-md text-kumo-inactive opacity-0 pointer-events-none transition-colors hover:bg-kumo-tint hover:text-kumo-default group-hover/sidebar:pointer-events-auto group-hover/sidebar:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
            >
              <SidebarSimple size={15} className="rotate-180" />
            </button>
            <Link
              to="/"
              aria-label={siteName}
              aria-busy={homePending}
              className="flex items-center justify-center group-hover/sidebar:invisible peer-focus-visible:invisible"
            >
              {brand}
            </Link>
          </div>
        ) : (
          <>
            <Link to="/" aria-label={siteName} aria-busy={homePending} className="flex min-w-0 items-center gap-2">
              {brand}
              <span className="truncate text-[14px] leading-5 font-semibold tracking-[-0.25px] text-kumo-default">
                {siteName}
              </span>
            </Link>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => openCommandPalette()}
                aria-label="Search"
                title="Search (⌘K)"
                className="press flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
              >
                <MagnifyingGlass size={15} />
              </button>
              <button
                type="button"
                onClick={onToggleCollapsed}
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
              >
                <SidebarSimple size={15} />
              </button>
            </div>
          </>
        )}
      </div>

      {collapsed && (
        <button
          type="button"
          onClick={() => openCommandPalette()}
          aria-label="Search"
          title="Search (⌘K)"
          className="press mx-auto mt-2 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
        >
          <MagnifyingGlass size={15} />
        </button>
      )}

      <SidebarWorkspacesProvider>
        {/* Everything between the brand row and the utility strip scrolls as one region, with
            edge fades that appear only while content is beneath them. */}
        <SidebarScrollRegion>
        <div className={['flex flex-col', collapsed ? 'pt-2' : 'pt-3'].join(' ')}>
          {/* Primary nav */}
          <nav className="flex flex-col gap-0.5 px-2">
            <SidebarItem
              to="/"
              label="Home"
              icon={<House size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/workspaces"
              label="Workspaces"
              icon={<SquaresFour size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/blueprints"
              label="Blueprints"
              icon={<Blueprint size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/outputs"
              label="Outputs"
              icon={<Stack size={14} weight="regular" />}
              collapsed={collapsed}
            />
            {/* Gatekeeper management apps (e.g. the Context Library), listed dynamically. */}
            {gatekeeperApps.map((app) => {
              // Escape the icon URL for safe interpolation into a CSS url("…") string.
              const maskUrl = app.icon
                ? `url("${app.icon.url.replace(/[\\"]/g, '\\$&')}")`
                : undefined
              return (
              <SidebarItem
                key={app.id}
                to="/gatekeepers/$appId"
                params={{ appId: app.id }}
                label={app.title}
                icon={
                  maskUrl ? (
                    // Render the (monochrome) app icon as a CSS mask filled with the row's current
                    // text color, so it tints like the Phosphor icons — subtle by default, accent
                    // when active, darker on hover.
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 bg-current"
                      style={{
                        maskImage: maskUrl,
                        WebkitMaskImage: maskUrl,
                        maskRepeat: 'no-repeat',
                        WebkitMaskRepeat: 'no-repeat',
                        maskPosition: 'center',
                        WebkitMaskPosition: 'center',
                        maskSize: 'contain',
                        WebkitMaskSize: 'contain',
                      }}
                    />
                  ) : (
                    <BookOpen size={14} weight="regular" />
                  )
                }
                collapsed={collapsed}
              />
              )
            })}
            <SidebarItem
              to="/explore"
              label="Explore"
              icon={<Compass size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/calendar"
              label="Calendar"
              icon={<CalendarBlank size={14} weight="regular" />}
              collapsed={collapsed}
            />
          </nav>
        </div>

        {/* Favorites leads the sections: it is the user's own shortlist, so it sits directly
            under the nav rather than below the communications sections. */}
        <div className="mt-1 pb-2">
          <SidebarFavorites collapsed={collapsed} />
          <SidebarConversations collapsed={collapsed} />
          <SidebarRecentWorkspaces collapsed={collapsed} />
        </div>
        </SidebarScrollRegion>
      </SidebarWorkspacesProvider>

      <SidebarUtilityStrip collapsed={collapsed} />
    </aside>
  )
}
