import { Link } from '@tanstack/react-router'
import { useMemo, type ReactNode } from 'react'
import type { CalendarEntry } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from '../../AuthContext'
import { refKey, useConversations } from '../../conversations/ConversationsContext'
import { formatTime } from '../../conversations/primitives'
import { attentionGreeting, glanceDateLabel, glanceRange, isSameCalendarDay } from '../../homeGreeting'
import { useAgendaQuery } from '../../query/conversations'
import { useThreads } from '../../query/hooks'
import { asTime } from '../../query/time'

const SECTION_LIMIT = 5

function GlanceSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="border-t border-kumo-line pt-4">
      <h3 className="mb-2 text-[13px] font-medium tracking-[-0.2px] text-kumo-default">{title}</h3>
      {children}
    </section>
  )
}

function GlanceEmpty({ children }: { children: ReactNode }) {
  return <p className="text-[13px] leading-5 text-kumo-inactive">{children}</p>
}

function meetingTime(entry: CalendarEntry): string {
  if (entry.isAllDay) return 'All day'
  if (!entry.start) return ''
  return new Date(asTime(entry.start)).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function meetingWeekday(entry: CalendarEntry): string {
  if (!entry.start) return ''
  return new Date(asTime(entry.start)).toLocaleDateString(undefined, { weekday: 'long' })
}

function MeetingRows({ entries }: { entries: CalendarEntry[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-start gap-3">
          <Link
            to="/calendar"
            search={{ e: entry.id }}
            className="min-w-0 flex-1 rounded-md outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-kumo-ring"
          >
            <p className="text-[13px] font-medium leading-5 tracking-[-0.2px] text-kumo-default">
              {meetingTime(entry)}
            </p>
            <p className="text-[12px] leading-4 text-kumo-inactive">{meetingWeekday(entry)}</p>
            <p className="mt-0.5 truncate text-[13px] leading-5 text-kumo-default">
              {entry.subject || '(no title)'}
            </p>
          </Link>
          {entry.joinUrl && (
            <a
              href={entry.joinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-kumo-default transition-colors hover:bg-kumo-tint"
            >
              Join
            </a>
          )}
        </li>
      ))}
    </ul>
  )
}

