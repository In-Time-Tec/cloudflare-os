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
  ThreadMetadataWithTimestamps,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useThreads, useWhoami } from '../../query/hooks'
import { asTime } from '../../query/time'
import { useThreadMutations } from '../../query/useThreadMutations'
import ShareModal from '../../ShareModal'
import DeleteConfirmationDialog from '../DeleteConfirmationDialog'
import SidebarGadgetRow from './SidebarGadgetRow'

// Cap on items shown in the Recent list before the user clicks through to /threads.
const RECENT_INITIAL_LIMIT = 6

// ─────────────────────────────────────────────────────────────────────────────
// Shape of the threads state shared between the rail's pinned tools (search) and the scrolling
// lists (Favorites / Recent threads). Centralized here so both sibling components subscribe to
// the same data and the dialog state has a single owner.
// ─────────────────────────────────────────────────────────────────────────────
type ThreadsContextValue = {
  search: string
  setSearch: (v: string) => void

  gadgets: ThreadMetadataWithTimestamps[]
  favorites: ThreadMetadataWithTimestamps[]
  recent: ThreadMetadataWithTimestamps[]
  childrenByParent: Map<string, ThreadMetadataWithTimestamps[]>

  onTogglePin: (g: ThreadMetadataWithTimestamps) => void
  onRename: (g: ThreadMetadataWithTimestamps, newTitle: string) => void
  onShare: (g: ThreadMetadataWithTimestamps) => void
  onDelete: (g: ThreadMetadataWithTimestamps) => void
}

const ThreadsContext = createContext<ThreadsContextValue | null>(null)

function useThreadsContext(): ThreadsContextValue {
  const ctx = useContext(ThreadsContext)
  if (!ctx) throw new Error('Sidebar threads components must be rendered inside SidebarThreadsProvider')
  return ctx
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Provider: owns all the data + mutation handlers, plus the share / delete dialogs. Renders its
 * children inside its context so SidebarThreadsLists can be placed
 * independently in the parent layout (pinned vs. scrolling areas).
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function SidebarThreadsProvider({ children }: { children: ReactNode }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const { data: gadgets = [] } = useThreads()
  const { data: currentUser = null } = useWhoami()
  const { togglePin, renameThread, deleteThread, remove } = useThreadMutations()

  const [search, setSearch] = useState('')

  // Delete / share dialog state (threads).
  const [deleteTarget, setDeleteTarget] = useState<ThreadMetadataWithTimestamps | null>(null)
  const [shareTarget, setShareTarget] = useState<ThreadMetadataWithTimestamps | null>(null)
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

  const { favorites, recent, childrenByParent } = useMemo(() => {
    // Child threads (spawned by another thread's agent) render nested under their parent, not as
    // top-level rows. A child whose parent isn't in the list (deleted) falls back to top-level.
    const ids = new Set(gadgets.map((g) => g.id))
    const byParent = new Map<string, ThreadMetadataWithTimestamps[]>()
    const favs: ThreadMetadataWithTimestamps[] = []
    const rest: ThreadMetadataWithTimestamps[] = []
    const byActive = (a: ThreadMetadataWithTimestamps, b: ThreadMetadataWithTimestamps) =>
      asTime(b.lastActive) - asTime(a.lastActive)
    for (const g of gadgets) {
      if (!matchText(g.title)) continue
      if (g.parentThreadId && ids.has(g.parentThreadId)) {
        const siblings = byParent.get(g.parentThreadId) ?? []
        siblings.push(g)
        byParent.set(g.parentThreadId, siblings)
      } else if (g.pinned) favs.push(g)
      else rest.push(g)
    }
    for (const siblings of byParent.values()) siblings.sort(byActive)
    favs.sort(byActive)
    rest.sort(byActive)
    return { favorites: favs, recent: rest, childrenByParent: byParent }
  }, [gadgets, matchText])

  // --- Thread actions ---------------------------------------------------

  const onTogglePin = useCallback((g: ThreadMetadataWithTimestamps) => {
    togglePin(g)
  }, [togglePin])

  const onRename = useCallback((g: ThreadMetadataWithTimestamps, newTitle: string) => {
    renameThread(g, newTitle)
  }, [renameThread])

  const onShare = useCallback(async (g: ThreadMetadataWithTimestamps) => {
    let overseer: RpcStub<Overseer> | null = null
    try {
      overseer = authenticatedApi.openThread(g.id)
      const metadata = await overseer.getMetadata()
      setShareOverseer({ stub: overseer })
      setShareTarget({ ...g, ...metadata })
      overseer = null
    } catch (err) {
      overseer?.[Symbol.dispose]()
      console.error('Failed to open thread for sharing:', err)
      toasts.add({ title: 'Failed to open share settings', variant: 'error' })
    }
  }, [authenticatedApi, toasts])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await deleteThread(deleteTarget)
      setDeleteTarget(null)
    } catch {
    }
  }, [deleteThread, deleteTarget])

  const value: ThreadsContextValue = {
    search,
    setSearch,
    gadgets,
    favorites,
    recent,
    childrenByParent,
    onTogglePin,
    onRename,
    onShare,
    onDelete: setDeleteTarget,
  }

  return (
    <ThreadsContext.Provider value={value}>
      {children}

      {/* Delete confirm */}
      <DeleteConfirmationDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        isDeleting={remove.isPending}
        title={deleteTarget?.owner ? 'Remove thread' : 'Delete thread'}
        description={
          deleteTarget?.owner
            ? `Remove "${deleteTarget?.title || 'Untitled thread'}" from your list? You can still access it via its link.`
            : `Delete "${deleteTarget?.title || 'Untitled thread'}"? This cannot be undone.`
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
    </ThreadsContext.Provider>
  )
}

