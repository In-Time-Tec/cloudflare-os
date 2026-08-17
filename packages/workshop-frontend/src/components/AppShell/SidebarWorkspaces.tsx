import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Link } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import {
  GadgetMetadataWithTimestamps,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useGadgets, useWhoami } from '../../query/hooks'
import { useGadgetMutations } from '../../query/useGadgetMutations'
import ShareModal from '../../ShareModal'
import DeleteConfirmationDialog from '../DeleteConfirmationDialog'
import SidebarGadgetRow from './SidebarGadgetRow'

// Cap on items shown in the Recent list before the user clicks through to /workspaces.
const RECENT_INITIAL_LIMIT = 6

// ─────────────────────────────────────────────────────────────────────────────
// Shape of the workspaces state shared between the rail's pinned tools (search) and the scrolling
// lists (Favorites / Recent workspaces). Centralized here so both sibling components subscribe to
// the same data and the dialog state has a single owner.
// ─────────────────────────────────────────────────────────────────────────────
type WorkspacesContextValue = {
  search: string
  setSearch: (v: string) => void

  gadgets: GadgetMetadataWithTimestamps[]
  favorites: GadgetMetadataWithTimestamps[]
  recent: GadgetMetadataWithTimestamps[]

  onTogglePin: (g: GadgetMetadataWithTimestamps) => void
  onRename: (g: GadgetMetadataWithTimestamps, newTitle: string) => void
  onShare: (g: GadgetMetadataWithTimestamps) => void
  onDelete: (g: GadgetMetadataWithTimestamps) => void
}

const WorkspacesContext = createContext<WorkspacesContextValue | null>(null)

function useWorkspacesContext(): WorkspacesContextValue {
  const ctx = useContext(WorkspacesContext)
  if (!ctx) throw new Error('Sidebar workspaces components must be rendered inside SidebarWorkspacesProvider')
  return ctx
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Provider: owns all the data + mutation handlers, plus the share / delete dialogs. Renders its
 * children inside its context so SidebarWorkspacesLists can be placed
 * independently in the parent layout (pinned vs. scrolling areas).
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function SidebarWorkspacesProvider({ children }: { children: ReactNode }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const { data: gadgets = [] } = useGadgets()
  const { data: currentUser = null } = useWhoami()
  const { togglePin, renameGadget, deleteGadget, remove } = useGadgetMutations()

  const [search, setSearch] = useState('')

  // Delete / share dialog state (workspaces).
  const [deleteTarget, setDeleteTarget] = useState<GadgetMetadataWithTimestamps | null>(null)
  const [shareTarget, setShareTarget] = useState<GadgetMetadataWithTimestamps | null>(null)
  const [shareOverseer, setShareOverseer] = useState<{ stub: RpcStub<Overseer> } | null>(null)

  // Dispose share overseer on close / unmount.
  useEffect(() => {
    if (!shareTarget && shareOverseer) {
      shareOverseer.stub[Symbol.dispose]()
      setShareOverseer(null)
    }
  }, [shareTarget, shareOverseer])
  const shareOverseerRef = useRef(shareOverseer)
  shareOverseerRef.current = shareOverseer
  useEffect(() => () => { shareOverseerRef.current?.stub[Symbol.dispose]() }, [])

  const needle = search.trim().toLowerCase()
  const matchText = useCallback(
    (s: string | undefined) => !needle || (s || '').toLowerCase().includes(needle),
    [needle],
  )

  const { favorites, recent } = useMemo(() => {
    const favs: GadgetMetadataWithTimestamps[] = []
    const rest: GadgetMetadataWithTimestamps[] = []
    for (const g of gadgets) {
      if (!matchText(g.title)) continue
      if (g.pinned) favs.push(g)
      else rest.push(g)
    }
    const byActive = (a: GadgetMetadataWithTimestamps, b: GadgetMetadataWithTimestamps) =>
      b.lastActive.getTime() - a.lastActive.getTime()
    favs.sort(byActive)
    rest.sort(byActive)
    return { favorites: favs, recent: rest }
  }, [gadgets, matchText])

  // --- Workspace actions ---------------------------------------------------

  const onTogglePin = useCallback((g: GadgetMetadataWithTimestamps) => {
    togglePin(g)
  }, [togglePin])

  const onRename = useCallback((g: GadgetMetadataWithTimestamps, newTitle: string) => {
    renameGadget(g, newTitle)
  }, [renameGadget])

  const onShare = useCallback(async (g: GadgetMetadataWithTimestamps) => {
    let overseer: RpcStub<Overseer> | null = null
    try {
      overseer = authenticatedApi.openGadget(g.id)
      const metadata = await overseer.getMetadata()
      setShareOverseer({ stub: overseer })
      setShareTarget({ ...g, ...metadata })
      overseer = null
    } catch (err) {
      overseer?.[Symbol.dispose]()
      console.error('Failed to open workspace for sharing:', err)
      toasts.add({ title: 'Failed to open share settings', variant: 'error' })
    }
  }, [authenticatedApi, toasts])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await deleteGadget(deleteTarget)
      setDeleteTarget(null)
    } catch {
    }
  }, [deleteGadget, deleteTarget])

  const value: WorkspacesContextValue = {
    search,
    setSearch,
    gadgets,
    favorites,
    recent,
    onTogglePin,
    onRename,
    onShare,
    onDelete: setDeleteTarget,
  }

  return (
    <WorkspacesContext.Provider value={value}>
      {children}

      {/* Delete confirm */}
      <DeleteConfirmationDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        isDeleting={remove.isPending}
        title={deleteTarget?.owner ? 'Remove workspace' : 'Delete workspace'}
        description={
          deleteTarget?.owner
            ? `Remove "${deleteTarget?.title || 'Untitled workspace'}" from your list? You can still access it via its link.`
            : `Delete "${deleteTarget?.title || 'Untitled workspace'}"? This cannot be undone.`
        }
        confirmLabel={deleteTarget?.owner ? 'Remove' : 'Delete'}
        confirmingLabel={deleteTarget?.owner ? 'Removing...' : 'Deleting...'}
        onConfirm={handleDeleteConfirm}
      />

      {/* Share modal */}
      {shareOverseer && shareTarget && (
        <ShareModal
          open
          onClose={() => setShareTarget(null)}
          overseer={shareOverseer.stub}
          metadata={shareTarget}
          currentUser={currentUser}
          authenticatedApi={authenticatedApi}
        />
      )}
    </WorkspacesContext.Provider>
  )
}

