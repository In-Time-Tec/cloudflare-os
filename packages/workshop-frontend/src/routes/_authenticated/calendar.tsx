import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import {
  CalendarBlank, CaretLeft, CaretRight, VideoCamera, MapPin, Users, ArrowSquareOut, X,
} from '@phosphor-icons/react'
import CommsLayout from '../../conversations/CommsLayout'
import WeekCalendar, { weekBounds } from '../../conversations/WeekCalendar'
import { useConversations } from '../../conversations/ConversationsContext'
import { useAgendaQuery, conversationsCapabilityOptions, agendaOptions } from '../../query/conversations'
import { Avatar, PaneHeader } from '../../conversations/primitives'
import { useDocumentTitle } from '../../useDocumentTitle'

// The Calendar page: a week view of the connected account's meetings. Selecting an event shows
// its details — attendees, location, and a Join button for Teams meetings. The grid pane and the
// detail pane are siblings of one full-height column, so the week always fills the canvas.
//
// Below `md` the detail pane is an overlay over the grid rather than a second column: a phone has
// no room for two panes, and the grid is already narrowed to a single day at that width.

export const Route = createFileRoute('/_authenticated/calendar')({
  component: CalendarPage,
  validateSearch: (search: Record<string, unknown>): { e?: string } =>
    typeof search.e === 'string' ? { e: search.e } : {},
  loaderDeps: ({ search }) => ({ eventId: search.e }),
  loader: async ({ context }) => {
    const available = await context.queryClient.ensureQueryData(
      conversationsCapabilityOptions(context.session),
    )
    if (!available) return
    const { start, end } = weekBounds(new Date())
    await context.queryClient.ensureQueryData({
      ...agendaOptions(context.session, start, end),
      revalidateIfStale: true,
    })
  },
})

const NAV_BUTTON =
  'flex size-7 cursor-pointer items-center justify-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default'

function CalendarPage() {
  useDocumentTitle('Calendar')
  const { e: selectedId } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { avatarFor, available } = useConversations()
  const [anchor, setAnchor] = useState(() => new Date())
  const { start: weekStart, end: weekEnd } = weekBounds(anchor)
  const { data: agenda = [] } = useAgendaQuery(weekStart, weekEnd)

  const selected = useMemo(() =>
    agenda.find(entry => entry.id === selectedId) ?? null, [agenda, selectedId])

  const weekLabel = `${weekStart.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${
    new Date(weekStart.valueOf() + 6 * 86_400_000)
        .toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`

  const shiftWeek = (weeks: number) => setAnchor(a => {
    const next = new Date(a)
    next.setDate(a.getDate() + weeks * 7)
    return next
  })

  if (available === false) {
    return (
      <CommsLayout title="Calendar" list={null} detail={
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <CalendarBlank size={40} className="text-kumo-inactive" />
          <p className="text-[14px] text-kumo-subtle">
            Connect your Microsoft account with the Calendar capability to see meetings here.
          </p>
        </div>
      } />
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-kumo-line px-3">
        <h1 className="min-w-0 truncate text-[14px] font-medium tracking-[-0.25px] text-kumo-default">
          Calendar
        </h1>
        <div className="flex shrink-0 items-center gap-1">
          <span className="mr-1 hidden text-[12.5px] tabular-nums text-kumo-inactive sm:inline">
            {weekLabel}
          </span>
          <button type="button" aria-label="Previous week" onClick={() => shiftWeek(-1)}
              className={NAV_BUTTON}>
            <CaretLeft size={14} />
          </button>
          <button type="button" onClick={() => setAnchor(new Date())}
              className="h-7 cursor-pointer rounded-md px-2 text-[12.5px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default">
            Today
          </button>
          <button type="button" aria-label="Next week" onClick={() => shiftWeek(1)}
              className={NAV_BUTTON}>
            <CaretRight size={14} />
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-kumo-line md:border-r">
          {/* The grid itself is the placeholder: it draws the same gutter, day header and hour
              rules with no events in them, so nothing about the page moves when the week arrives —
              only the chips appear. */}
          <WeekCalendar anchor={anchor} entries={agenda} selectedId={selectedId}
              onSelect={id => navigate({ search: { e: id } })}
              onAnchorChange={day => setAnchor(day)} />
        </div>

        {/* Event details — an overlay on phones, a fixed column from md up. */}
        <aside className={`flex-col bg-kumo-base md:flex md:w-[340px] md:shrink-0 ${
          selected ? 'absolute inset-0 z-30 flex md:static md:z-auto' : 'hidden'
        }`}>
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
                actions={
                  <>
                    {selected.webUrl && (
                      <a href={selected.webUrl} target="_blank" rel="noopener noreferrer"
                          aria-label="Open in Outlook"
                          className="flex size-7 items-center justify-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default">
                        <ArrowSquareOut size={15} />
                      </a>
                    )}
                    <button type="button" aria-label="Close event details"
                        onClick={() => navigate({ search: {} })}
                        className="flex size-7 cursor-pointer items-center justify-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default md:hidden">
                      <X size={15} />
                    </button>
                  </>
                }
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
                      className="mt-3 inline-flex h-8 items-center gap-2 rounded-md bg-kumo-brand px-3 text-[12.5px] font-medium text-kumo-inverse transition-colors hover:bg-kumo-brand-hover">
                    <VideoCamera size={15} weight="fill" /> Join Teams meeting
                  </a>
                )}
                {selected.location && (
                  <p className="mt-4 flex items-center gap-2 text-[12.5px] text-kumo-subtle">
                    <MapPin size={15} className="shrink-0 text-kumo-inactive" />
                    <span className="min-w-0 truncate">{selected.location}</span>
                  </p>
                )}
                {selected.attendees.length > 0 && (
                  <div className="mt-4">
                    <p className="mb-2 flex items-center gap-2 text-[12px] font-medium text-kumo-subtle">
                      <Users size={15} className="text-kumo-inactive" />
                      {selected.attendees.length} {selected.attendees.length === 1 ? 'attendee' : 'attendees'}
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {selected.attendees.map(attendee => (
                        <p key={attendee.address}
                            className="flex items-center justify-between gap-2 text-[12.5px] text-kumo-default">
                          <span className="truncate">{attendee.name || attendee.address}</span>
                          {attendee.response && attendee.response !== 'none' && (
                            <span className={`shrink-0 text-[10.5px] ${
                              attendee.response === 'accepted' ? 'text-kumo-success'
                                : attendee.response === 'declined' ? 'text-kumo-danger'
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
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <CalendarBlank size={32} className="text-kumo-inactive" />
              <p className="text-[13.5px] text-kumo-subtle">Select a meeting</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
