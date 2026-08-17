import {
  defaultShouldDehydrateQuery,
  QueryClient,
  type DehydrateOptions,
} from '@tanstack/react-query'
import type {
  PersistedClient,
  Persister,
  PersistQueryClientOptions,
} from '@tanstack/query-persist-client-core'
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval'

export type WorkshopQueryMeta = Record<string, unknown> & {
  persist?: true
}

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: WorkshopQueryMeta
  }
}

export const QUERY_CACHE_MAX_AGE = 24 * 60 * 60 * 1000
export const QUERY_CACHE_BUSTER = 'v3'
export const persistedQueryMeta = { persist: true } satisfies WorkshopQueryMeta

export type QueryPersistenceStorage = {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
}

const indexedDbStorage: QueryPersistenceStorage = {
  get: key => idbGet(key),
  set: (key, value) => idbSet(key, value),
  delete: key => idbDel(key),
}

export function cacheStoreKey(scope: string): string {
  return `WORKSHOP_QUERY_CACHE_V3:${encodeURIComponent(scope)}`
}

export function shouldDehydrateQuery(query: Parameters<typeof defaultShouldDehydrateQuery>[0]): boolean {
  return defaultShouldDehydrateQuery(query) && query.meta?.persist === true
}

export const queryDehydrateOptions = {
  shouldDehydrateQuery,
  shouldDehydrateMutation: () => false,
} satisfies DehydrateOptions

export function createWorkshopQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: QUERY_CACHE_MAX_AGE,
        retry: (failureCount, error) => {
          const flag = (error as { retryable?: boolean } | null | undefined)?.retryable
          return flag === true && failureCount < 1
        },
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      dehydrate: queryDehydrateOptions,
    },
  })
}

export const queryClient = createWorkshopQueryClient()

function filterPersistedClient(client: PersistedClient): PersistedClient {
  return {
    ...client,
    clientState: {
      mutations: [],
      queries: client.clientState.queries.filter(
        query => query.meta?.persist === true && query.state.status === 'success',
      ),
    },
  }
}

export function createAccountPersister(
  scope: string,
  storage: QueryPersistenceStorage = indexedDbStorage,
): Persister {
  const key = cacheStoreKey(scope)
  return {
    persistClient: client => storage.set(key, filterPersistedClient(client)),
    restoreClient: () => storage.get<PersistedClient>(key),
    removeClient: () => storage.delete(key),
  }
}

export function createAccountPersistOptions(
  scope: string,
  storage: QueryPersistenceStorage = indexedDbStorage,
): Omit<PersistQueryClientOptions, 'queryClient'> {
  return {
    persister: createAccountPersister(scope, storage),
    maxAge: QUERY_CACHE_MAX_AGE,
    buster: QUERY_CACHE_BUSTER,
    dehydrateOptions: queryDehydrateOptions,
  }
}
