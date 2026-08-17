import { logRpcFailure } from '../../rpcErrors'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAddableGatekeepers, useGatekeeperVendors, addableGatekeepersKey } from '../../query/hooks'
import { useKumoToastManager } from '@cloudflare/kumo'
import {
  MagnifyingGlass,
  ArrowsClockwise,
  Plus,
  CaretRight,
  Plugs,
} from '@phosphor-icons/react'
import ViewToggle from '../../components/ViewToggle'
import { useAuthenticatedApi } from '../../AuthContext'
import { refreshGatekeeperApps } from '../../useGatekeeperApps'
import { EmptyState } from '../../components/EmptyState'
import ConnectConnectorModal from '../../components/ConnectConnectorModal'
import {
  AccountDescription,
  SupportedResource,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'
import { useDocumentTitle } from '../../useDocumentTitle'
import { AccountsSubscriberAdapter } from '../../accountsSubscriber'
import PageChrome from '../../components/AppShell/PageChrome'

export const Route = createFileRoute('/_authenticated/gatekeepers')({
  component: ConnectorsPage,
})

interface AccountEntry {
  id: number
  accountDescription: AccountDescription
  vendorId: string
  vendorDescription: VendorDescription
  supportedResources: SupportedResource[]
  credentialsValid: boolean
}

interface VendorEntry {
  id: string
  description: VendorDescription
  supportedResources: SupportedResource[]
}

function VendorIconTile({
  logoUrl,
  color,
  fallback,
  size = 28,
  className = 'h-12 w-12 rounded-2xl',
}: {
  logoUrl?: string
  color?: string
  fallback: string
  size?: number
  className?: string
}) {
  return (
    <div
      className={`relative grid shrink-0 place-items-center ${className}`}
      style={{ backgroundColor: color ?? 'var(--color-kumo-tint)' }}
    >
      {logoUrl ? (
        <img src={logoUrl} alt="" className="object-contain" style={{ width: size, height: size }} />
      ) : (
        <span className="text-[15px] font-semibold text-kumo-strong">
          {fallback[0]?.toUpperCase() ?? '?'}
        </span>
      )}
    </div>
  )
}

interface ConnectorCardProps {
  logoUrl?: string
  color?: string
  fallback: string
  name: string
  badge?: { label: string; tone: 'new' | 'popular' }
  metaLine?: React.ReactNode
  tagline?: string
  state: 'connected' | 'available' | 'expired'
  onClick: () => void
  onReconnect?: () => void
  reconnectBusy?: boolean
  view?: 'grid' | 'list'
}

function ConnectorCard({
  logoUrl,
  color,
  fallback,
  name,
  badge,
  metaLine,
  tagline,
  state,
  onClick,
  onReconnect,
  reconnectBusy = false,
  view = 'grid',
}: ConnectorCardProps) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onClick()
    }
  }

  const statusDot =
    state === 'connected' ? (
      <span
        className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-kumo-success ring-2 ring-kumo-base"
        aria-hidden
      />
    ) : state === 'expired' ? (
      <span
        className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-kumo-danger ring-2 ring-kumo-base"
        aria-hidden
      />
    ) : null

  const badgeEl = badge ? (
    <span
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-3 font-semibold uppercase tracking-[0.4px] ${
        badge.tone === 'new'
          ? 'bg-[rgba(255,72,1,0.10)] text-kumo-brand'
          : 'bg-kumo-tint text-kumo-subtle'
      }`}
    >
      {badge.label}
    </span>
  ) : null

  const trailing =
    state === 'expired' && onReconnect ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          if (!reconnectBusy) onReconnect()
        }}
        disabled={reconnectBusy}
        className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-base px-3 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-default transition-[background-color,border-color,opacity,transform] duration-150 ease-out hover:border-kumo-fill hover:bg-kumo-tint active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"
      >
        <ArrowsClockwise size={12} weight="bold" />
        {reconnectBusy ? 'Opening...' : 'Reconnect'}
      </button>
    ) : (
      <div className="grid h-7 w-7 place-items-center text-kumo-inactive transition-colors group-hover:text-kumo-default">
        {state === 'available' ? (
          <Plus size={16} weight="bold" />
        ) : (
          <CaretRight size={14} weight="bold" />
        )}
      </div>
    )

  if (view === 'list') {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        className="group flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-kumo-tint"
      >
        <div className="relative shrink-0">
          <VendorIconTile
            logoUrl={logoUrl}
            color={color}
            fallback={fallback}
            size={20}
            className="h-9 w-9 rounded-lg"
          />
          {statusDot}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
              {name}
            </span>
            {badgeEl}
          </div>
          {(metaLine || tagline) && (
            <div className="mt-0.5 truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              {metaLine ?? tagline}
            </div>
          )}
        </div>
        <div className="shrink-0 self-center">{trailing}</div>
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className="themed-card-hover-shadow group grid w-full cursor-pointer grid-cols-[48px_1fr_auto] items-center gap-4 rounded-2xl border border-kumo-line bg-kumo-base px-5 py-5 text-left transition-[border-color,transform,box-shadow] duration-150 ease-out hover:-translate-y-px hover:border-kumo-fill active:scale-[0.995]"
    >
      <div className="self-start">
        <div className="relative">
          <VendorIconTile logoUrl={logoUrl} color={color} fallback={fallback} />
          {statusDot}
        </div>
      </div>

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
            {name}
          </span>
          {badgeEl}
        </div>
        {metaLine && (
          <div className="mt-0.5 flex items-center gap-1.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
            {metaLine}
          </div>
        )}
        {tagline && (
          <p className="mt-2 line-clamp-2 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
            {tagline}
          </p>
        )}
      </div>

      <div className="self-center">{trailing}</div>
    </div>
  )
}

function SectionEyebrow({ label, count }: { label: string; count?: number }) {
  return (
    <div className="mb-3.5 flex items-center gap-3 px-1">
      <h2 className="m-0 text-[11px] leading-4 font-semibold uppercase tracking-[0.9px] text-kumo-subtle">
        {label}
      </h2>
      <div className="h-px flex-1 bg-kumo-line" />
      {typeof count === 'number' && (
        <span className="text-[11px] leading-4 font-semibold tracking-[-0.1px] text-kumo-inactive">
          {count}
        </span>
      )}
    </div>
  )
}

type ModalTarget =
  | { kind: 'connect'; vendorId: string }
  | { kind: 'manage'; accountId: number }
  | null

function ConnectorsPage() {
  useDocumentTitle('Gatekeepers')

  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()

  const [search, setSearch] = useState('')
  const [view, setView] = useState<'grid' | 'list'>(() => {
    if (typeof window === 'undefined') return 'grid'
    return localStorage.getItem('gatekeepers-view') === 'list' ? 'list' : 'grid'
  })
  const queryClient = useQueryClient()
  const { data: addable = [] } = useAddableGatekeepers()
  const { data: rawVendors, isError: vendorsError } = useGatekeeperVendors()
  const vendors = useMemo(() =>
    (rawVendors ?? []).filter((v) => !v.unavailable).map((v) => ({
      id: v.id, description: v.description, supportedResources: v.supportedResources,
    })), [rawVendors])
  const vendorsLoaded = rawVendors !== undefined
  const loadError = vendorsError
  const [accounts, setAccounts] = useState<AccountEntry[]>([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)

  const [modalTarget, setModalTarget] = useState<ModalTarget>(null)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const [reconnectingAccountId, setReconnectingAccountId] = useState<number | null>(null)
  const [ensuringResourceUrlPatterns, setEnsuringResourceUrlPatterns] = useState<string[]>([])

  useEffect(() => {
    localStorage.setItem('gatekeepers-view', view)
  }, [view])

  useEffect(() => {
    let cancelled = false
    const accountMap = new Map<number, AccountEntry>()

    setAccountsLoaded(false)

    const subscriber = new AccountsSubscriberAdapter({
      add({ id, description, vendor, supportedResources, credentialsValid, vendorId }) {
        if (cancelled) return
        accountMap.set(id, {
          id,
          accountDescription: description,
          vendorId,
          vendorDescription: vendor,
          supportedResources,
          credentialsValid,
        })
        setAccounts(Array.from(accountMap.values()))
      },
      remove(id) {
        accountMap.delete(id)
        if (!cancelled) setAccounts(Array.from(accountMap.values()))
      },
      ready() {
        if (!cancelled) setAccountsLoaded(true)
      },
    })

    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber)
    subscription.catch((err) => {
      if (cancelled) return
      logRpcFailure('Failed to subscribe to connected accounts:', err)
      /* accounts subscribe failed */
    })

    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi])

  const handleOpenConnect = (vendorId: string) => {
    setModalTarget({ kind: 'connect', vendorId })
  }

  const handleOpenManage = (accountId: number) => {
    setModalTarget({ kind: 'manage', accountId })
  }

  const handleCloseModal = () => {
    setModalTarget(null)
    setEnsuringResourceUrlPatterns([])
  }

  const handleConfirmConnect = async (resourceUrlPatterns?: string[]) => {
    if (!modalTarget || modalTarget.kind !== 'connect') return
    const vendorId = modalTarget.vendorId
    setConnecting(true)
    try {
      if (isTargetAmbient) {
        // Ambient gatekeeper: mint the account directly, no OAuth redirect. It then appears under
        // "Connected" via the subscription and drops out of "Available".
        await authenticatedApi.provisionAmbientAccount(vendorId)
        void queryClient.invalidateQueries({ queryKey: addableGatekeepersKey() })
        // If the gatekeeper provides a management UI, its nav entry should appear without a reload.
        refreshGatekeeperApps(authenticatedApi)
      } else {
        const { url } = await authenticatedApi.connectAccount(vendorId, resourceUrlPatterns)
        window.open(url, '_blank', 'noopener,noreferrer')
      }
      handleCloseModal()
    } catch (err) {
      console.error('Failed to connect account:', err)
      toasts.add({ title: 'Failed to start connection', variant: 'error' })
    } finally {
      setConnecting(false)
    }
  }

  const handleEnsureResources = async (resourceUrlPatterns: string[]) => {
    if (!modalTarget || modalTarget.kind !== 'manage') return
    setEnsuringResourceUrlPatterns((prev) => [...new Set([...prev, ...resourceUrlPatterns])])
    try {
      const result = await authenticatedApi.ensureAccountResources(
        modalTarget.accountId,
        resourceUrlPatterns,
      )
      if (result.url) {
        window.open(result.url, '_blank', 'noopener,noreferrer')
      }
      // On success the new grant arrives via subscribeConnectedAccounts(); the toggle reflects it
      // once `grantedResourceUrlPatterns` updates.
    } catch (err) {
      console.error('Failed to expand account access:', err)
      toasts.add({ title: 'Failed to request additional access', variant: 'error' })
    } finally {
      setEnsuringResourceUrlPatterns((prev) =>
        prev.filter((p) => !resourceUrlPatterns.includes(p)),
      )
    }
  }

  const handleDisconnect = async () => {
    if (!modalTarget || modalTarget.kind !== 'manage') return
    setDisconnecting(true)
    try {
      await authenticatedApi.disconnectAccount(modalTarget.accountId)
      // If this was an opt-in ambient account, it's now removable and should return to "Available";
      // re-fetch the addable list so it reappears there immediately (no refresh needed).
      void queryClient.invalidateQueries({ queryKey: addableGatekeepersKey() })
      // Drop its nav entry too, if it provided a management UI.
      refreshGatekeeperApps(authenticatedApi)
      handleCloseModal()
    } catch (err) {
      console.error('Failed to disconnect account:', err)
      toasts.add({ title: 'Failed to disconnect account', variant: 'error' })
    } finally {
      setDisconnecting(false)
    }
  }

  const handleReconnect = async (accountId: number) => {
    setReconnectingAccountId(accountId)
    try {
      const { url } = await authenticatedApi.reconnectAccount(accountId)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      console.error('Failed to reconnect account:', err)
      toasts.add({ title: 'Failed to reconnect account', variant: 'error' })
    } finally {
      setReconnectingAccountId(null)
    }
  }

  const searchLower = search.toLowerCase()
  const filteredAccounts = useMemo(() => {
    const matchesSearch = (text: string | undefined) =>
      !searchLower || (text ?? '').toLowerCase().includes(searchLower)
    const resourcesForAccountFilter = (account: AccountEntry) =>
      vendors.find((v) => v.id === account.vendorId)?.supportedResources ??
      account.supportedResources

    return accounts.filter((a) => {
      const resources = resourcesForAccountFilter(a)
      return (
        matchesSearch(a.accountDescription.displayName) ||
        matchesSearch(a.accountDescription.uniqueName) ||
        matchesSearch(a.vendorDescription.displayName) ||
        matchesSearch(a.vendorDescription.tagline) ||
        resources.some((r) => matchesSearch(r.title))
      )
    })
  }, [accounts, vendors, searchLower])

  // Connectable vendors = OAuth/resource gatekeepers plus opt-in ambient ones, rendered identically.
  // An ambient vendor is recognized by `description.autoProvisionsAccount`, which routes the connect
  // action to a direct (no-OAuth) add instead.
  const availableVendors = useMemo<VendorEntry[]>(
    () => [
      ...vendors,
      ...addable,
    ],
    [vendors, addable],
  )

  const filteredAvailable = useMemo(() => {
    const matchesSearch = (text: string | undefined) =>
      !searchLower || (text ?? '').toLowerCase().includes(searchLower)

    return availableVendors.filter(
      (v) =>
        matchesSearch(v.description.displayName) ||
        matchesSearch(v.description.tagline) ||
        v.supportedResources.some((r) => matchesSearch(r.title)),
    )
  }, [availableVendors, searchLower])

  const activeAccount: AccountEntry | undefined =
    modalTarget?.kind === 'manage'
      ? accounts.find((a) => a.id === modalTarget.accountId)
      : undefined
  const activeVendor: VendorEntry | undefined =
    modalTarget?.kind === 'connect'
      ? availableVendors.find((v) => v.id === modalTarget.vendorId)
      : activeAccount
      ? availableVendors.find((v) => v.id === activeAccount.vendorId) ?? {
          id: activeAccount.vendorId,
          description: activeAccount.vendorDescription,
          supportedResources: activeAccount.supportedResources,
        }
      : undefined

  // True when the connect modal targets an ambient gatekeeper (added directly, no OAuth flow).
  const isTargetAmbient =
    modalTarget?.kind === 'connect' && !!activeVendor?.description.autoProvisionsAccount

  const sectionGridClass =
    view === 'list' ? 'flex flex-col gap-0.5' : 'grid gap-3 sm:grid-cols-2'

  const initialLoading =
    !loadError &&
    (!vendorsLoaded || !accountsLoaded) &&
    vendors.length === 0 &&
    accounts.length === 0

  return (
    <PageChrome
      title="Gatekeepers"
      actions={<ViewToggle view={view} onChange={setView} />}
    >
        <div className="mb-6">
          <div className="relative">
            <MagnifyingGlass
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search gatekeepers…"
              className="h-10 w-full rounded-lg border border-kumo-line bg-kumo-base pl-9 pr-4 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15"
            />
          </div>
        </div>

        {loadError && (
          <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-6 text-center">
            <p className="m-0 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-danger">
              Something went wrong loading your gatekeepers.
            </p>
            <p className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              Check your connection and try refreshing the page.
            </p>
          </div>
        )}

        {filteredAccounts.length > 0 && (
          <section className="mb-10">
            <SectionEyebrow label="Connected" count={filteredAccounts.length} />
            <div className={sectionGridClass}>
              {filteredAccounts.map((account) => {
                const displayName =
                  account.accountDescription.displayName ??
                  account.accountDescription.uniqueName ??
                  'Connected'
                const tagline = account.vendorDescription.tagline
                return (
                  <ConnectorCard
                    key={account.id}
                    logoUrl={account.vendorDescription.logo?.url}
                    color={account.vendorDescription.color}
                    fallback={account.vendorDescription.displayName}
                    name={account.vendorDescription.displayName}
                    metaLine={
                      <span
                        className={`truncate ${
                          account.credentialsValid ? '' : 'text-kumo-danger'
                        }`}
                      >
                        {account.credentialsValid
                          ? displayName
                          : 'Credentials expired'}
                      </span>
                    }
                    tagline={tagline}
                    state={account.credentialsValid ? 'connected' : 'expired'}
                    onClick={() => handleOpenManage(account.id)}
                    onReconnect={() => handleReconnect(account.id)}
                    reconnectBusy={reconnectingAccountId === account.id}
                    view={view}
                  />
                )
              })}
            </div>
          </section>
        )}

        {filteredAvailable.length > 0 && (
          <section className="mb-10">
            <SectionEyebrow label="Available" />
            <div className={sectionGridClass}>

              {filteredAvailable.map((vendor) => (
                <ConnectorCard
                  key={vendor.id}
                  logoUrl={vendor.description.logo?.url}
                  color={vendor.description.color}
                  fallback={vendor.description.displayName}
                  name={vendor.description.displayName}
                  tagline={vendor.description.tagline}
                  state="available"
                  onClick={() => handleOpenConnect(vendor.id)}
                  view={view}
                />
              ))}
            </div>
          </section>
        )}

        {!initialLoading &&
          !loadError &&
          filteredAccounts.length === 0 &&
          filteredAvailable.length === 0 && (
            <EmptyState
              title={
                search
                  ? 'No gatekeepers match'
                  : 'No gatekeepers yet'
              }
              description={
                search
                  ? "We couldn't find anything matching your search."
                  : 'Gatekeepers will appear here as they become available in your workspace.'
              }
              icon={Plugs}
            />
          )}

      {activeVendor && (
        <ConnectConnectorModal
          key={modalTarget?.kind === 'manage'
            ? `manage:${modalTarget.accountId}`
            : `connect:${modalTarget?.vendorId ?? ''}`}
          open={modalTarget !== null}
          mode={modalTarget?.kind === 'manage' ? 'manage' : 'connect'}
          vendorDescription={activeVendor.description}
          supportedResources={activeVendor.supportedResources}
          logoUrl={activeVendor.description.logo?.url}
          color={activeVendor.description.color}
          autoProvisions={isTargetAmbient}
          connecting={connecting}
          onConfirm={handleConfirmConnect}
          accountDescription={activeAccount?.accountDescription}
          credentialsValid={activeAccount?.credentialsValid}
          grantedResourceUrlPatterns={activeAccount?.accountDescription.grantedResourceUrlPatterns}
          onEnsureResources={handleEnsureResources}
          ensuringResourceUrlPatterns={ensuringResourceUrlPatterns}
          disconnecting={disconnecting}
          onDisconnect={handleDisconnect}
          onOpenChange={(open) => {
            if (!open && !connecting && !disconnecting) handleCloseModal()
          }}
        />
      )}
    </PageChrome>
  )
}
