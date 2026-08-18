import { useCallback, useEffect, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { List, X } from '@phosphor-icons/react'
import TopBarNotice from '../../TopBarNotice'
import ReconnectingChip from '../ReconnectingChip'
import { useConnectionLost } from '../../RpcContext'
import Sidebar from './Sidebar'
import { ConversationsProvider } from '../../conversations/ConversationsContext'
import CommandPalette from './CommandPalette'
import { OPEN_COMMAND_PALETTE_EVENT } from './commandPaletteBus'

const STORAGE_KEY_COLLAPSED = 'gadgets:sidebar-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_COLLAPSED) === '1'
  } catch {
    return false
  }
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ConversationsProvider>
      <AppShellInner>{children}</AppShellInner>
    </ConversationsProvider>
  )
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const connectionLost = useConnectionLost()

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try { localStorage.setItem(STORAGE_KEY_COLLAPSED, next ? '1' : '0') } catch {}
      return next
    })
  }, [])

  useEffect(() => {
    if (!mobileOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [mobileOpen])

  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
        if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]')) return
        e.preventDefault()
        toggleCollapsed()
      }
    }
    const onOpen = () => setPaletteOpen(true)
    document.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    }
  }, [toggleCollapsed])

  return (
    <div className="h-screen min-h-screen w-screen overflow-hidden bg-app-frame p-0 md:p-3">
      <div className="flex h-full w-full overflow-hidden bg-kumo-base md:rounded-2xl md:border md:border-kumo-line md:shadow-app-shell">
        {/* Desktop sidebar — hidden on mobile in favor of the drawer. */}
        <div className="hidden md:flex">
          <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        </div>

        {/* Mobile drawer */}
        {mobileOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] md:hidden"
              onClick={() => setMobileOpen(false)}
              aria-hidden="true"
            />
            <div className="fixed inset-y-0 left-0 z-50 md:hidden">
              <Sidebar collapsed={false} onToggleCollapsed={() => setMobileOpen(false)} />
            </div>
          </>
        )}

        {/* Main column */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* The desktop canvas begins at the top of the inset, like Amp's empty screen. Mobile
              retains a conventional bar for the menu affordance. Notices float over the desktop
              canvas instead of reserving an otherwise-empty row. */}
          <div className="relative z-20 flex h-14 shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-base px-3 md:pointer-events-none md:absolute md:inset-x-0 md:top-0 md:h-auto md:border-0 md:bg-transparent md:p-3">
            <button
              type="button"
              onClick={() => setMobileOpen((o) => !o)}
              aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
              className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md text-kumo-default transition-colors hover:bg-kumo-tint md:hidden"
            >
              {mobileOpen ? <X size={16} /> : <List size={16} />}
            </button>
            <div className="pointer-events-auto">
              <TopBarNotice />
            </div>
            <div className="pointer-events-auto ml-auto flex items-center gap-2">
              {connectionLost && <ReconnectingChip />}
              <span aria-hidden="true" className="h-7 w-7 md:hidden" />
            </div>
          </div>

          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
        </div>

        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </div>
    </div>
  )
}
