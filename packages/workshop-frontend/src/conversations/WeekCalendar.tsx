import { useEffect, useMemo, useState } from 'react'
import type { CalendarEntry } from '@gadgets/workshop-shared/gatekeeper'

// A Kumo-styled week calendar: a time gutter plus day columns over an hour grid, events positioned
// by time. The day header, the all-day band and the hour grid share one grid template inside a
// single scroller, so their hairlines line up exactly — every rule is one pixel of
// --color-kumo-line. Rows are sized as percentages of the grid, which stretches to fill the pane
// and only scrolls once the hours no longer fit, so there is never dead space under the last hour.
//
// Below `md` the week collapses to the anchored day: the other columns aren't rendered and a pill
// strip switches days, so one template drives both layouts without a JS media query.

const DEFAULT_START_HOUR = 7
const DEFAULT_END_HOUR = 20
const MIN_HOUR_PX = 44

/** Time gutter + day columns. Shared by every row so the vertical hairlines align. */
const GRID_COLUMNS = 'grid-cols-[3.25rem_minmax(0,1fr)] md:grid-cols-[3.25rem_repeat(7,minmax(0,1fr))]'

export function weekBounds(anchor: Date): { start: Date; end: Date } {
  const start = new Date(anchor)
  start.setDate(anchor.getDate() - anchor.getDay())
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(start.getDate() + 7)
  return { start, end }
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString()
}

