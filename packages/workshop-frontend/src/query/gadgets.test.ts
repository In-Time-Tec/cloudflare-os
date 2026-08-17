// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { pinGadgetOptions, renameGadgetOptions } from './gadgets'
import type { WorkshopSession } from '../session'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

function gadget(partial: Partial<GadgetMetadataWithTimestamps> & { id: string }): GadgetMetadataWithTimestamps {
  return {
    title: 'A',
    pinned: false,
    lastActive: new Date('2026-01-01T00:00:00.000Z'),
    created: new Date('2026-01-01T00:00:00.000Z'),
    totalCost: 0,
    ...partial,
  } as GadgetMetadataWithTimestamps
}

describe('gadget mutations', () => {
  it('updates every observer and rolls back a failed pin', async () => {
    const setPinned = vi.fn<() => Promise<void>>(async () => {
      throw new Error('nope')
    })
    const session = {
      cacheScope: 'acct',
      requireAuthenticatedApi: () => ({
        openGadget: () => ({
          setPinned,
          [Symbol.dispose]: () => {},
        }),
      }),
    } as unknown as WorkshopSession
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const options = pinGadgetOptions(session, client)
    client.setQueryData(['account', 'acct', 'gadgets'], [gadget({ id: '1' }), gadget({ id: '2', title: 'B' })])

    const ctx = await options.onMutate?.({ id: '1', pinned: true }, undefined as never)
    expect(client.getQueryData(['account', 'acct', 'gadgets'])).toEqual([
      expect.objectContaining({ id: '1', pinned: true }),
      expect.objectContaining({ id: '2', pinned: false }),
    ])
    options.onError?.(new Error('nope'), { id: '1', pinned: true }, ctx, undefined as never)
    expect(client.getQueryData(['account', 'acct', 'gadgets'])).toEqual([
      expect.objectContaining({ id: '1', pinned: false }),
      expect.objectContaining({ id: '2' }),
    ])
  })

  it('serializes conflicting gadget writes through one mutation scope', () => {
    const session = {
      cacheScope: 'acct',
      requireAuthenticatedApi: () => ({ openGadget: () => ({ setTitle: async () => {}, [Symbol.dispose]: () => {} }) }),
    } as unknown as WorkshopSession
    const client = new QueryClient()
    expect(pinGadgetOptions(session, client).scope).toEqual({ id: 'gadgets' })
    expect(renameGadgetOptions(session, client).scope).toEqual({ id: 'gadgets' })
  })
})
