// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NAV_ICON_PENDING_DELAY_MS, PendingIcon, useDelayedFlag } from './PendingIcon'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function FlagProbe({ active }: { active: boolean }) {
  const shown = useDelayedFlag(active, NAV_ICON_PENDING_DELAY_MS)
  return <span data-shown={shown ? '1' : '0'} />
}

describe('PendingIcon', () => {
  let root: Root | undefined
  let host: HTMLDivElement | undefined

  afterEach(() => {
    vi.useRealTimers()
    act(() => root?.unmount())
    host?.remove()
  })

  function mount(node: ReactNode) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(node))
    return host
  }

  it('keeps the icon until the delay elapses, then swaps in Hex Orbit', () => {
    vi.useFakeTimers()
    const el = mount(
      <PendingIcon pending size={14}>
        <span data-icon>icon</span>
      </PendingIcon>,
    )
    expect(el.querySelector('[data-icon]')).not.toBeNull()
    expect(el.querySelector('[role="status"]')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(NAV_ICON_PENDING_DELAY_MS)
    })
    expect(el.querySelector('[data-icon]')).toBeNull()
    expect(el.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading')
  })

  it('does not show the orbit when navigation is not pending', () => {
    const el = mount(
      <PendingIcon pending={false} size={14}>
        <span data-icon>icon</span>
      </PendingIcon>,
    )
    expect(el.querySelector('[data-icon]')).not.toBeNull()
    expect(el.querySelector('[role="status"]')).toBeNull()
  })

  it('clears a delayed show if pending ends first', () => {
    vi.useFakeTimers()
    const el = mount(<FlagProbe active />)
    expect(el.querySelector('[data-shown]')?.getAttribute('data-shown')).toBe('0')
    act(() => root!.render(<FlagProbe active={false} />))
    act(() => {
      vi.advanceTimersByTime(NAV_ICON_PENDING_DELAY_MS)
    })
    expect(el.querySelector('[data-shown]')?.getAttribute('data-shown')).toBe('0')
  })
})
