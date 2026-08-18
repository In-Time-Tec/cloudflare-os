// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { pinThreadOptions, renameThreadOptions } from './threads'
import type { WorkshopSession } from '../session'
import type { ThreadMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

function thread(partial: Partial<ThreadMetadataWithTimestamps> & { id: string }): ThreadMetadataWithTimestamps {
  return {
    title: 'A',
    pinned: false,
    lastActive: new Date('2026-01-01T00:00:00.000Z'),
    created: new Date('2026-01-01T00:00:00.000Z'),
    totalCost: 0,
    ...partial,
  } as ThreadMetadataWithTimestamps
}

describe('thread mutations', () => {
  it('updates every observer and rolls back a failed pin', async () => {
    const setPinned = vi.fn<() => Promise<void>>(async () => {
      throw new Error('nope')
    })
    const session = {
      cacheScope: 'acct',
      requireAuthenticatedApi: () => ({
        openThread: () => ({
          setPinned,
          [Symbol.dispose]: () => {},
        }),
      }),
    } as unknown as WorkshopSession
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const options = pinThreadOptions(session, client)
    client.setQueryData(['account', 'acct', 'threads'], [thread({ id: '1' }), thread({ id: '2', title: 'B' })])

    const ctx = await options.onMutate?.({ id: '1', pinned: true }, undefined as never)
    expect(client.getQueryData(['account', 'acct', 'threads'])).toEqual([
      expect.objectContaining({ id: '1', pinned: true }),
      expect.objectContaining({ id: '2', pinned: false }),
    ])
    options.onError?.(new Error('nope'), { id: '1', pinned: true }, ctx, undefined as never)
    expect(client.getQueryData(['account', 'acct', 'threads'])).toEqual([
      expect.objectContaining({ id: '1', pinned: false }),
      expect.objectContaining({ id: '2' }),
    ])
  })

  it('serializes conflicting thread writes through one mutation scope', () => {
    const session = {
      cacheScope: 'acct',
      requireAuthenticatedApi: () => ({ openThread: () => ({ setTitle: async () => {}, [Symbol.dispose]: () => {} }) }),
    } as unknown as WorkshopSession
    const client = new QueryClient()
    expect(pinThreadOptions(session, client).scope).toEqual({ id: 'threads' })
    expect(renameThreadOptions(session, client).scope).toEqual({ id: 'threads' })
  })
})
