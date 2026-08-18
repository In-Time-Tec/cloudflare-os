import { useCallback, useState, type ReactNode } from 'react'
import { Link, useMatchRoute } from '@tanstack/react-router'
import { EnvelopeSimple, EyeSlash } from '@phosphor-icons/react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { ConversationSummary, EmailSummary } from '@gadgets/workshop-shared/gatekeeper'
import { PendingIcon } from '../components/PendingIcon'
import { HoverActionBar, HoverFadeLabel, HoverRowTrail, bindRowRef, useRowPreview } from '../components/AppShell/SidebarHoverRow'
import { hoverRowClassName } from '../components/AppShell/sidebarHover'
import { refKey, useConversations } from './ConversationsContext'
import { conversationPreview, emailPreview } from './hoverPreviews'
import { Avatar } from './primitives'
import {
  clearSidebarHidden,
  hideSidebarItem,
  readSidebarHidden,
  visibleSidebarItems,
  writeSidebarHidden,
  type SidebarHiddenKind,
  type SidebarHiddenMap,
} from './sidebarHidden'

const SECTION_HEADER =
  'flex h-6 w-full cursor-pointer items-center gap-2 px-1.5 text-[10px] font-medium ' +
  'text-kumo-inactive transition-colors hover:text-kumo-subtle'

const INITIAL_LIMIT = 6

