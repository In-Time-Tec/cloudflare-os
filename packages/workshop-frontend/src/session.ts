import { useSyncExternalStore } from 'react'
import { RpcStub, newWebSocketRpcSession } from 'capnweb'
import type { AdminApi, AuthenticatedApi, PublicApi } from '@gadgets/workshop-shared/api'
import type { ConversationsApi } from '@gadgets/workshop-shared/gatekeeper'

export const AUTH_TOKEN_KEY = 'authToken'
export const CF_ACCESS_MODE = import.meta.env.VITE_CF_ACCESS_MODE === 'true'
export const ANONYMOUS_CACHE_SCOPE = 'anonymous'

export type WorkshopSessionSnapshot = {
  publicApi: RpcStub<PublicApi>
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  isAuthenticated: boolean
  connectionLost: boolean
  cacheScope: string
  token: string | null
  revision: number
}

export type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type SessionDeps = {
  startConnection: () => RpcStub<PublicApi>
  storage: SessionStorage
  now: () => number
  wait: (ms: number) => Promise<void>
}

function getBackendHost(): string {
  if (import.meta.env.DEV) {
    return import.meta.env.VITE_BACKEND_HOST?.trim() || 'localhost:8787'
  }
  return window.location.host
}

export function startWorkshopConnection(): RpcStub<PublicApi> {
  const apiHost = getBackendHost()
  const wsUrl = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + apiHost + '/api'
  return newWebSocketRpcSession<PublicApi>(wsUrl)
}

async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

