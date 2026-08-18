import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import {
  Blueprint as BlueprintIcon,
  BookOpen,
  CalendarBlank,
  Compass,
  Hexagon,
  House,
  MagnifyingGlass,
  NotePencil,
  SidebarSimple,
  Stack,
} from '@phosphor-icons/react'
import { Tooltip } from '@cloudflare/kumo'
import { useSiteName } from '../../ServerConfigContext'
import SiteLogo from '../SiteLogo'
import { useGatekeeperApps } from '../../useGatekeeperApps'
import { openCommandPalette } from './commandPaletteBus'
import { PendingIcon, useLinkPending } from '../PendingIcon'
import SidebarItem from './SidebarItem'
import {
  SidebarThreadsProvider,
  SidebarFavorites,
  SidebarRecentThreads,
} from './SidebarThreads'
import SidebarConversations from '../../conversations/SidebarConversations'
import SidebarUtilityStrip from './SidebarUtilityStrip'
import SidebarScrollRegion from './SidebarScrollRegion'

function BrandMark({
  siteName,
  homePending,
  brand,
  collapsed,
  onToggleCollapsed,
}: {
  siteName: string
  homePending: boolean
  brand: ReactNode
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  const label = collapsed ? 'Show sidebar' : 'Hide sidebar'
  return (
    <div className="group/mark relative flex h-7 w-7 shrink-0 items-center justify-center">
      <Tooltip
        side="bottom"
        delay={200}
        content={
          <span className="flex items-center gap-1.5">
            {label}
            <span className="text-kumo-inactive">⌘B</span>
          </span>
        }
        render={
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={`${label} ⌘B`}
            className="absolute inset-0 z-10 flex cursor-pointer items-center justify-center rounded-lg text-kumo-inactive opacity-0 pointer-events-none transition-opacity transition-colors hover:bg-kumo-tint hover:text-kumo-default group-hover/sidebar:pointer-events-auto group-hover/sidebar:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
          >
            <SidebarSimple size={15} />
          </button>
        }
      />
      <Link
        to="/"
        aria-label={siteName}
        aria-busy={homePending}
        className="flex items-center justify-center group-hover/sidebar:invisible group-has-[:focus-visible]/mark:invisible"
      >
        {brand}
      </Link>
    </div>
  )
}

/**
 * The persistent left rail. The brand row and the bottom utility strip stay pinned; everything
 * between them — primary nav, communications sections, Favorites / Recent threads — scrolls as
 * one region with edge fades that appear only while content is actually beneath them.
 *
 * Layout (top → bottom):
 *   • brand row                                    pinned
 *   • nav + conversations + thread lists        SCROLLS (fades top/bottom)
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
    <PendingIcon pending={homePending} size={16}>
      <SiteLogo size={16} className="shrink-0">
        <Hexagon size={16} weight="bold" className="text-kumo-brand shrink-0" />
      </SiteLogo>
    </PendingIcon>
  )

  return (
    <aside
      aria-label="Primary"
      className={[
        // Sidebar is the app chrome: a hair greyer than the (lighter) content canvas so the two
        // surfaces read as distinct without a heavy divider.
        'group/sidebar flex h-full flex-col overflow-hidden border-r border-kumo-line bg-kumo-elevated md:rounded-l-2xl',
        collapsed ? 'w-11' : 'w-[260px]',
        'shrink-0 transition-[width] duration-200 ease-out',
      ].join(' ')}
    >
      <div
        className={[
          'flex h-9 shrink-0 items-center border-b border-kumo-line',
          collapsed ? 'justify-center' : 'justify-between gap-1.5 px-1.5',
        ].join(' ')}
      >
        {collapsed ? (
          <BrandMark
            siteName={siteName}
            homePending={homePending}
            brand={brand}
            collapsed
            onToggleCollapsed={onToggleCollapsed}
          />
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-1.5">
              <BrandMark
                siteName={siteName}
                homePending={homePending}
                brand={brand}
                collapsed={false}
                onToggleCollapsed={onToggleCollapsed}
              />
              <Link to="/" aria-label={siteName} aria-busy={homePending} className="min-w-0 truncate text-sm font-medium text-kumo-default">
                {siteName}
              </Link>
            </div>
            <div className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => openCommandPalette()}
                aria-label="Search"
                title="Search (⌘K)"
                className="press flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
              >
                <MagnifyingGlass size={15} />
              </button>
              <Link
                to="/"
                aria-label="New thread"
                title="New thread"
                className="press flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
              >
                <NotePencil size={15} />
              </Link>
            </div>
          </>
        )}
      </div>

      <SidebarThreadsProvider>
        {/* Everything between the brand row and the utility strip scrolls as one region, with
            edge fades that appear only while content is beneath them. */}
        <SidebarScrollRegion>
        <div className={['flex flex-col', collapsed ? 'pt-1.5' : 'pt-2'].join(' ')}>
          {/* Primary nav */}
          <nav className={['flex flex-col gap-0.5', collapsed ? 'px-2' : 'px-1.5'].join(' ')}>
            {collapsed && (
              <button
                type="button"
                onClick={() => openCommandPalette()}
                aria-label="Search"
                title="Search (⌘K)"
                className="press mx-auto flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
              >
                <MagnifyingGlass size={15} />
              </button>
            )}
            <SidebarItem
              to="/"
              label="Home"
              icon={<House size={14} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/templates"
              label="Templates"
              icon={<BlueprintIcon size={14} weight="regular" />}
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
        <div className="pb-2">
          <SidebarFavorites collapsed={collapsed} />
          <SidebarRecentThreads collapsed={collapsed} />
          <SidebarConversations collapsed={collapsed} />
        </div>
        </SidebarScrollRegion>
      </SidebarThreadsProvider>

      <SidebarUtilityStrip collapsed={collapsed} />
    </aside>
  )
}
