// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEntry } from '@gadgets/workshop-shared/gatekeeper'
import WeekCalendar, { weekBounds } from './WeekCalendar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The grid's alignment contract: the header, the all-day band and the hour columns must share one
// column template, and every rule must be a single hairline of the same token. A regression here is
// invisible to a type check, so it's asserted on the rendered class names.

const ANCHOR = new Date('2026-08-17T12:00:00')

function entry(overrides: Partial<CalendarEntry> & { id: string }): CalendarEntry {
  return {
    subject: 'Meeting',
    isAllDay: false,
    isCancelled: false,
    attendees: [],
    ...overrides,
  }
}

describe('WeekCalendar', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  function render(entries: CalendarEntry[], anchor = ANCHOR, selectedId?: string) {
    const onSelect = vi.fn<(id: string) => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(
      <WeekCalendar anchor={anchor} entries={entries} selectedId={selectedId}
          onSelect={onSelect} onAnchorChange={() => {}} />,
    ))
    return { onSelect, container: container! }
  }

  it('gives every grid row the same column template', () => {
    const { container } = render([entry({ id: 'a', isAllDay: true, start: ANCHOR })])
    const rows = [...container.querySelectorAll('div')]
        .filter(el => el.className.includes('grid-cols-['))
    // Day header, all-day band, hour grid.
    expect(rows).toHaveLength(3)
    const templates = new Set(rows.map(el =>
      el.className.split(' ').filter(c => c.includes('grid-cols-[')).join(' ')))
    expect(templates.size).toBe(1)
  })

  it('draws every rule as one hairline of the line token', () => {
    const { container } = render([entry({ id: 'a', start: ANCHOR })])
    const ruled = [...container.querySelectorAll('div')]
        .filter(el => /\bborder-(t|b|l)\b/.test(el.className))
    expect(ruled.length).toBeGreaterThan(0)
    for (const el of ruled) {
      expect(el.className).toContain('border-kumo-line')
      // No border-2 / border-t-2 anywhere on the grid: thicker rules are what broke alignment.
      expect(el.className).not.toMatch(/\bborder(-[tblr])?-2\b/)
    }
  })

  it('positions events proportionally so the grid can stretch to the pane', () => {
    const start = new Date(ANCHOR)
    start.setHours(11, 0, 0, 0)
    const end = new Date(ANCHOR)
    end.setHours(11, 30, 0, 0)
    const { container } = render([entry({ id: 'a', start, end })])
    const event = container.querySelector<HTMLButtonElement>('button[title="Meeting"]')
    expect(event).not.toBeNull()
    // 7 AM–8 PM window: 11:00 is 4/13 of the way down, a 30-minute event is 0.5/13 tall.
    expect(event!.style.top).toMatch(/%$/)
    expect(event!.style.height).toMatch(/%$/)
    expect(parseFloat(event!.style.top)).toBeCloseTo((4 / 13) * 100, 6)
    expect(parseFloat(event!.style.height)).toBeCloseTo((0.5 / 13) * 100, 6)
  })

  it('widens the hour window to cover meetings outside business hours', () => {
    const start = new Date(ANCHOR)
    start.setHours(5, 0, 0, 0)
    const { container } = render([entry({ id: 'early', start })])
    const labels = [...container.querySelectorAll('span')]
        .map(el => el.textContent)
        .filter(text => /^\d{1,2} (AM|PM)$/.test(text ?? ''))
    expect(labels[0]).toBe('5 AM')
  })

  it('renders only the anchored day at mobile widths', () => {
    const { container } = render([entry({ id: 'a', start: ANCHOR })])
    const columns = [...container.querySelectorAll('div')]
        .filter(el => el.className.includes('border-l') && el.className.includes('relative'))
    expect(columns).toHaveLength(7)
    // Monday is the anchor: visible unprefixed, the other six only from md up.
    expect(columns.filter(el => el.className.includes('block md:block'))).toHaveLength(1)
    expect(columns.filter(el => el.className.includes('hidden md:block'))).toHaveLength(6)
  })

  it('keeps all-day entries out of the hour grid', () => {
    const { container, onSelect } = render([
      entry({ id: 'allday', subject: 'Offsite', isAllDay: true, start: ANCHOR }),
    ])
    const chip = container.querySelector<HTMLButtonElement>('button[title="Offsite"]')
    expect(chip).not.toBeNull()
    // An all-day chip lives in the band, which is not absolutely positioned.
    expect(chip!.className).not.toContain('absolute')
    act(() => { chip!.click() })
    expect(onSelect).toHaveBeenCalledWith('allday')
  })

  it('starts the week on Sunday', () => {
    const { start, end } = weekBounds(ANCHOR)
    expect(start.getDay()).toBe(0)
    expect(start.getDate()).toBe(16)
    expect(Math.round((end.valueOf() - start.valueOf()) / 86_400_000)).toBe(7)
  })
})