const defaultDeps = (): SessionDeps => ({
  startConnection: startWorkshopConnection,
  storage: typeof window === 'undefined'
    ? { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    : window.localStorage,
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})

export class WorkshopSession {
  publicApi!: RpcStub<PublicApi>
  authenticatedApi: RpcStub<AuthenticatedApi> | null = null
  token: string | null = null
  connectionLost = false
  cacheScope = ANONYMOUS_CACHE_SCOPE
  revision = 0

  private listeners = new Set<() => void>()
  private reconnectListeners = new Set<() => void>()
  private logoutCleanup: ((scope: string) => Promise<void>) | null = null
  private conversationsApi: RpcStub<ConversationsApi> | null = null
  private conversationsTask: Promise<RpcStub<ConversationsApi> | null> | null = null
  private adminApi: RpcStub<AdminApi> | null = null
  private lastConnectTime = 0
  private backoff = 1000
  private reconnecting = false
  private readonly deps: SessionDeps

  constructor(deps: Partial<SessionDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): number => this.revision

  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener)
    return () => {
      this.reconnectListeners.delete(listener)
    }
  }

  setLogoutCleanup(fn: (scope: string) => Promise<void>): void {
    this.logoutCleanup = fn
  }

  get isAuthenticated(): boolean {
    return this.authenticatedApi !== null
  }

  requireAuthenticatedApi(): RpcStub<AuthenticatedApi> {
    if (!this.authenticatedApi) throw new Error('Not authenticated yet')
    return this.authenticatedApi
  }

  connect(): void {
    this.publicApi = this.deps.startConnection()
    this.lastConnectTime = this.deps.now()
    this.publicApi.onRpcBroken((error) => {
      void this.handleBroken(error)
    })
    this.emit()
  }

  async applyStoredAuth(): Promise<void> {
    if (CF_ACCESS_MODE) {
      await this.authenticateFromCfAccess()
      return
    }
    const token = this.deps.storage.getItem(AUTH_TOKEN_KEY)
    if (token) await this.authenticateWithToken(token)
  }

  async authenticateWithToken(token: string): Promise<void> {
    this.token = token
    this.cacheScope = await hashToken(token)
    this.deps.storage.setItem(AUTH_TOKEN_KEY, token)
    this.replaceAuthenticatedApi(this.publicApi.authenticate(token))
  }

  async authenticateFromCfAccess(): Promise<void> {
    const api = this.publicApi.authenticateFromCfAccess()
    this.replaceAuthenticatedApi(api)
    const who = await api.whoami()
    this.cacheScope = who.id
    this.emit()
  }

  markAlive(): void {
    if (!this.connectionLost) return
    this.connectionLost = false
    this.emit()
  }

  async ensureConversationsApi(): Promise<RpcStub<ConversationsApi> | null> {
    if (this.conversationsTask) return this.conversationsTask
    const api = this.authenticatedApi
    if (!api) return null
    this.conversationsTask = api.getConversationsApi()
      .then((stub) => {
        this.conversationsApi = stub
        return stub
      })
      .catch(() => {
        this.conversationsApi = null
        this.conversationsTask = null
        return null
      })
    return this.conversationsTask
  }

  async ensureAdminApi(): Promise<RpcStub<AdminApi> | null> {
    if (this.adminApi) return this.adminApi
    const api = this.authenticatedApi
    if (!api) return null
    const admin = await api.getAdminApi()
    this.adminApi = admin
    return admin
  }

  async logout(): Promise<void> {
    if (CF_ACCESS_MODE) {
      window.location.assign('/cdn-cgi/access/logout')
      return
    }
    const scope = this.cacheScope
    const api = this.authenticatedApi
    this.authenticatedApi = null
    this.token = null
    this.cacheScope = ANONYMOUS_CACHE_SCOPE
    this.deps.storage.removeItem(AUTH_TOKEN_KEY)
    this.resetCapabilities()
    if (api) {
      api.logout().catch(() => {}).finally(() => api[Symbol.dispose]())
    }
    this.emit()
    await this.logoutCleanup?.(scope)
  }

  private replaceAuthenticatedApi(next: RpcStub<AuthenticatedApi>): void {
    const prev = this.authenticatedApi
    this.authenticatedApi = next
    this.resetCapabilities()
    if (prev && prev !== next) prev[Symbol.dispose]()
    this.connectionLost = false
    this.emit()
  }

  private resetCapabilities(): void {
    this.conversationsApi?.[Symbol.dispose]()
    this.conversationsApi = null
    this.conversationsTask = null
    this.adminApi?.[Symbol.dispose]()
    this.adminApi = null
  }

  private async handleBroken(_error: unknown): Promise<void> {
    this.connectionLost = true
    this.emit()
    if (this.reconnecting) return
    this.reconnecting = true
    try {
      const timeSinceConnect = this.deps.now() - this.lastConnectTime
      if (timeSinceConnect < this.backoff) {
        await this.deps.wait(this.backoff - timeSinceConnect)
        this.backoff = Math.min(this.backoff * 2, 10000)
      } else {
        this.backoff = 1000
      }
      const nextPublic = this.deps.startConnection()
      this.lastConnectTime = this.deps.now()
      nextPublic.onRpcBroken((error) => {
        void this.handleBroken(error)
      })
      const prevPublic = this.publicApi
      this.publicApi = nextPublic
      if (this.token) {
        this.replaceAuthenticatedApi(nextPublic.authenticate(this.token))
      } else if (CF_ACCESS_MODE) {
        this.replaceAuthenticatedApi(nextPublic.authenticateFromCfAccess())
      } else {
        this.emit()
      }
      prevPublic?.[Symbol.dispose]()
      for (const listener of this.reconnectListeners) listener()
    } finally {
      this.reconnecting = false
    }
  }

  private emit(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}

export const workshopSession = new WorkshopSession()

export function useWorkshopSession(): WorkshopSession {
  useSyncExternalStore(workshopSession.subscribe, workshopSession.getSnapshot)
  return workshopSession
}

export function useConnectionLost(): boolean {
  const session = useWorkshopSession()
  return session.connectionLost
}

export function useRpcStub(): RpcStub<PublicApi> {
  return useWorkshopSession().publicApi
}
