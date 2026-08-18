// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIDEBAR_PREVIEW_DELAY_MS, SIDEBAR_PREVIEW_HANDOFF_MS, hoverRowClassName } from './sidebarHover'
import {
  HoverActionBar,
  HoverFadeLabel,
  HoverRowTrail,
  SidebarHoverPreviewProvider,
  useRowPreview,
} from './SidebarHoverRow'
import type { SidebarHoverPreview } from './sidebarHover'

vi.mock('@cloudflare/kumo', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness({
  onParent,
  onHide,
  preview,
}: {
  onParent: () => void
  onHide: () => void
  preview?: SidebarHoverPreview
}) {
  const { rowRef, previewBind, previewPortal } = useRowPreview(preview)
  return (
    <>
      <a
        ref={rowRef as Ref<HTMLAnchorElement>}
        href="/channels"
        className={hoverRowClassName({ hasActions: true, className: 'h-7 gap-1.5 rounded-md px-2.5' })}
        onClick={(event) => {
          event.preventDefault()
          onParent()
        }}
        {...previewBind}
      >
        <HoverRowTrail>
          <HoverFadeLabel>Simplot Opsys</HoverFadeLabel>
          <HoverActionBar
            actions={[{ label: 'Hide channel', icon: <span>H</span>, onSelect: onHide }]}
          />
        </HoverRowTrail>
      </a>
      {previewPortal}
    </>
  )
}

describe('SidebarHoverRow', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    vi.useRealTimers()
    act(() => root?.unmount())
    container?.remove()
  })

  function render(preview?: SidebarHoverPreview) {
    const onParent = vi.fn<() => void>()
    const onHide = vi.fn<() => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(
      <SidebarHoverPreviewProvider>
        <Harness onParent={onParent} onHide={onHide} preview={preview} />
      </SidebarHoverPreviewProvider>,
    ))
    return { onParent, onHide, host: container! }
  }

  it('fades the label only when the row has actions', () => {
    expect(hoverRowClassName({ hasActions: true })).toContain('sidebar-hover-has-actions')
    expect(hoverRowClassName({})).not.toContain('sidebar-hover-has-actions')
  })

  it('lets an action fire without following the row', () => {
    const { onParent, onHide, host } = render()
    const hide = host.querySelector('[aria-label="Hide channel"]') as HTMLButtonElement
    act(() => hide.click())
    expect(onHide).toHaveBeenCalledTimes(1)
    expect(onParent).not.toHaveBeenCalled()
  })

  it('shows the preview after the hover delay', () => {
    const { host } = render({
      title: 'Simplot Opsys',
      meta: 'Updated 3m ago',
      body: 'Ada: Ship the build',
      footer: 'Operations',
    })
    vi.useFakeTimers()
    const row = host.querySelector('a')!
    act(() => {
      row.focus()
    })
    expect(document.body.querySelector('[data-sidebar-preview]')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PREVIEW_DELAY_MS)
    })
    const card = document.body.querySelector('[data-sidebar-preview]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Simplot Opsys')
    expect(card!.textContent).toContain('Ada: Ship the build')
    expect(card!.textContent).toContain('Operations')
  })

  it('updates the open preview immediately when moving to the next row', () => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(
      <SidebarHoverPreviewProvider>
        <Harness
          onParent={() => {}}
          onHide={() => {}}
          preview={{ title: 'First thread', meta: 'Updated 1m ago' }}
        />
        <Harness
          onParent={() => {}}
          onHide={() => {}}
          preview={{ title: 'Second thread', meta: 'Updated 2m ago' }}
        />
      </SidebarHoverPreviewProvider>,
    ))
    const [first, second] = Array.from(container.querySelectorAll('a'))
    act(() => {
      first.focus()
    })
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PREVIEW_DELAY_MS)
    })
    const card = document.body.querySelector('[data-sidebar-preview]')
    expect(card!.textContent).toContain('First thread')
    act(() => {
      first.blur()
      second.focus()
    })
    const next = document.body.querySelector('[data-sidebar-preview]')
    expect(next).toBe(card)
    expect(next!.textContent).toContain('Second thread')
    expect(next!.textContent).not.toContain('First thread')
  })

  it('hides the preview after the handoff delay when leaving the list', () => {
    const { host } = render({ title: 'Simplot Opsys' })
    vi.useFakeTimers()
    const row = host.querySelector('a')!
    act(() => {
      row.focus()
    })
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PREVIEW_DELAY_MS)
    })
    expect(document.body.querySelector('[data-sidebar-preview]')).not.toBeNull()
    act(() => {
      row.blur()
    })
    expect(document.body.querySelector('[data-sidebar-preview]')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(SIDEBAR_PREVIEW_HANDOFF_MS)
    })
    expect(document.body.querySelector('[data-sidebar-preview]')).toBeNull()
  })
})