/**
 * The Favorites section. Split from Recent so it can sit directly under the primary nav, above the
 * communications sections — both read the same memoized arrays from the provider, so the split
 * costs no extra state and no extra fetch.
 *
 * Collapsed, the rail shows one merged strip of workspaces owned by SidebarRecentWorkspaces; this
 * renders nothing so that strip stays exactly as it was.
 */
export function SidebarFavorites({ collapsed = false }: { collapsed?: boolean }) {
  const { favorites, onTogglePin, onRename, onShare, onDelete } = useWorkspacesContext()
  const [favOpen, setFavOpen] = useState(true)

  // With nothing pinned the section is just a header reading "Favorites 0" directly beneath the
  // nav, which is noise rather than information.
  if (collapsed || favorites.length === 0) return null

  return (
    <div className="flex flex-col">
      <SidebarSection
        label="Favorites"
        count={favorites.length}
        open={favOpen}
        onToggle={() => setFavOpen((o) => !o)}
      >
        <div className="flex flex-col">
          {favorites.map((g) => (
            <SidebarGadgetRow
              key={g.id}
              gadget={g}
              onTogglePin={onTogglePin}
              onRename={onRename}
              onShare={onShare}
              onDelete={onDelete}
            />
          ))}
        </div>
      </SidebarSection>
    </div>
  )
}

/** Recent workspaces, plus the collapsed rail's merged strip of favorites and recents. */
export function SidebarRecentWorkspaces({ collapsed = false }: { collapsed?: boolean }) {
  const {
    favorites,
    recent,
    onTogglePin,
    onRename,
    onShare,
    onDelete,
  } = useWorkspacesContext()

  const [recentOpen, setRecentOpen] = useState(true)

  if (collapsed) {
    const compact = [...favorites, ...recent].slice(0, 8)
    return (
      <div className="flex flex-col items-center gap-1.5 px-2">
        {compact.map((g) => (
          <SidebarGadgetRow
            key={g.id}
            gadget={g}
            collapsed
            onTogglePin={onTogglePin}
            onRename={onRename}
            onShare={onShare}
            onDelete={onDelete}
          />
        ))}
      </div>
    )
  }

  const recentShown = recent.slice(0, RECENT_INITIAL_LIMIT)

  return (
    <div className="flex flex-col pb-3">
      <SidebarSection
        label="Recent workspaces"
        count={recent.length}
        open={recentOpen}
        onToggle={() => setRecentOpen((o) => !o)}
      >
        {recent.length > 0 ? (
          <>
            <div className="flex flex-col">
              {recentShown.map((g) => (
                <SidebarGadgetRow
                  key={g.id}
                  gadget={g}
                  onTogglePin={onTogglePin}
                  onRename={onRename}
                  onShare={onShare}
                  onDelete={onDelete}
                />
              ))}
            </div>
            <Link
              to="/workspaces"
              className="mt-0.5 flex h-7 items-center px-2.5 text-[12px] tracking-[-0.2px] text-kumo-inactive transition-colors hover:text-kumo-default"
            >
              Show all
            </Link>
          </>
        ) : null}
      </SidebarSection>
    </div>
  )
}

// A collapsible group header used by the sidebar's workspace sections.
function SidebarSection({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string
  count?: number
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="mt-3 flex flex-col px-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex h-6 w-full cursor-pointer items-center gap-2 px-1.5 text-[11px] font-medium tracking-[-0.1px] text-kumo-inactive transition-colors hover:text-kumo-subtle"
      >
        <span className="shrink-0">{label}</span>
        <span className="h-px min-w-2 flex-1 bg-kumo-line" aria-hidden="true" />
        {count !== undefined && <span className="shrink-0 tabular-nums">{count}</span>}
      </button>
      {open && children ? <div className="mt-0.5">{children}</div> : null}
    </div>
  )
}
