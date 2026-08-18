import { Link } from '@tanstack/react-router'
import { PendingIcon, useLinkPending } from './PendingIcon'
import { Clock, ArrowRight } from '@phosphor-icons/react'
import { useMemo } from 'react'
import { useThreads } from '../query/hooks'
import { asTime } from '../query/time'
import { ThreadMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

// A simple deterministic gradient based on the gadget ID
function getGradient(id: string): string {
  const gradients = [
    'from-[#4A154B] to-[#7C3085]',
    'from-[#0052CC] to-[#2684FF]',
    'from-[#5865F2] to-[#7983F5]',
    'from-[#34A853] to-[#4285F4]',
    'from-[#24292e] to-[#555]',
    'from-[#E01E5A] to-[#ECB22E]',
    'from-orange-600 to-red-600',
    'from-emerald-600 to-teal-600',
  ]
  const idx = id.charCodeAt(0) % gradients.length
  return gradients[idx]
}

function formatRelativeTime(date: Date | string | number): string {
  const now = Date.now()
  const diff = now - asTime(date)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function AppRow({ gadget }: { gadget: ThreadMetadataWithTimestamps }) {
  const gradient = getGradient(gadget.id)
  const pending = useLinkPending({ to: '/thread/$id', params: { id: gadget.id } })

  return (
    <Link
      to="/thread/$id"
      params={{ id: gadget.id }}
      aria-busy={pending}
      className="group flex items-center gap-4 p-3 rounded-xl border border-kumo-line bg-kumo-base hover:border-kumo-fill transition-all cursor-pointer"
    >
      <div
        className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${gradient}`}
      >
        <PendingIcon pending={pending} size={24}>
          <span className="block size-full" aria-hidden="true" />
        </PendingIcon>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium text-kumo-default truncate">
          {gadget.title || 'Untitled Thread'}
        </h3>
        {gadget.owner && (
          <p className="text-xs text-kumo-subtle truncate mt-0.5">
            Shared by {gadget.owner.name}
          </p>
        )}
      </div>

      {/* Status + time */}
      <div className="flex items-center gap-3 flex-shrink-0">

        <span className="hidden md:flex items-center gap-1 text-xs text-kumo-inactive">
          <Clock size={10} />
          {formatRelativeTime(gadget.lastActive)}
        </span>
      </div>
    </Link>
  )
}

export default function RecentApps() {
  const { data: rawGadgets, isError: loadError } = useThreads()
  const gadgets = useMemo(
    () => [...(rawGadgets ?? [])].toSorted((a, b) => asTime(b.lastActive) - asTime(a.lastActive)).slice(0, 4),
    [rawGadgets])

  if (rawGadgets === undefined && !loadError) {
    return null
  }

  if (loadError) {
    return (
      <section className="w-full max-w-2xl mx-auto">
        <div className="text-center py-8 text-sm text-kumo-danger">
          Unable to load your threads. Check your connection and try refreshing.
        </div>
      </section>
    )
  }

  if (gadgets.length === 0) {
    return (
      <section className="w-full max-w-2xl mx-auto">
        <div className="text-center py-8 text-kumo-inactive text-sm">
          No threads yet. Create your first one above!
        </div>
      </section>
    )
  }

  return (
    <section className="w-full max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-kumo-default">
          Recent threads
        </h2>
        <Link
          to="/"
          className="flex items-center gap-1 text-xs text-kumo-subtle hover:text-kumo-brand transition-colors"
        >
          View all
          <ArrowRight size={12} />
        </Link>
      </div>

      <div className="flex flex-col gap-2">
        {gadgets.map((gadget) => (
          <AppRow key={gadget.id} gadget={gadget} />
        ))}
      </div>
    </section>
  )
}
