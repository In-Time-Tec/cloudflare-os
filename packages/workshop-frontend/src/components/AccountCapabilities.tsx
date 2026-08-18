import { useCallback, useEffect, useMemo, useState } from 'react'
import { CaretRight, Eye, PencilSimple } from '@phosphor-icons/react'
import { Switch, useKumoToastManager } from '@cloudflare/kumo'
import type { AccountCapabilityGroup } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'

/**
 * Per-capability grants for one connected account: a switch per group, and inside each group a
 * switch per operation.
 *
 * Reads and writes are labelled differently on purpose. A withheld write never reaches the
 * service. A withheld read is refused after the connector fetched it, so the data stops here
 * rather than never being requested -- the grant that stops the request is the group itself, which
 * decides what the connection is authorized for.
 */
export default function AccountCapabilities({
  accountId,
  onResourceNeeded,
}: {
  accountId: number
  /** Called when a group needs OAuth scopes the account doesn't hold yet. */
  onResourceNeeded: (resourceUrlPattern: string) => void
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [groups, setGroups] = useState<AccountCapabilityGroup[] | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      setGroups(await authenticatedApi.listAccountCapabilities(accountId))
    } catch (error) {
      console.error('Failed to load capabilities:', error)
      setGroups([])
    }
  }, [authenticatedApi, accountId])

  useEffect(() => { void load() }, [load])

  const setTags = useCallback(async (tags: string[], granted: boolean, busyKey: string) => {
    if (tags.length === 0) return
    setBusy(previous => new Set(previous).add(busyKey))
    // Optimistic: the switch should move under the finger, not after a round trip.
    setGroups(previous => previous?.map(group => ({
      ...group,
      capabilities: group.capabilities.map(capability =>
        tags.includes(capability.tag) ? { ...capability, granted } : capability),
    })) ?? null)
    try {
      await authenticatedApi.setAccountCapabilities(accountId, tags, granted)
    } catch (error) {
      console.error('Failed to update capabilities:', error)
      toasts.add({ title: 'Failed to update access', variant: 'error' })
      await load()
    } finally {
      setBusy(previous => {
        const next = new Set(previous)
        next.delete(busyKey)
        return next
      })
    }
  }, [authenticatedApi, accountId, load, toasts])

  const rows = useMemo(() => groups ?? [], [groups])
  if (groups === null) return null
  if (rows.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <h3 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
        Access
      </h3>
      <p className="px-1 text-[12px] leading-[17px] text-kumo-subtle">
        What agents may do with this connection. Everything you enable is available in every chat.
      </p>

      <div className="flex flex-col divide-y divide-kumo-line rounded-xl border border-kumo-line">
        {rows.map(group => {
          const open = expanded.has(group.id)
          const granted = group.capabilities.filter(capability => capability.granted).length
          const total = group.capabilities.length
          const allOn = granted === total
          const groupBusy = busy.has(group.id)

          return (
            <div key={group.id} className="flex flex-col">
              <div className="flex items-center gap-3 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setExpanded(previous => {
                    const next = new Set(previous)
                    if (next.has(group.id)) next.delete(group.id); else next.add(group.id)
                    return next
                  })}
                  aria-expanded={open}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                >
                  <CaretRight
                    size={13}
                    weight="bold"
                    className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] tracking-[-0.25px] text-kumo-default">
                      {group.label}
                    </span>
                    <span className="block truncate text-[12px] leading-[17px] text-kumo-subtle">
                      {group.resourceGranted
                        ? `${granted} of ${total} enabled`
                        : 'Not connected for this area'}
                    </span>
                  </span>
                </button>

                <Switch
                  checked={allOn}
                  disabled={groupBusy}
                  onCheckedChange={(next: boolean) => {
                    if (next && !group.resourceGranted && group.resourceUrlPattern) {
                      onResourceNeeded(group.resourceUrlPattern)
                      return
                    }
                    void setTags(group.capabilities.map(c => c.tag), next, group.id)
                  }}
                  aria-label={`All of ${group.label}`}
                />
              </div>

              {open && (
                <div className="flex flex-col gap-1 border-t border-kumo-line bg-kumo-elevated/40 px-3 py-2">
                  {group.capabilities.map(capability => (
                    <div key={capability.tag} className="flex items-center gap-3 py-1">
                      <span
                        className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive"
                        title={capability.mode === 'read' ? 'Reads data' : 'Changes things'}
                      >
                        {capability.mode === 'read'
                          ? <Eye size={13} weight="bold" />
                          : <PencilSimple size={13} weight="bold" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] tracking-[-0.25px] text-kumo-default">
                          {capability.label}
                        </span>
                        <span className="block text-[12px] leading-[17px] text-kumo-subtle">
                          {capability.summary}
                        </span>
                      </span>
                      <Switch
                        checked={capability.granted}
                        disabled={busy.has(capability.tag) || capability.needsResourceGrant}
                        onCheckedChange={(next: boolean) =>
                          void setTags([capability.tag], next, capability.tag)}
                        aria-label={capability.label}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
