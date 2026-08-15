import { useMemo } from 'react'
import type { CalendarEntry } from '@gadgets/workshop-shared/gatekeeper'

// A Kumo-styled week calendar: seven day columns over an hour grid, events positioned by time.
// Visual language follows the shadcn/ui calendar family (hairline grid, subtle today highlight,
// rounded event chips) rebuilt on Kumo tokens — no external calendar dependency.

const START_HOUR = 7
const END_HOUR = 20
const HOUR_PX = 48

export function weekBounds(anchor: Date): { start: Date; end: Date } {
  const start = new Date(anchor)
  start.setDate(anchor.getDate() - anchor.getDay())
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(start.getDate() + 7)
  return { start, end }
}

export default function WeekCalendar({ anchor, entries, selectedId, onSelect }: {
  anchor: Date
  entries: CalendarEntry[]
  selectedId?: string
  onSelect(id: string): void
}) {
  const { start } = weekBounds(anchor)
  const days = useMemo(() =>
    Array.from({ length: 7 }, (_, i) => {
      const day = new Date(start)
      day.setDate(start.getDate() + i)
      return day
    }), [start])
  const today = new Date().toDateString()

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>()
    for (const entry of entries) {
      if (!entry.start || entry.isCancelled) continue
      const key = new Date(entry.start).toDateString()
      const list = map.get(key) ?? []
      list.push(entry)
      map.set(key, list)
    }
    return map
  }, [entries])

  const hours = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Day headers */}
      <div className="grid shrink-0 grid-cols-[3rem_repeat(7,1fr)] border-b border-kumo-line">
        <div />
        {days.map(day => {
          const isToday = day.toDateString() === today
          return (
            <div key={day.toISOString()}
                className="flex flex-col items-center gap-0.5 border-l border-kumo-line py-2">
              <span className="text-[10.5px] font-medium uppercase tracking-wide text-kumo-inactive">
                {day.toLocaleDateString([], { weekday: 'short' })}
              </span>
              <span className={`flex size-6 items-center justify-center rounded-full text-[12.5px] tabular-nums ${
                isToday ? 'bg-kumo-brand font-semibold text-white' : 'text-kumo-default'
              }`}>
                {day.getDate()}
              </span>
            </div>
          )
        })}
      </div>
      {/* Hour grid */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-[3rem_repeat(7,1fr)]"
            style={{ height: (END_HOUR - START_HOUR) * HOUR_PX }}>
          {/* Hour labels */}
          <div className="relative">
            {hours.map(hour => (
              <span key={hour}
                  className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-kumo-inactive"
                  style={{ top: (hour - START_HOUR) * HOUR_PX }}>
                {hour === 12 ? '12 PM' : hour > 12 ? `${hour - 12} PM` : `${hour} AM`}
              </span>
            ))}
          </div>
          {days.map(day => {
            const dayEntries = byDay.get(day.toDateString()) ?? []
            return (
              <div key={day.toISOString()} className="relative border-l border-kumo-line">
                {hours.map(hour => (
                  <div key={hour} className="absolute inset-x-0 border-t border-kumo-line/60"
                      style={{ top: (hour - START_HOUR) * HOUR_PX }} />
                ))}
                {dayEntries.map(entry => {
                  const startDate = new Date(entry.start!)
                  const endDate = entry.end ? new Date(entry.end) : startDate
                  const top = ((startDate.getHours() + startDate.getMinutes() / 60) - START_HOUR)
                      * HOUR_PX
                  const height = Math.max(22,
                      ((endDate.valueOf() - startDate.valueOf()) / 3_600_000) * HOUR_PX - 2)
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => onSelect(entry.id)}
                      title={entry.subject}
                      className={`absolute inset-x-0.5 cursor-pointer overflow-hidden rounded-md border px-1.5 py-0.5 text-left transition-colors ${
                        entry.id === selectedId
                          ? 'border-kumo-brand bg-kumo-brand/20'
                          : 'border-kumo-brand/30 bg-kumo-brand/10 hover:bg-kumo-brand/15'
                      }`}
                      style={{ top: Math.max(0, top), height }}
                    >
                      <span className="block truncate text-[11px] font-medium leading-tight text-kumo-default">
                        {entry.subject}
                      </span>
                      {height > 34 && (
                        <span className="block truncate text-[10px] text-kumo-subtle">
                          {startDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
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
  )
}