function Section({ label, count, hiddenCount, onShowHidden, children }: {
  label: string
  count: number
  hiddenCount: number
  onShowHidden: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="mt-3 flex flex-col px-2">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
          className={SECTION_HEADER}>
        <span className="shrink-0">{label}</span>
        <span className="h-px min-w-2 flex-1 bg-kumo-line" aria-hidden="true" />
        <span className="shrink-0 tabular-nums">{count}</span>
      </button>
      {open && (
        <div className="mt-0.5 flex flex-col">
          {children}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={onShowHidden}
              className="mt-0.5 flex h-7 items-center px-2.5 text-[12px] tracking-[-0.2px] text-kumo-inactive transition-colors hover:text-kumo-default"
            >
              {`Show ${hiddenCount} hidden`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ConversationHoverRow({ conversation, section, onHide }: {
  conversation: ConversationSummary
  section: 'conversations' | 'channels'
  onHide: () => void
}) {
  const { avatarFor } = useConversations()
  const matchRoute = useMatchRoute()
  const key = refKey(conversation.ref)
  const photo = conversation.ref.kind === 'chat' && conversation.members.length === 1
    ? avatarFor(conversation.members[0]?.userId)
    : undefined
  const to = `/${section}` as const
  const search = { c: key }
  const pending = !!matchRoute({ to, search, pending: true })
  const preview = conversationPreview(conversation)
  const { rowRef, previewBind, previewPortal } = useRowPreview(preview)
  const noun = section === 'channels' ? 'channel' : 'conversation'
  return (
    <>
      <Link
        ref={bindRowRef(rowRef)}
        to={to}
        search={search}
        aria-busy={pending}
        className={hoverRowClassName({
          pending,
          hasActions: true,
          className: 'h-7 gap-1.5 rounded-md px-2.5',
        })}
        {...previewBind}
      >
        <PendingIcon pending={pending} size={18}>
          <Avatar photo={photo} title={conversation.title} size="sm" />
        </PendingIcon>
        <HoverRowTrail>
          <HoverFadeLabel className="text-[12.5px] leading-[18px] tracking-[-0.1px] text-kumo-default">
            {conversation.title}
          </HoverFadeLabel>
          <HoverActionBar
            actions={[{
              label: `Hide ${noun}`,
              icon: <EyeSlash size={12} />,
              onSelect: onHide,
            }]}
          />
        </HoverRowTrail>
      </Link>
      {previewPortal}
    </>
  )
}

function EmailHoverRow({ email, onHide }: {
  email: EmailSummary
  onHide: () => void
}) {
  const matchRoute = useMatchRoute()
  const pending = !!matchRoute({ to: '/email', search: { m: email.id }, pending: true })
  const preview = emailPreview(email)
  const { rowRef, previewBind, previewPortal } = useRowPreview(preview)
  return (
    <>
      <Link
        ref={bindRowRef(rowRef)}
        to="/email"
        search={{ m: email.id }}
        aria-busy={pending}
        className={hoverRowClassName({
          pending,
          hasActions: true,
          className: 'h-7 gap-1.5 rounded-md px-2.5',
        })}
        {...previewBind}
      >
        <PendingIcon pending={pending} size={14}>
          <EnvelopeSimple size={14} className="shrink-0 text-kumo-inactive" />
        </PendingIcon>
        <HoverRowTrail>
          <HoverFadeLabel className={`text-[12.5px] leading-[18px] tracking-[-0.1px] ${
            email.isRead ? 'text-kumo-default' : 'font-semibold text-kumo-default'
          }`}>
            {email.from?.name || email.from?.address || email.subject}
          </HoverFadeLabel>
          <HoverActionBar
            actions={[{
              label: 'Hide email',
              icon: <EyeSlash size={12} />,
              onSelect: onHide,
            }]}
          />
        </HoverRowTrail>
      </Link>
      {previewPortal}
    </>
  )
}

function useSidebarHidden() {
  const toasts = useKumoToastManager()
  const [hidden, setHidden] = useState<SidebarHiddenMap>(readSidebarHidden)

  const hide = useCallback((kind: SidebarHiddenKind, id: string, noun: string) => {
    setHidden((current) => {
      const next = hideSidebarItem(current, kind, id)
      writeSidebarHidden(next)
      return next
    })
    toasts.add({ title: `Hidden 1 ${noun}` })
  }, [toasts])

  const showAll = useCallback((kind: SidebarHiddenKind) => {
    setHidden((current) => {
      const next = clearSidebarHidden(current, kind)
      writeSidebarHidden(next)
      return next
    })
  }, [])

  return { hidden, hide, showAll }
}

export default function SidebarConversations({ collapsed }: { collapsed: boolean }) {
  const { available, conversations, channels, emails } = useConversations()
  const { hidden, hide, showAll } = useSidebarHidden()
  if (collapsed || available === false) return null

  const visibleConversations = visibleSidebarItems(conversations, hidden.conversations, (item) => refKey(item.ref))
  const visibleChannels = visibleSidebarItems(channels, hidden.channels, (item) => refKey(item.ref))
  const visibleEmails = visibleSidebarItems(emails, hidden.emails, (item) => item.id)

  return (
    <>
      {conversations.length > 0 && (
        <Section
          label="Conversations"
          count={conversations.length}
          hiddenCount={hidden.conversations.length}
          onShowHidden={() => showAll('conversations')}
        >
          {visibleConversations.slice(0, INITIAL_LIMIT).map((conversation) => (
            <ConversationHoverRow
              key={refKey(conversation.ref)}
              conversation={conversation}
              section="conversations"
              onHide={() => hide('conversations', refKey(conversation.ref), 'conversation')}
            />
          ))}
        </Section>
      )}
      {channels.length > 0 && (
        <Section
          label="Channels"
          count={channels.length}
          hiddenCount={hidden.channels.length}
          onShowHidden={() => showAll('channels')}
        >
          {visibleChannels.slice(0, INITIAL_LIMIT).map((conversation) => (
            <ConversationHoverRow
              key={refKey(conversation.ref)}
              conversation={conversation}
              section="channels"
              onHide={() => hide('channels', refKey(conversation.ref), 'channel')}
            />
          ))}
        </Section>
      )}
      {emails.length > 0 && (
        <Section
          label="Email"
          count={emails.filter((email) => !email.isRead).length}
          hiddenCount={hidden.emails.length}
          onShowHidden={() => showAll('emails')}
        >
          {visibleEmails.slice(0, INITIAL_LIMIT).map((email) => (
            <EmailHoverRow
              key={email.id}
              email={email}
              onHide={() => hide('emails', email.id, 'email')}
            />
          ))}
        </Section>
      )}
    </>
  )
}
