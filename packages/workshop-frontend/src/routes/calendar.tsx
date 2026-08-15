import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import {
  CalendarBlank, CaretLeft, CaretRight, VideoCamera, MapPin, Users, ArrowSquareOut,
} from '@phosphor-icons/react'
import CommsLayout from '../conversations/CommsLayout'
import WeekCalendar, { weekBounds } from '../conversations/WeekCalendar'
import { useConversations } from '../conversations/ConversationsContext'
import { useAgendaQuery } from '../query/conversations'
import { Avatar, PaneHeader } from '../conversations/primitives'
import { useDocumentTitle } from '../useDocumentTitle'

// The Calendar page: a week view of the connected account's meetings. Selecting an event shows
// its details — attendees, location, and a Join button for Teams meetings.

export const Route = createFileRoute('/calendar')({
  component: CalendarPage,
  validateSearch: (search: Record<string, unknown>): { e?: string } =>
    typeof search.e === 'string' ? { e: search.e } : {},
})

function CalendarPage() {
  useDocumentTitle('Calendar')
  const { e: selectedId } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { avatarFor, available } = useConversations()
  const [anchor, setAnchor] = useState(() => new Date())
  const { start: weekStart, end: weekEnd } = weekBounds(anchor)
  const { data: agenda = [], isLoading: agendaLoading } = useAgendaQuery(weekStart, weekEnd)

  const selected = useMemo(() =>
    agenda.find(entry => entry.id === selectedId) ?? null, [agenda, selectedId])

  const { start } = weekBounds(anchor)
  const weekLabel = `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${
    new Date(start.valueOf() + 6 * 86_400_000)
        .toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`

  if (available === false) {
    return (
      <CommsLayout title="Calendar" list={null} detail={
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <CalendarBlank size={40} className="text-kumo-inactive" />
          <p className="text-[14px] text-kumo-subtle">
            Connect your Microsoft account with the Calendar capability to see meetings here.
          </p>
        </div>
      } />
    )
  }

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-kumo-line px-6">
        <h1 className="text-[14px] font-medium tracking-[-0.25px] text-kumo-default">Calendar</h1>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous week"
              onClick={() => setAnchor(a => new Date(a.valueOf() - 7 * 86_400_000))}
              className="flex size-8 cursor-pointer items-center justify-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default">
            <CaretLeft size={15} />
          </button>
          <button type="button"
              onClick={() => setAnchor(new Date())}
              className="h-8 cursor-pointer rounded-md px-2.5 text-[12.5px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default">
            Today
          </button>
          <button type="button" aria-label="Next week"
              onClick={() => setAnchor(a => new Date(a.valueOf() + 7 * 86_400_000))}
              className="flex size-8 cursor-pointer items-center justify-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default">
            <CaretRight size={15} />
          </button>
          <span className="ml-2 text-[12.5px] tabular-nums text-kumo-inactive">{weekLabel}</span>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-kumo-line">
          {agendaLoading && agenda.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="h-24 w-2/3 animate-pulse rounded-md bg-kumo-elevated" />
            </div>
          ) : (
            <WeekCalendar anchor={anchor} entries={agenda} selectedId={selectedId}
                onSelect={id => navigate({ search: { e: id } })} />
          )}
        </div>
        {/* Event details */}
        <div className="flex w-96 shrink-0 flex-col">
          {selected ? (
            <>
              <PaneHeader
                avatar={<Avatar
                    photo={avatarFor(selected.organizer?.userId)}
                    title={selected.organizer?.name || selected.subject} size="lg" />}
                title={selected.subject || '(no title)'}
                subtitle={selected.organizer
                  ? `Organized by ${selected.organizer.name ?? selected.organizer.address}`
                  : undefined}
                actions={selected.webUrl ? (
                  <a href={selected.webUrl} target="_blank" rel="noopener noreferrer"
                      aria-label="Open in Outlook"
                      className="flex size-8 items-center justify-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default">
                    <ArrowSquareOut size={16} />
                  </a>
                ) : undefined}
              />
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                <p className="text-[13px] text-kumo-default">
                  {selected.start && new Date(selected.start).toLocaleString([], {
                    weekday: 'long', month: 'short', day: 'numeric',
                    hour: 'numeric', minute: '2-digit',
                  })}
                  {selected.end && ` – ${new Date(selected.end).toLocaleTimeString([], {
                    hour: 'numeric', minute: '2-digit',
                  })}`}
                </p>
                {selected.joinUrl && (
                  <a href={selected.joinUrl} target="_blank" rel="noopener noreferrer"
                      className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-kumo-brand px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-90">
                    <VideoCamera size={16} weight="fill" /> Join Teams meeting
                  </a>
                )}
                {selected.location && (
                  <p className="mt-4 flex items-center gap-2 text-[12.5px] text-kumo-subtle">
                    <MapPin size={15} className="shrink-0 text-kumo-inactive" />
                    {selected.location}
                  </p>
                )}
                {selected.attendees.length > 0 && (
                  <div className="mt-4">
                    <p className="mb-2 flex items-center gap-2 text-[12px] font-medium text-kumo-subtle">
                      <Users size={15} className="text-kumo-inactive" />
                      {selected.attendees.length} attendees
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {selected.attendees.map(attendee => (
                        <p key={attendee.address}
                            className="flex items-center justify-between gap-2 text-[12.5px] text-kumo-default">
                          <span className="truncate">{attendee.name || attendee.address}</span>
                          {attendee.response && attendee.response !== 'none' && (
                            <span className={`shrink-0 text-[10.5px] ${
                              attendee.response === 'accepted' ? 'text-green-600'
                                : attendee.response === 'declined' ? 'text-red-500'
                                : 'text-kumo-inactive'
                            }`}>
                              {attendee.response === 'tentativelyAccepted'
                                ? 'tentative' : attendee.response}
                            </span>
                          )}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <CalendarBlank size={36} className="text-kumo-inactive" />
              <p className="text-[13.5px] text-kumo-subtle">Select a meeting</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