/**
 * The Favorites section. Split from Recent so it can sit directly under the primary nav, above the
 * communications sections — both read the same memoized arrays from the provider, so the split
 * costs no extra state and no extra fetch.
 *
 * Collapsed, the rail shows one merged strip of threads owned by SidebarRecentThreads; this
 * renders nothing so that strip stays exactly as it was.
 */
export function SidebarFavorites({ collapsed = false }: { collapsed?: boolean }) {
  const { favorites, childrenByParent, onTogglePin, onRename, onShare, onDelete } = useThreadsContext()
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
            <ThreadRowWithChildren
              key={g.id}
              gadget={g}
              childrenByParent={childrenByParent}
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

/** Recent threads, plus the collapsed rail's merged strip of favorites and recents. */
export function SidebarRecentThreads({ collapsed = false }: { collapsed?: boolean }) {
  const {
    favorites,
    recent,
    childrenByParent,
    onTogglePin,
    onRename,
    onShare,
    onDelete,
  } = useThreadsContext()

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
        label="Threads"
        count={recent.length}
        open={recentOpen}
        onToggle={() => setRecentOpen((o) => !o)}
      >
        {recent.length > 0 ? (
          <>
            <div className="flex flex-col">
              {recentShown.map((g) => (
                <ThreadRowWithChildren
                  key={g.id}
                  gadget={g}
                  childrenByParent={childrenByParent}
                  onTogglePin={onTogglePin}
                  onRename={onRename}
                  onShare={onShare}
                  onDelete={onDelete}
                />
              ))}
            </div>
            <Link
              to="/threads"
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

// A thread row plus its agent-spawned child threads, indented one level beneath it.
// (Grandchildren are keyed under their own parent in childrenByParent and render flat at that
// same indent — deep trees stay readable in a narrow rail.)
function ThreadRowWithChildren({
  gadget,
  childrenByParent,
  onTogglePin,
  onRename,
  onShare,
  onDelete,
}: {
  gadget: ThreadMetadataWithTimestamps
  childrenByParent: Map<string, ThreadMetadataWithTimestamps[]>
  onTogglePin: (g: ThreadMetadataWithTimestamps) => void
  onRename: (g: ThreadMetadataWithTimestamps, newTitle: string) => void
  onShare: (g: ThreadMetadataWithTimestamps) => void
  onDelete: (g: ThreadMetadataWithTimestamps) => void
}) {
  // Flatten the subtree below this row (children, grandchildren, ...) in DFS order.
  const children: ThreadMetadataWithTimestamps[] = []
  const stack = [...(childrenByParent.get(gadget.id) ?? [])]
  while (stack.length > 0) {
    const next = stack.shift()!
    children.push(next)
    stack.unshift(...(childrenByParent.get(next.id) ?? []))
  }
  return (
    <>
      <SidebarGadgetRow
        gadget={gadget}
        onTogglePin={onTogglePin}
        onRename={onRename}
        onShare={onShare}
        onDelete={onDelete}
      />
      {children.map((child) => (
        <SidebarGadgetRow
          key={child.id}
          gadget={child}
          nested
          onTogglePin={onTogglePin}
          onRename={onRename}
          onShare={onShare}
          onDelete={onDelete}
        />
      ))}
    </>
  )
}

// A collapsible group header used by the sidebar's thread sections.
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
