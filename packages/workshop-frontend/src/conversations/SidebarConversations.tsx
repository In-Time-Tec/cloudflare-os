import { useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { EnvelopeSimple } from '@phosphor-icons/react'
import type { ConversationSummary, EmailSummary } from '@gadgets/workshop-shared/gatekeeper'
import { refKey, useConversations } from './ConversationsContext'
import { Avatar } from './primitives'
import { Skeleton, SkeletonRows } from '../components/Skeleton'

// Sidebar sections for the communications surfaces — Conversations, Channels, Email —
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

/** Placeholder rows at the row geometry, for a section whose list hasn't arrived. */
function SkeletonRowsBlock({ count }: { count: number }) {
  return (
    <SkeletonRows count={count}>
      {i => (
        <div key={i} className="flex h-7 items-center gap-1.5 px-2.5">
          <Skeleton className="size-4.5 rounded-full" />
          <Skeleton className="h-[1lh] flex-1 text-[12.5px] leading-[18px]" />
        </div>
      )}
    </SkeletonRows>
  )
}

/** Sidebar sections; renders nothing when no connected account provides conversations. */
export default function SidebarConversations({ collapsed }: { collapsed: boolean }) {
  const { available, conversations, channels, emails, loading } = useConversations()
  if (collapsed || available === false) return null

  // While the account is still being probed (available === null) or its lists are in flight, the
  // sections hold their space. They otherwise appear all at once below the primary nav and push
  // Favorites and Recent workspaces down by several hundred pixels.
  if (available === null || (loading && conversations.length === 0 && channels.length === 0)) {
    return (
      <>
        <Section label="Conversations" count={0}><SkeletonRowsBlock count={4} /></Section>
        <Section label="Channels" count={0}><SkeletonRowsBlock count={3} /></Section>
      </>
    )
  }

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
