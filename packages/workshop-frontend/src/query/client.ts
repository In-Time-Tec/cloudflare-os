import { QueryClient } from '@tanstack/react-query'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval'

// Persisted queries are read-mostly, non-secret, plain-data responses that make the sidebar and
// pages render instantly on reload. Mutations and anything returning RPC stubs are never persisted
// (stubs can't survive a page reload and must not be cached).
const PERSISTED_PREFIXES = new Set([
  'whoami', 'gadgets', 'gatekeeperApps',
  'conversations', 'channels', 'emails', 'agenda',
  'messages', 'emailDetail', 'outputs', 'models', 'aiConfig',
])

/** The key under which a query's data is stored; null when the query must never persist. */
export function persistedQueryKey(queryKey: readonly unknown[]): string | null {
  const head = queryKey[0]
  if (typeof head !== 'string') return null
  // Nested scoped keys start with the resource name, e.g. ['messages', refKey].
  return PERSISTED_PREFIXES.has(head) ? head : null
}

/**
 * The single QueryClient for the Workshop. staleTime is short (30s) for fresh-but-instant data;
 * gcTime is generous so navigated-away queries stay warm for the back button. Reads always render
 * cached data immediately and revalidate in the background.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 30 * 60_000,
      retry: (failureCount, error) => {
        // Retry connection/do-reset errors once; never retry terminal failures (auth, not-found).
        const flag = (error as { retryable?: boolean } | null | undefined)?.retryable
        return flag === true && failureCount < 1
      },
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
})

/** IndexedDB persister (async, off the main thread). Keyed for schema versioning. */
export const asyncPersister = createAsyncStoragePersister({
  storage: { getItem: idbGet, setItem: idbSet, removeItem: idbDel },
  key: 'WORKSHOP_QUERY_CACHE_V1',
  throttleTime: 1000,
})
