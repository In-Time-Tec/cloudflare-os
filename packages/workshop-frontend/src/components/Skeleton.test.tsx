// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Avatar, ListRow, PaneHeader } from '../conversations/primitives'
import { Skeleton, SkeletonText } from './Skeleton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The contract these tests defend: a loading row and a loaded row are the same boxes.
//
// jsdom does no layout, so heights can't be measured here — what *can* be pinned is the thing that
// makes the heights equal in a real browser, namely that both states emit the same containers with
// the same spacing classes and the same number of text lines. The measured proof (identical top and
// height for every element, in headless Chromium) is in the PR; this is the regression guard.

function classesOf(root: HTMLElement): string[] {
  return [...root.querySelectorAll('*')].map(el => el.className.toString())
}

describe('loading and loaded rows occupy the same box', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  function render(node: React.ReactNode): HTMLElement {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(node))
    return container
  }

  it('ListRow keeps its padding, gap and line count while loading', () => {
    const loading = classesOf(render(<ListRow />)).join(' ')
    act(() => root!.unmount())
    container!.remove()
    const loaded = classesOf(render(
      <ListRow avatar={<Avatar title="Cody plusone" size="md" />} title="Cody plusone"
          meta="11:24 AM" preview="Sounds good" onClick={() => {}} />,
    )).join(' ')

    for (const box of ['px-3 py-2', 'gap-2.5', 'min-w-0 flex-1', 'items-baseline justify-between gap-2']) {
      expect(loading).toContain(box)
      expect(loaded).toContain(box)
    }
    // Same avatar diameter and the same three text leaves in both states.
    expect(loading).toContain('size-8')
    expect(loaded).toContain('size-8')
    expect(loading).toContain('text-[13px]')
    expect(loading).toContain('text-[10.5px]')
    expect(loading).toContain('text-[12px]')
  })

  it('PaneHeader holds its h-14 band and hairline while loading', () => {
    const loading = classesOf(render(<PaneHeader />)).join(' ')
    act(() => root!.unmount())
    container!.remove()
    const loaded = classesOf(render(<PaneHeader title="Subject" subtitle="From someone" />)).join(' ')
    for (const cls of ['h-14', 'border-b', 'border-kumo-line', 'px-4']) {
      expect(loading).toContain(cls)
      expect(loaded).toContain(cls)
    }
  })

  it('a placeholder text bar is one line box tall at the inherited size', () => {
    const el = render(<SkeletonText width="w-24" className="text-[13px]" />)
    const bar = el.querySelector('span')!
    expect(bar.className).toContain('h-[1lh]')
    expect(bar.className).toContain('text-[13px]')
    // A baseline to align to — without it, items-baseline rows sit the bar a fraction off.
    expect(bar.textContent).toBe('\u200b')
  })

  it('placeholders are hidden from assistive tech and respect reduced motion', () => {
    const el = render(<Skeleton className="h-4 w-4" />)
    const bar = el.querySelector('span')!
    expect(bar.getAttribute('aria-hidden')).toBe('true')
    expect(bar.className).toContain('motion-safe:animate-pulse')
  })

  it('a loaded row renders its text rather than a placeholder', () => {
    const el = render(<SkeletonText>Cody plusone</SkeletonText>)
    expect(el.textContent).toBe('Cody plusone')
    expect(el.querySelector('[aria-hidden="true"]')).toBeNull()
  })
})
