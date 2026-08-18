import { useMemo, useState, type ReactNode } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { CaretRight, Eye, Lightning, ShieldCheck } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { HookToggle } from './components/HookToggle'
import { useActions } from './useActions'
import { useAuthenticatedApi } from './AuthContext'
import { useAvatar } from './useAvatar'
import { safeExternalUrl } from './utils/safeExternalUrl'

export type ActivityView = 'history'

type HistoryFilter = 'all' | ActionLogEntry['type']

const PANE_BAR = 'flex h-9 flex-shrink-0 items-center border-b border-kumo-line'

interface ActivityProps {
  overseer: RpcStub<Overseer>
}

const HISTORY_FILTERS: { value: HistoryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'action', label: 'Actions' },
  { value: 'observation', label: 'Observations' },
  { value: 'bindHook', label: 'Hooks' },
]

function timeValue(date: Date | undefined): number {
  return date ? new Date(date).getTime() : 0
}

function formatClockTime(date: Date): string {
  return new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatFullDate(date: Date): string {
  return new Date(date).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatRelativeTime(date: Date): string {
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(date).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dayLabel(date: Date): string {
  const value = new Date(date)
  const days = Math.round((startOfDay(new Date()) - startOfDay(value)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return value.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
}

/** When an entry happened: an action's outcome time, else when it was recorded. */
function entryTime(record: ActionLogEntry): Date {
  return (record.type === 'action' ? record.completedAt : undefined) ?? record.createdAt
}

function activityStatus(
  record: ActionLogEntry,
): { label: string; dotClass: string; textClass: string } {
  if (record.type === 'observation') {
    return { label: 'Observed', dotClass: 'bg-kumo-inactive', textClass: 'text-kumo-subtle' }
  }
  if (record.type === 'bindHook') {
    if (record.hookId === undefined) {
      return { label: 'Deleted', dotClass: 'bg-kumo-inactive', textClass: 'text-kumo-subtle' }
    }
    return record.enabled
      ? { label: 'Enabled', dotClass: 'bg-kumo-success', textClass: 'text-kumo-subtle' }
      : { label: 'Disabled', dotClass: 'bg-kumo-inactive', textClass: 'text-kumo-subtle' }
  }
  if (record.state === 'failed') {
    return { label: 'Failed', dotClass: 'bg-kumo-danger', textClass: 'text-kumo-danger' }
  }
  if (record.state === 'blocked') {
    return { label: 'Blocked', dotClass: 'bg-kumo-danger', textClass: 'text-kumo-danger' }
  }
  return { label: 'Done', dotClass: 'bg-kumo-success', textClass: 'text-kumo-subtle' }
}

function TypeIcon({ record, className }: { record: ActionLogEntry; className?: string }) {
  const props = { size: 13, weight: 'bold' as const, className }
  if (record.type === 'observation') return <Eye {...props} />
  if (record.type === 'bindHook') return <Lightning {...props} />
  return <ShieldCheck {...props} />
}

export default function Activity({ overseer }: ActivityProps) {
  const { actionsById, isReady } = useActions(overseer)
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all')
  const [togglingHooks, setTogglingHooks] = useState<Set<number>>(new Set())
  const [expandedActionId, setExpandedActionId] = useState<number | null>(null)
  const toasts = useKumoToastManager()

  const { historyGroups, historyTotal, historyShown } = useMemo(() => {
    const records = [...actionsById.values()]
    const filtered = records
      .filter(record => historyFilter === 'all' || record.type === historyFilter)
      .toSorted((a, b) =>
        timeValue(entryTime(b)) - timeValue(entryTime(a)) || b.id - a.id)
    const groups: { label: string; records: ActionLogEntry[] }[] = []
    for (const record of filtered) {
      const label = dayLabel(entryTime(record))
      const last = groups.at(-1)
      if (last?.label === label) last.records.push(record)
      else groups.push({ label, records: [record] })
    }
    return { historyGroups: groups, historyTotal: records.length, historyShown: filtered.length }
  }, [actionsById, historyFilter])

  const handleToggleHook = async (hookId: number, enabled: boolean) => {
    setTogglingHooks(previous => new Set(previous).add(hookId))
    try {
      if (enabled) await overseer.enableHook(hookId)
      else await overseer.disableHook(hookId)
    } catch (error) {
      console.error('Failed to toggle hook:', error)
      toasts.add({ title: `Failed to ${enabled ? 'enable' : 'disable'} hook`, variant: 'error' })
    } finally {
      setTogglingHooks(previous => {
        const next = new Set(previous)
        next.delete(hookId)
        return next
      })
    }
  }

  const toggleExpanded = (id: number) => {
    setExpandedActionId(previous => (previous === id ? null : id))
  }

  if (!isReady) {
    return <div className="flex h-full flex-col bg-kumo-base" />
  }

  return (
    <div className="flex h-full flex-col bg-kumo-base">
        <div className={`${PANE_BAR} gap-1 px-3`}>
          {HISTORY_FILTERS.map(filter => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setHistoryFilter(filter.value)}
              className={`flex h-6 cursor-pointer items-center rounded-md px-2 text-[12.5px] font-medium tracking-[-0.15px] transition-colors ${
                historyFilter === filter.value
                  ? 'bg-kumo-tint text-kumo-default'
                  : 'text-kumo-subtle hover:text-kumo-default'
              }`}
            >
              {filter.label}
            </button>
          ))}
          <span className="ml-auto pr-2 text-[11.5px] leading-[17px] tabular-nums text-kumo-inactive">
            {historyShown} {historyShown === 1 ? 'event' : 'events'}
          </span>

        </div>

        {historyTotal === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <p className="m-0 text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
              No activity yet
            </p>
            <p className="mt-1 max-w-xs text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              Every resource an agent reads or changes is recorded here.
            </p>
          </div>
        ) : historyShown === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <p className="m-0 text-[13px] font-medium text-kumo-default">No matching events</p>
            <button
              type="button"
              onClick={() => setHistoryFilter('all')}
              className="mt-1.5 cursor-pointer text-[12px] font-medium text-kumo-subtle hover:text-kumo-default"
            >
              Show all activity
            </button>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="grid grid-cols-[54px_minmax(0,1fr)_auto_16px] items-center gap-3 border-b border-kumo-line bg-kumo-elevated/50 px-5 py-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
              <span>Time</span>
              <span>Event</span>
              <span>Status</span>
              <span />
            </div>
            {historyGroups.map(group => (
              <section key={group.label}>
                <h3 className="sticky top-0 m-0 border-b border-kumo-line bg-kumo-base/90 px-5 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive backdrop-blur-sm">
                  {group.label}
                </h3>
                {group.records.map(record => (
                  <HistoryRow
                    key={record.id}
                    record={record}
                    expanded={expandedActionId === record.id}
                    onToggle={() => toggleExpanded(record.id)}
                    togglingHook={record.type === 'bindHook' && record.hookId !== undefined
                      ? togglingHooks.has(record.hookId)
                      : false}
                    onToggleHook={handleToggleHook}
                  />
                ))}
              </section>
            ))}
          </div>
        )}

    </div>
  )
}

function HistoryRow({
  record,
  expanded,
  onToggle,
  togglingHook,
  onToggleHook,
}: {
  record: ActionLogEntry
  expanded: boolean
  onToggle: () => void
  togglingHook: boolean
  onToggleHook: (hookId: number, enabled: boolean) => void
}) {
  const resourceUrl = safeExternalUrl(record.resourceUrl)
  const authorizedBy = record.type === 'action' ? record.authorizedBy : undefined
  const failure = record.type === 'action' ? record.failure : undefined
  const at = entryTime(record)
  const status = activityStatus(record)

  return (
    <div className={expanded ? 'bg-kumo-elevated/30' : ''}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group grid w-full cursor-pointer grid-cols-[54px_minmax(0,1fr)_auto_16px] items-center gap-3 border-b border-kumo-line/70 px-5 py-[7px] text-left transition-colors hover:bg-kumo-elevated/50"
      >
        <time className="text-[11.5px] tabular-nums leading-4 text-kumo-inactive">
          {formatClockTime(at)}
        </time>
        <span className="flex min-w-0 items-center gap-2">
          <TypeIcon record={record} className="flex-shrink-0 text-kumo-inactive" />
          <span className="truncate text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default">
            {record.description.title}
          </span>
          <span className="hidden flex-shrink-0 truncate text-[12px] leading-4 tracking-[-0.1px] text-kumo-inactive sm:inline">
            {record.resourceTitle}
          </span>
        </span>
        <span className={`flex items-center gap-1.5 text-[11.5px] font-medium ${status.textClass}`}>
          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${status.dotClass}`} />
          {status.label}
        </span>
        <CaretRight
          size={12}
          className={`text-kumo-inactive transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
      </button>

      {expanded && (
        <div className="border-b border-kumo-line/70 px-5 pb-3 pl-[86px] pt-1">
          {record.description.description && (
            <p className="m-0 whitespace-pre-wrap text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              {record.description.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-kumo-inactive">
            <span>{formatFullDate(at)}</span>
            <span className="text-kumo-subtle">{record.resourceTitle}</span>
            {failure && (
              <div className="text-[12px] text-kumo-danger">
                {failure.message}
                {failure.mayHaveTakenEffect ? ' (this may still have taken effect)' : ''}
              </div>
            )}
            {authorizedBy && (
              <ResolverBadge profileId={authorizedBy.id}>
                {`Under ${authorizedBy.name}'s connection`}
              </ResolverBadge>
            )}
            {resourceUrl && (
              <a
                href={resourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-kumo-subtle hover:text-kumo-default hover:underline"
              >
                Open resource
              </a>
            )}
            {record.type === 'bindHook' && record.hookId !== undefined && (
              <HookToggle
                enabled={record.enabled}
                disabled={togglingHook}
                onToggle={enabled => onToggleHook(record.hookId!, enabled)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ResolverBadge({ profileId, children }: { profileId: string; children: ReactNode }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const avatarUrl = useAvatar(authenticatedApi, profileId)
  return (
    <span className="flex min-w-0 items-center gap-1 text-kumo-subtle">
      {avatarUrl && (
        <img src={avatarUrl} alt="" className="h-3.5 w-3.5 flex-shrink-0 rounded-full object-cover" />
      )}
      <span className="truncate">{children}</span>
    </span>
  )
}
