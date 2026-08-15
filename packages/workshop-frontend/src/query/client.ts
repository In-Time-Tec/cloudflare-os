import { QueryClient } from '@tanstack/react-query'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import type { PersistedClient } from '@tanstack/query-persist-client-core'
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
export // RPC payloads carry Date objects; a JSON round-trip turns them into strings, which crashes
// consumers calling `.getTime()` on restore. Revive ISO date strings recursively on read.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

function reviveDates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveDates)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) {
      out[key] = typeof entry === 'string' && ISO_DATE.test(entry) ? new Date(entry) : reviveDates(entry)
    }
    return out
  }
  return value
}

export const asyncPersister = createAsyncStoragePersister({
  storage: { getItem: idbGet, setItem: idbSet, removeItem: idbDel },
  key: 'WORKSHOP_QUERY_CACHE_V2',
  throttleTime: 1000,
  deserialize: (cachedString) => reviveDates(JSON.parse(cachedString)) as PersistedClient,
})
