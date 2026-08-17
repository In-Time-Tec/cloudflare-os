import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient, dehydrate } from '@tanstack/react-query'
import type { PersistedClient } from '@tanstack/query-persist-client-core'
import { cacheStoreKey, createAccountPersister, persistQueryData, shouldDehydrateQuery } from './client'

describe('query persistence', () => {
  const store = new Map<string, unknown>()
  const kv = {
    get: async <T,>(key: string) => store.get(key) as T | undefined,
    set: async <T,>(key: string, value: T) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  }

  afterEach(() => store.clear())

  it('dehydrates only successful queries with meta.persist', async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        dehydrate: {
          shouldDehydrateQuery,
          shouldDehydrateMutation: () => false,
        },
      },
    })
    await client.fetchQuery({
      queryKey: ['account', 'a', 'gadgets'],
      queryFn: async () => [{ id: '1', lastActive: new Date('2026-08-15T12:00:00.000Z') }],
      meta: { persist: true },
    })
    await client.fetchQuery({
      queryKey: ['account', 'a', 'secret'],
      queryFn: async () => ({ token: 'nope' }),
    })
    const state = dehydrate(client)
    const keys = state.queries.map((query) => query.queryKey[2])
    expect(keys).toContain('gadgets')
    expect(keys).not.toContain('secret')
  })

  it('round-trips Date values through the native persister', async () => {
    const persister = createAccountPersister('acct-1', kv)
    const when = new Date('2026-08-15T12:00:00.000Z')
    const payload = {
      timestamp: Date.now(),
      buster: 'v3',
      clientState: {
        mutations: [],
        queries: [{
          dehydratedAt: Date.now(),
          meta: { persist: true },
          state: {
            data: { received: when },
            dataUpdateCount: 1,
            dataUpdatedAt: 1,
            error: null,
            errorUpdateCount: 0,
            errorUpdatedAt: 0,
            fetchFailureCount: 0,
            fetchFailureReason: null,
            fetchMeta: null,
            isInvalidated: false,
            status: 'success',
            fetchStatus: 'idle',
          },
          queryKey: ['account', 'acct-1', 'emails'],
          queryHash: '["account","acct-1","emails"]',
        }],
      },
    } as PersistedClient
    await persister.persistClient(payload)
    const restored = await persister.restoreClient()
    const received = restored?.clientState.queries[0]?.state.data as { received: Date }
    expect(received.received).toBeInstanceOf(Date)
    expect(received.received.getTime()).toBe(when.getTime())
  })

  it('marks set snapshots as persistable', async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        dehydrate: {
          shouldDehydrateQuery,
          shouldDehydrateMutation: () => false,
        },
      },
    })
    await persistQueryData(client, ['account', 'a', 'gatekeeperAppSnapshot', 'scheduler'], {
      schedules: [{ title: 'Morning brief' }],
    })
    const state = dehydrate(client)
    expect(state.queries.some((query) => query.queryKey[2] === 'gatekeeperAppSnapshot')).toBe(true)
  })

  it('scopes stores per account', () => {
    expect(cacheStoreKey('one')).not.toBe(cacheStoreKey('two'))
    expect(cacheStoreKey('one')).toBe('WORKSHOP_QUERY_CACHE_V3:one')
  })

  it('removes an account store on logout', async () => {
    const persister = createAccountPersister('acct-1', kv)
    await persister.persistClient({
      timestamp: 1,
      buster: 'v3',
      clientState: { mutations: [], queries: [] },
    })
    expect(await persister.restoreClient()).toBeTruthy()
    await persister.removeClient()
    expect(await persister.restoreClient()).toBeUndefined()
  })
})