export default function HomeDashboard() {
  const { currentUser } = useAuthenticatedApi()
  const { emails, conversations, available } = useConversations()
  const { data: threads = [] } = useThreads()
  const range = useMemo(() => glanceRange(), [])
  const { data: agenda = [], isLoading: agendaLoading } = useAgendaQuery(range.from, range.to)

  const today = useMemo(() => new Date(), [])
  const yesterday = useMemo(() => {
    const day = new Date()
    day.setDate(day.getDate() - 1)
    return day
  }, [])

  const todayMeetings = useMemo(
    () =>
      agenda
        .filter((entry) => !entry.isCancelled && isSameCalendarDay(entry.start, today))
        .slice(0, SECTION_LIMIT),
    [agenda, today],
  )
  const yesterdayMeetings = useMemo(
    () =>
      agenda
        .filter((entry) => !entry.isCancelled && isSameCalendarDay(entry.start, yesterday))
        .slice(0, SECTION_LIMIT),
    [agenda, yesterday],
  )
  const recentEmails = emails.slice(0, SECTION_LIMIT)
  const recentChats = conversations.slice(0, SECTION_LIMIT)
  const continueThreads = useMemo(
    () =>
      [...threads]
        .sort((a, b) => asTime(b.lastActive) - asTime(a.lastActive))
        .slice(0, SECTION_LIMIT),
    [threads],
  )

  const dateLabel = glanceDateLabel()
  const commsUnavailable = available === false

  return (
    <div className="flex h-full min-h-0 w-full flex-col lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col px-6 pt-10 sm:px-10 lg:px-14 lg:pt-16">
        <header>
          <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.6px] text-kumo-default sm:text-[36px]">
            {attentionGreeting(currentUser?.name)}
          </h1>
          <p className="mt-2 text-[15px] leading-6 text-kumo-subtle">{dateLabel}</p>
        </header>
      </div>

      <aside className="min-h-0 w-full overflow-y-auto border-t border-kumo-line px-6 py-6 lg:w-[380px] lg:shrink-0 lg:border-l lg:border-t-0 lg:px-7 lg:py-8">
        <div className="mb-5">
          <h2 className="text-[15px] font-medium tracking-[-0.25px] text-kumo-default">
            At a glance
          </h2>
          <p className="mt-1 text-[13px] text-kumo-subtle">{dateLabel}</p>
        </div>

        <div className="flex flex-col gap-5">
          {commsUnavailable ? (
            <GlanceSection title="Connect">
              <p className="text-[13px] leading-5 text-kumo-subtle">
                Connect Microsoft to see meetings, email, and chats.{' '}
                <Link
                  to="/gatekeepers"
                  className="text-kumo-default underline-offset-2 hover:underline"
                >
                  Open connectors
                </Link>
              </p>
            </GlanceSection>
          ) : (
            <>
              <GlanceSection title="Schedule">
                {todayMeetings.length > 0 ? (
                  <MeetingRows entries={todayMeetings} />
                ) : (
                  <GlanceEmpty>
                    {agendaLoading || available === null
                      ? 'Looking up today’s meetings…'
                      : 'Nothing scheduled today.'}
                  </GlanceEmpty>
                )}
              </GlanceSection>

              <GlanceSection title="Yesterday">
                {yesterdayMeetings.length > 0 ? (
                  <MeetingRows entries={yesterdayMeetings} />
                ) : (
                  <GlanceEmpty>
                    {agendaLoading || available === null
                      ? 'Looking up yesterday’s meetings…'
                      : 'No meetings yesterday.'}
                  </GlanceEmpty>
                )}
              </GlanceSection>

              <GlanceSection title="Recent email">
                {recentEmails.length > 0 ? (
                  <ul className="flex flex-col gap-3">
                    {recentEmails.map((email) => (
                      <li key={email.id}>
                        <Link
                          to="/email"
                          search={{ m: email.id }}
                          className="block min-w-0 rounded-md outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-kumo-ring"
                        >
                          <span className="flex items-baseline justify-between gap-3">
                            <span className={`truncate text-[13px] leading-5 ${email.isRead ? 'font-medium text-kumo-default' : 'font-semibold text-kumo-default'}`}>
                              {email.from?.name || email.from?.address || '(unknown sender)'}
                            </span>
                            <span className="shrink-0 text-[11px] text-kumo-inactive">
                              {formatTime(email.received)}
                            </span>
                          </span>
                          <span className="mt-0.5 line-clamp-1 text-[12px] leading-4 text-kumo-subtle">
                            {email.subject || '(no subject)'}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <GlanceEmpty>
                    {available === null ? 'Looking up email…' : 'No recent email.'}
                  </GlanceEmpty>
                )}
              </GlanceSection>

              <GlanceSection title="Recent chats">
                {recentChats.length > 0 ? (
                  <ul className="flex flex-col gap-3">
                    {recentChats.map((conversation) => {
                      const key = refKey(conversation.ref)
                      const preview = conversation.lastMessage
                        ? `${conversation.lastMessage.from ? `${conversation.lastMessage.from}: ` : ''}${conversation.lastMessage.preview}`
                        : undefined
                      return (
                        <li key={key}>
                          <Link
                            to="/conversations"
                            search={{ c: key }}
                            className="block min-w-0 rounded-md outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-kumo-ring"
                          >
                            <span className="flex items-baseline justify-between gap-3">
                              <span className="truncate text-[13px] font-medium leading-5 text-kumo-default">
                                {conversation.title}
                              </span>
                              <span className="shrink-0 text-[11px] text-kumo-inactive">
                                {formatTime(conversation.lastActivity)}
                              </span>
                            </span>
                            {preview && (
                              <span className="mt-0.5 line-clamp-1 text-[12px] leading-4 text-kumo-subtle">
                                {preview}
                              </span>
                            )}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <GlanceEmpty>
                    {available === null ? 'Looking up chats…' : 'No recent chats.'}
                  </GlanceEmpty>
                )}
              </GlanceSection>
            </>
          )}

          <GlanceSection title="Continue">
            {continueThreads.length > 0 ? (
              <ul className="flex flex-col gap-2.5">
                {continueThreads.map((thread) => (
                  <li key={thread.id} className="flex items-center gap-3">
                    <Link
                      to="/thread/$id"
                      params={{ id: thread.id }}
                      className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-kumo-default outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-kumo-ring"
                    >
                      {thread.title || 'Untitled thread'}
                    </Link>
                    <Link
                      to="/thread/$id"
                      params={{ id: thread.id }}
                      className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
                    >
                      Resume
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <GlanceEmpty>No recent threads.</GlanceEmpty>
            )}
          </GlanceSection>
        </div>
      </aside>
    </div>
  )
}
