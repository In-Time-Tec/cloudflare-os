// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The rail renders complete or not at all, so this gate decides when the shell may paint. Its two
// failure modes are both invisible in a type check and both severe: opening too early shows an
// empty rail that then fills in (the flash it exists to prevent), and never opening leaves a blank
// window forever. These pin both ends.

const mocks = vi.hoisted(() => ({
  gadgets: { isSuccess: false },
  apps: { isSuccess: false },
  conversations: {
    available: null as boolean | null,
    conversationsReady: false, channelsReady: false, emailsReady: false,
  },
  isRestoring: false,
}))

vi.mock('../../query/hooks', () => ({
  useGadgets: () => mocks.gadgets,
  useGatekeeperApps: () => mocks.apps,
}))
vi.mock('../../conversations/ConversationsContext', () => ({
  useConversations: () => mocks.conversations,
}))
vi.mock('@tanstack/react-query', () => ({ useIsRestoring: () => mocks.isRestoring }))

const { useSidebarReady } = await import('./useSidebarReady')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useSidebarReady', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.gadgets = { isSuccess: false }
    mocks.apps = { isSuccess: false }
    mocks.conversations = {
      available: null, conversationsReady: false, channelsReady: false, emailsReady: false,
    }
    mocks.isRestoring = false
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.useRealTimers()
  })

  function ready(): boolean {
    let value = false
    function Probe() { value = useSidebarReady(); return null }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(<Probe />))
    return value
  }

  it('waits while the persisted cache is still being restored', () => {
    mocks.isRestoring = true
    mocks.gadgets = { isSuccess: true }
    mocks.apps = { isSuccess: true }
    mocks.conversations = {
      available: true, conversationsReady: true, channelsReady: true, emailsReady: true,
    }
    // Everything reports ready, but restoring means those are reads of an empty cache.
    expect(ready()).toBe(false)
  })

  it('waits for the workspace lists and the gatekeeper nav rows', () => {
    mocks.conversations = {
      available: false, conversationsReady: false, channelsReady: false, emailsReady: false,
    }
    expect(ready()).toBe(false)
    mocks.gadgets = { isSuccess: true }
    expect(ready()).toBe(false)
    mocks.apps = { isSuccess: true }
    expect(ready()).toBe(true)
  })

  it('waits while the comms capability is still being probed', () => {
    mocks.gadgets = { isSuccess: true }
    mocks.apps = { isSuccess: true }
    mocks.conversations.available = null
    expect(ready()).toBe(false)
  })

  it('does not wait on comms lists for an account that has no comms', () => {
    mocks.gadgets = { isSuccess: true }
    mocks.apps = { isSuccess: true }
    mocks.conversations.available = false
    expect(ready()).toBe(true)
  })

  it('waits for every comms list when the account has them', () => {
    mocks.gadgets = { isSuccess: true }
    mocks.apps = { isSuccess: true }
    mocks.conversations = {
      available: true, conversationsReady: true, channelsReady: true, emailsReady: false,
    }
    expect(ready()).toBe(false)
    mocks.conversations.emailsReady = true
    expect(ready()).toBe(true)
  })

  it('opens on the deadline so a stalled query cannot blank the window forever', () => {
    // Nothing ready, and the comms queries are enabled-gated on a capability that may never
    // arrive — without the deadline this state would hang indefinitely.
    const seen: boolean[] = []
    function Probe() { seen.push(useSidebarReady()); return null }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(<Probe />))
    expect(seen.at(-1)).toBe(false)

    act(() => { vi.advanceTimersByTime(3000) })
    expect(seen.at(-1)).toBe(true)
  })
})
