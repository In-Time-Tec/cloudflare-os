import { useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { EnvelopeSimple, CalendarBlank } from '@phosphor-icons/react'
import type { CalendarEntry, ConversationSummary, EmailSummary } from '@gadgets/workshop-shared/gatekeeper'
import { refKey, useConversations } from './ConversationsContext'
import { Avatar, formatTime } from './primitives'

// Sidebar sections for the communications surfaces — Conversations, Channels, Email, Calendar —
// styled to match Favorites / Recent workspaces (label, hairline, count). Each row deep-links
// into its section-scoped page.

const SECTION_HEADER =
  'flex h-6 w-full cursor-pointer items-center gap-2 px-1.5 text-[11px] font-medium ' +
  'tracking-[-0.1px] text-kumo-inactive transition-colors hover:text-kumo-subtle'

const ROW =
  'group flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-left ' +
  'transition-colors hover:bg-kumo-tint'

const ROW_TEXT =
  'min-w-0 flex-1 truncate text-[12.5px] leading-[18px] tracking-[-0.1px] text-kumo-default'

const INITIAL_LIMIT = 6

function Section({ label, count, children }: {
  label: string
  count: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="mt-3 flex flex-col px-2">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className={SECTION_HEADER}>
        <span className="shrink-0">{label}</span>
        <span className="h-px min-w-2 flex-1 bg-kumo-line" aria-hidden="true" />
        <span className="shrink-0 tabular-nums">{count}</span>
      </button>
      {open && <div className="mt-0.5 flex flex-col">{children}</div>}
    </div>
  )
}

function ConversationRows({ items, section }: {
  items: ConversationSummary[]
  section: 'conversations' | 'channels'
}) {
  const { avatarFor } = useConversations()
  const navigate = useNavigate()
  return (
    <>
      {items.slice(0, INITIAL_LIMIT).map(conversation => {
        const key = refKey(conversation.ref)
        const photo = conversation.ref.kind === 'chat' && conversation.members.length === 1
          ? avatarFor(conversation.members[0]?.userId)
          : undefined
        return (
          <button key={key} type="button" title={conversation.title} className={ROW}
              onClick={() => navigate({ to: `/${section}`, search: { c: key } })}>
            <Avatar photo={photo} title={conversation.title} size="sm" />
            <span className={ROW_TEXT}>{conversation.title}</span>
          </button>
        )
      })}
    </>
  )
}

function EmailRows({ items }: { items: EmailSummary[] }) {
  const navigate = useNavigate()
  return (
    <>
      {items.slice(0, INITIAL_LIMIT).map(email => (
        <button key={email.id} type="button" title={email.subject} className={ROW}
            onClick={() => navigate({ to: '/email', search: { m: email.id } })}>
          <EnvelopeSimple size={14} className="shrink-0 text-kumo-inactive" />
          <span className={`${ROW_TEXT} ${email.isRead ? '' : 'font-semibold text-kumo-default'}`}>
            {email.from?.name || email.from?.address || email.subject}
          </span>
        </button>
      ))}
    </>
  )
}

function CalendarRows({ items }: { items: CalendarEntry[] }) {
  const navigate = useNavigate()
  const upcoming = items
    .filter(e => !e.isCancelled && e.end && new Date(e.end) > new Date())
    .slice(0, INITIAL_LIMIT)
  if (upcoming.length === 0) {
    return (
      <button type="button" className={ROW}
          onClick={() => navigate({ to: '/calendar' })}>
        <CalendarBlank size={14} className="shrink-0 text-kumo-inactive" />
        <span className={`${ROW_TEXT} text-kumo-inactive`}>No upcoming meetings</span>
      </button>
    )
  }
  return (
    <>
      {upcoming.map(entry => (
        <button key={entry.id} type="button" title={entry.subject} className={ROW}
            onClick={() => navigate({ to: '/calendar', search: { e: entry.id } })}>
          <CalendarBlank size={14} className="shrink-0 text-kumo-inactive" />
          <span className={ROW_TEXT}>{entry.subject}</span>
          <span className="shrink-0 text-[10px] tabular-nums text-kumo-inactive">
            {formatTime(entry.start)}
          </span>
        </button>
      ))}
    </>
  )
}

/** Sidebar sections; renders nothing when no connected account provides conversations. */
export default function SidebarConversations({ collapsed }: { collapsed: boolean }) {
  const { available, conversations, channels, emails, agenda } = useConversations()
  if (collapsed || !available) return null
  const upcomingCount = agenda
    .filter(e => !e.isCancelled && e.end && new Date(e.end) > new Date()).length
  return (
    <>
      {conversations.length > 0 && (
        <Section label="Conversations" count={conversations.length}>
          <ConversationRows items={conversations} section="conversations" />
        </Section>
      )}
      {channels.length > 0 && (
        <Section label="Channels" count={channels.length}>
          <ConversationRows items={channels} section="channels" />
        </Section>
      )}
      {emails.length > 0 && (
        <Section label="Email" count={emails.filter(e => !e.isRead).length}>
          <EmailRows items={emails} />
        </Section>
      )}
      <Section label="Calendar" count={upcomingCount}>
        <CalendarRows items={agenda} />
      </Section>
    </>
  )
}
