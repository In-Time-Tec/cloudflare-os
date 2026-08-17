import { useState, type ReactNode } from 'react'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { EnvelopeSimple } from '@phosphor-icons/react'
import type { ConversationSummary, EmailSummary } from '@gadgets/workshop-shared/gatekeeper'
import { refKey, useConversations } from './ConversationsContext'
import { Avatar } from './primitives'

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
  const matchRoute = useMatchRoute()
  return (
    <>
      {items.slice(0, INITIAL_LIMIT).map(conversation => {
        const key = refKey(conversation.ref)
        const photo = conversation.ref.kind === 'chat' && conversation.members.length === 1
          ? avatarFor(conversation.members[0]?.userId)
          : undefined
        const to = `/${section}` as const
        const search = { c: key }
        const pending = !!matchRoute({ to, search, pending: true })
        return (
          <Link
            key={key}
            to={to}
            search={search}
            title={conversation.title}
            aria-busy={pending}
            className={`${ROW} ${pending ? 'opacity-70' : ''}`}
          >
            <Avatar photo={photo} title={conversation.title} size="sm" />
            <span className={ROW_TEXT}>{conversation.title}</span>
          </Link>
        )
      })}
    </>
  )
}

function EmailRows({ items }: { items: EmailSummary[] }) {
  const matchRoute = useMatchRoute()
  return (
    <>
      {items.slice(0, INITIAL_LIMIT).map(email => {
        const pending = !!matchRoute({ to: '/email', search: { m: email.id }, pending: true })
        return (
          <Link
            key={email.id}
            to="/email"
            search={{ m: email.id }}
            title={email.subject}
            aria-busy={pending}
            className={`${ROW} ${pending ? 'opacity-70' : ''}`}
          >
            <EnvelopeSimple size={14} className="shrink-0 text-kumo-inactive" />
            <span className={`${ROW_TEXT} ${email.isRead ? '' : 'font-semibold text-kumo-default'}`}>
              {email.from?.name || email.from?.address || email.subject}
            </span>
          </Link>
        )
      })}
    </>
  )
}

export default function SidebarConversations({ collapsed }: { collapsed: boolean }) {
  const { available, conversations, channels, emails } = useConversations()
  if (collapsed || available === false) return null
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
    </>
  )
}
