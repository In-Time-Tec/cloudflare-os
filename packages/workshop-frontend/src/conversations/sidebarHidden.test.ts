// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  SIDEBAR_HIDDEN_KEY,
  clearSidebarHidden,
  hideSidebarItem,
  readSidebarHidden,
  visibleSidebarItems,
  writeSidebarHidden,
} from './sidebarHidden'

describe('sidebarHidden', () => {
  afterEach(() => {
    localStorage.removeItem(SIDEBAR_HIDDEN_KEY)
  })

  it('hides an id once and leaves later calls unchanged', () => {
    const first = hideSidebarItem({
      conversations: [],
      channels: [],
      emails: [],
    }, 'channels', 'team/general')
    expect(first.channels).toEqual(['team/general'])
    expect(hideSidebarItem(first, 'channels', 'team/general')).toBe(first)
  })

  it('clears one kind without touching the others', () => {
    const current = {
      conversations: ['a'],
      channels: ['b'],
      emails: ['c'],
    }
    expect(clearSidebarHidden(current, 'emails')).toEqual({
      conversations: ['a'],
      channels: ['b'],
      emails: [],
    })
  })

  it('filters visible items by the hidden id list', () => {
    const items = [{ id: 'keep' }, { id: 'gone' }]
    expect(visibleSidebarItems(items, ['gone'], (item) => item.id)).toEqual([{ id: 'keep' }])
    expect(visibleSidebarItems(items, [], (item) => item.id)).toBe(items)
  })

  it('round-trips through localStorage and ignores junk', () => {
    writeSidebarHidden({
      conversations: ['chat:1'],
      channels: [],
      emails: ['m-2'],
    })
    expect(readSidebarHidden()).toEqual({
      conversations: ['chat:1'],
      channels: [],
      emails: ['m-2'],
    })
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, '{not-json')
    expect(readSidebarHidden()).toEqual({
      conversations: [],
      channels: [],
      emails: [],
    })
  })
})