function hourLabel(hour: number): string {
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`
}

export default function WeekCalendar({
  anchor, entries, selectedId, onSelect, onAnchorChange,
}: {
  anchor: Date
  entries: CalendarEntry[]
  selectedId?: string
  onSelect(id: string): void
  /** Focus a day — the mobile strip's day picker; the week itself is owned by the page. */
  onAnchorChange(day: Date): void
}) {
  const { start } = weekBounds(anchor)
  const days = useMemo(() =>
    Array.from({ length: 7 }, (_, i) => {
      const day = new Date(start)
      day.setDate(start.getDate() + i)
      return day
    }), [start])

  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const { timed, allDay } = useMemo(() => {
    const timed = new Map<string, CalendarEntry[]>()
    const allDay = new Map<string, CalendarEntry[]>()
    for (const entry of entries) {
      if (!entry.start || entry.isCancelled) continue
      const key = new Date(entry.start).toDateString()
      const bucket = entry.isAllDay ? allDay : timed
      const list = bucket.get(key) ?? []
      list.push(entry)
      bucket.set(key, list)
    }
    for (const list of timed.values()) {
      list.sort((a, b) => new Date(a.start!).valueOf() - new Date(b.start!).valueOf())
    }
    return { timed, allDay }
  }, [entries])

  // The window widens to whatever the week actually holds, so an early or late meeting is drawn
  // where it happens instead of being clamped onto the first or last hour.
  const [startHour, endHour] = useMemo(() => {
    let first = DEFAULT_START_HOUR
    let last = DEFAULT_END_HOUR
    for (const list of timed.values()) {
      for (const entry of list) {
        const from = new Date(entry.start!)
        const to = entry.end ? new Date(entry.end) : from
        first = Math.min(first, from.getHours())
        last = Math.max(last, to.getMinutes() > 0 ? to.getHours() + 1 : to.getHours())
      }
    }
    return [first, Math.min(24, Math.max(last, first + 1))]
  }, [timed])

  const span = endHour - startHour
  const hours = Array.from({ length: span }, (_, i) => startHour + i)
  const offsetPercent = (date: Date) =>
    ((date.getHours() + date.getMinutes() / 60 - startHour) / span) * 100

  // The band is only worth its row when a *visible* day fills it: on mobile that is the anchored
  // day alone, so a Thursday offsite must not leave an empty band above a Monday.
  const allDayBand = allDay.has(anchor.toDateString()) ? 'grid'
    : days.some(day => allDay.has(day.toDateString())) ? 'hidden md:grid'
    : null
  const nowPercent = offsetPercent(now)
  const showNow = nowPercent >= 0 && nowPercent <= 100

  // Mobile renders only the anchored day; from md up every column is shown. Class names are
  // written out in full — Tailwind scans source statically, so an interpolated variant never
  // reaches the stylesheet.
  const allDayColumn = (day: Date) =>
    sameDay(day, anchor) ? 'flex md:flex' : 'hidden md:flex'
  const hourColumn = (day: Date) =>
    sameDay(day, anchor) ? 'block md:block' : 'hidden md:block'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day picker — the mobile stand-in for the day header row. */}
      <div className="flex shrink-0 items-stretch gap-0.5 border-b border-kumo-line px-2 py-2 md:hidden">
        {days.map(day => {
          const key = day.toDateString()
          const isAnchor = sameDay(day, anchor)
          const isToday = sameDay(day, now)
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => onAnchorChange(day)}
              aria-current={isAnchor ? 'date' : undefined}
              className={`flex flex-1 cursor-pointer flex-col items-center gap-1 rounded-md py-1.5 transition-colors ${
                isAnchor ? 'bg-kumo-tint' : 'hover:bg-kumo-tint'
              }`}
            >
              <span className="text-[10px] font-medium uppercase tracking-wide text-kumo-inactive">
                {day.toLocaleDateString([], { weekday: 'narrow' })}
              </span>
              <span className={`flex size-6 items-center justify-center rounded-full text-[12.5px] tabular-nums ${
                isToday ? 'bg-kumo-brand font-semibold text-kumo-inverse'
                  : isAnchor ? 'font-medium text-kumo-default' : 'text-kumo-subtle'
              }`}>
                {day.getDate()}
              </span>
              <span className={`size-1 rounded-full ${
                timed.has(key) || allDay.has(key) ? 'bg-kumo-ring' : 'bg-transparent'
              }`} />
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Fills the pane, then grows past it once the hours need more room than it has. */}
        <div className="flex min-w-0 flex-col" style={{ minHeight: `max(100%, ${span * MIN_HOUR_PX}px)` }}>
          {/* Day headers — desktop only; the mobile picker above replaces them. The h-14 rows
              match the page header and the detail pane header, so all three bottom hairlines meet. */}
          <div className={`${GRID_COLUMNS} sticky top-0 z-20 hidden h-14 shrink-0 border-b border-kumo-line bg-kumo-base md:grid`}>
            <div />
            {days.map(day => (
              <div key={day.toISOString()}
                  className="flex flex-col items-center justify-center gap-0.5 border-l border-kumo-line">
                <span className="text-[10.5px] font-medium uppercase tracking-wide text-kumo-inactive">
                  {day.toLocaleDateString([], { weekday: 'short' })}
                </span>
                <span className={`flex size-6 items-center justify-center rounded-full text-[12.5px] tabular-nums ${
                  sameDay(day, now) ? 'bg-kumo-brand font-semibold text-kumo-inverse' : 'text-kumo-default'
                }`}>
                  {day.getDate()}
                </span>
              </div>
            ))}
          </div>

          {/* All-day band — kept out of the hour grid, where a 24-hour chip would bury the day. */}
          {allDayBand && (
            <div className={`${GRID_COLUMNS} ${allDayBand} shrink-0 border-b border-kumo-line`}>
              <div className="flex items-center justify-end whitespace-nowrap px-1.5 py-1.5 text-[10px] uppercase text-kumo-inactive">
                All day
              </div>
              {days.map(day => (
                <div key={day.toISOString()}
                    className={`flex-col gap-1 border-l border-kumo-line p-1 ${allDayColumn(day)}`}>
                  {(allDay.get(day.toDateString()) ?? []).map(entry => (
                    <button key={entry.id} type="button" onClick={() => onSelect(entry.id)}
                        title={entry.subject}
                        className={`cursor-pointer truncate rounded border border-kumo-line border-l-2 px-1.5 py-0.5 text-left text-[11px] text-kumo-default transition-colors ${
                          entry.id === selectedId
                            ? 'border-l-kumo-brand bg-kumo-fill'
                            : 'border-l-kumo-ring bg-kumo-tint hover:bg-kumo-fill'
                        }`}>
                      {entry.subject || '(no title)'}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Hour grid. No bottom rule: the last band is closed by the pane's own edge, and
              drawing one here would double that line. */}
          <div className={`${GRID_COLUMNS} grid min-h-0 flex-1 grid-rows-1`}>
            <div className="relative">
              {/* Labels hang below their own hour line — uniformly, so the first one needs no
                  special case and never sits half-clipped above the grid. */}
              {hours.map((hour, index) => (
                <span key={hour}
                    className="absolute right-2 pt-1 text-[10px] leading-none tabular-nums text-kumo-inactive"
                    style={{ top: `${(index / span) * 100}%` }}>
                  {hourLabel(hour)}
                </span>
              ))}
            </div>
            {days.map((day) => {
              const isToday = sameDay(day, now)
              return (
                <div key={day.toISOString()}
                    className={`relative border-l border-kumo-line ${hourColumn(day)}`}>
                  {/* The header already draws the first rule, so the hour lines start below it. */}
                  {hours.slice(1).map((hour, index) => (
                    <div key={hour} className="absolute inset-x-0 border-t border-kumo-line"
                        style={{ top: `${((index + 1) / span) * 100}%` }} />
                  ))}
                  {isToday && showNow && (
                    <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
                        style={{ top: `${nowPercent}%` }} aria-hidden="true">
                      <span className="size-1 shrink-0 rounded-full bg-kumo-danger" />
                      <span className="h-px flex-1 bg-kumo-danger" />
                    </div>
                  )}
                  {(timed.get(day.toDateString()) ?? []).map(entry => {
                    const from = new Date(entry.start!)
                    const to = entry.end ? new Date(entry.end) : new Date(from.valueOf() + 1_800_000)
                    const top = Math.min(100, Math.max(0, offsetPercent(from)))
                    const height = Math.max(0, Math.min(100, offsetPercent(to)) - top)
                    const minutes = (to.valueOf() - from.valueOf()) / 60_000
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => onSelect(entry.id)}
                        title={entry.subject}
                        className={`absolute inset-x-1 flex cursor-pointer flex-col overflow-hidden rounded-md border border-kumo-line border-l-2 px-1.5 py-0.5 text-left transition-colors ${
                          entry.id === selectedId
                            ? 'border-l-kumo-brand bg-kumo-fill'
                            : 'border-l-kumo-ring bg-kumo-tint hover:bg-kumo-fill'
                        }`}
                        style={{ top: `${top}%`, height: `${height}%`, minHeight: 20 }}
                      >
                        <span className="truncate text-[11px] font-medium leading-tight text-kumo-default">
                          {entry.subject || '(no title)'}
                        </span>
                        {minutes >= 45 && (
                          <span className="truncate text-[10px] leading-tight text-kumo-subtle">
                            {from.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                            {entry.location ? ` · ${entry.location}` : ''}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
