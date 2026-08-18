import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, AiChatHistoryPage, AiChatMetadata, GadgetMetadata } from '@gadgets/workshop-shared/api'
import {
  clearThreadBoots,
  ensureThreadBoot,
  takeThreadBoot,
} from './thread-session'

afterEach(() => {
  clearThreadBoots()
})

describe('ensureThreadBoot', () => {
  it('opens the thread and stashes chats before navigation', async () => {
    const chats: AiChatMetadata[] = [{
      id: 0,
      title: 'New chat',
      started: new Date(),
      lastActive: new Date(),
      hasProposedChanges: false,
    }]
    const metadata = { id: 'w1', title: 'Daily Brief' } as GadgetMetadata
    const overseer = {
      subscribeToMetadata: vi.fn<(cb: (meta: GadgetMetadata) => void) => Promise<{ [Symbol.dispose](): void }>>(
        async (cb) => {
          cb(metadata)
          return { [Symbol.dispose]: () => {} }
        },
      ),
      listChats: vi.fn<() => Promise<AiChatMetadata[]>>(async () => chats),
      listModels: vi.fn<() => Promise<AiChatAuthorInfo[]>>(async () => [{ id: 'm1', name: 'Model' } as AiChatAuthorInfo]),
      getChatHistory: vi.fn<() => Promise<AiChatHistoryPage>>(async () => ({ messages: [] }) as AiChatHistoryPage),
      subscribeToWorkpieces: vi.fn<(subscriber: { ready(): void }) => Promise<{ [Symbol.dispose](): void }>>(
        async (subscriber) => {
          subscriber.ready()
          return { [Symbol.dispose]: () => {} }
        },
      ),
      [Symbol.dispose]: vi.fn<() => void>(),
    }
    const api = {
      openGadget: vi.fn<() => typeof overseer>(() => overseer),
    }
    const boot = await ensureThreadBoot('w1', api as never)
    expect(boot.metadata.title).toBe('Daily Brief')
    expect(boot.chats).toEqual(chats)
    expect(boot.workpieces).toEqual([])
    expect(takeThreadBoot('w1')).toBe(boot)
    expect(takeThreadBoot('w1')).toBeNull()
  })
})
