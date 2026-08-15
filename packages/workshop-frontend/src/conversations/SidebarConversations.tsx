import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { ConversationSummary } from '@gadgets/workshop-shared/gatekeeper'
import { refKey, useConversations } from './ConversationsContext'

// The sidebar's Conversations / Channels sections, styled to match Favorites / Recent workspaces
// (same header treatment: label, hairline, count). Rows show an avatar (profile photo when the
// provider has one, monogram otherwise) and the conversation title.

const SECTION_HEADER =
  'flex h-6 w-full cursor-pointer items-center gap-2 px-1.5 text-[11px] font-medium ' +
  'tracking-[-0.1px] text-kumo-inactive transition-colors hover:text-kumo-subtle'

const INITIAL_LIMIT = 6

function monogram(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function ConversationRow({ conversation }: { conversation: ConversationSummary }) {
  const { avatarFor } = useConversations()
  const navigate = useNavigate()
  const key = refKey(conversation.ref)
  const photo = conversation.ref.kind === 'chat' && conversation.members.length === 1
    ? avatarFor(conversation.members[0]?.userId)
    : undefined

  return (
    <button
      type="button"
      onClick={() => navigate({ to: '/conversations', search: { c: key } })}
      className="group flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-kumo-elevated"
      title={conversation.title}
    >
      {photo ? (
        <img src={photo} alt="" className="size-4.5 shrink-0 rounded-full object-cover" />
      ) : (
        <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-kumo-elevated text-[8px] font-semibold text-kumo-subtle group-hover:bg-kumo-base">
          {monogram(conversation.title)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[12.5px] tracking-[-0.1px] text-kumo-subtle group-hover:text-kumo-default">
        {conversation.title}
      </span>
    </button>
  )
}

function Section({ label, items }: {
  label: string
  items: ConversationSummary[]
}) {
  const [open, setOpen] = useState(true)
  const shown = items.slice(0, INITIAL_LIMIT)
  return (
    <div className="mt-3 flex flex-col px-2">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className={SECTION_HEADER}
      >
        <span className="shrink-0">{label}</span>
        <span className="h-px min-w-2 flex-1 bg-kumo-line" aria-hidden="true" />
        <span className="shrink-0 tabular-nums">{items.length}</span>
      </button>
      {open && (
        <div className="mt-0.5 flex flex-col">
          {shown.map(conversation => (
            <ConversationRow key={refKey(conversation.ref)} conversation={conversation} />
          ))}
          {items.length > INITIAL_LIMIT && (
            <Link
              to="/conversations"
              className="flex h-7 items-center rounded-md px-1.5 text-[12px] text-kumo-inactive transition-colors hover:bg-kumo-elevated hover:text-kumo-subtle"
            >
              Show all
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

/** Sidebar sections; renders nothing when no connected account provides conversations. */
export default function SidebarConversations({ collapsed }: { collapsed: boolean }) {
  const { available, conversations, channels } = useConversations()
  if (collapsed || !available) return null
  return (
    <>
      {conversations.length > 0 && (
        <Section label="Conversations" items={conversations} />
      )}
      {channels.length > 0 && (
        <Section label="Channels" items={channels} />
      )}
    </>
  )
}
