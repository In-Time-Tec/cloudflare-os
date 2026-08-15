import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PaperPlaneRight, ChatsCircle } from '@phosphor-icons/react'
import type {
  ConversationMessage, ConversationSummary,
} from '@gadgets/workshop-shared/gatekeeper'
import PageChrome from '../components/AppShell/PageChrome'
import { useDocumentTitle } from '../useDocumentTitle'
import {
  parseRefKey, refKey, useConversations,
} from '../conversations/ConversationsContext'
import { registerConversationsPush } from '../conversations/push'

// The Conversations page: Teams-backed human-to-human chat. The left pane lists chats and
// channels; the right pane is the selected thread with a composer. Microsoft Graph stays the
// source of truth — messages render from the gatekeeper's sanitized mirror and sends go straight
// to Graph under the signed-in user's own identity.

export const Route = createFileRoute('/conversations')({
  component: ConversationsPage,
  validateSearch: (search: Record<string, unknown>): { c?: string } =>
    typeof search.c === 'string' ? { c: search.c } : {},
})

function formatTime(date: Date | undefined): string {
  if (!date) return ''
  const d = new Date(date)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function monogram(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

type PendingSend = { key: string; text: string; status: 'sending' | 'failed' | 'unknown' }

function ConversationsPage() {
  useDocumentTitle('Conversations')
  const { c: selectedKey } = Route.useSearch()
  const navigate = Route.useNavigate()
  const {
    available, conversations, channels, loading, api, avatarFor, onEvent, setViewing,
  } = useConversations()

  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [pending, setPending] = useState<PendingSend[]>([])
  const [draft, setDraft] = useState('')
  const scrollerRef = useRef<HTMLDivElement>(null)
  const selected = useMemo(() => {
    if (!selectedKey) return null
    return [...conversations, ...channels].find(x => refKey(x.ref) === selectedKey) ?? null
  }, [selectedKey, conversations, channels])

  // Ask for browser-notification permission from this page (a user surface, not a popup ambush).
  useEffect(() => {
    if (api) void registerConversationsPush(api.stub)
  }, [api])

  // Report the on-screen conversation for push suppression.
  useEffect(() => {
    setViewing(selectedKey ?? null)
    return () => setViewing(null)
  }, [selectedKey, setViewing])

  const loadMessages = useCallback(() => {
    const stub = api?.stub
    if (!stub || !selectedKey) return
    setMessagesLoading(true)
    stub.getMessages(parseRefKey(selectedKey))
      .then(result => setMessages(result.messages))
      .catch(err => console.debug('load messages failed', err))
      .finally(() => setMessagesLoading(false))
  }, [api, selectedKey])

  useEffect(() => {
    setMessages([])
    setPending([])
    loadMessages()
  }, [loadMessages])

  // Live events for the open conversation append directly.
  useEffect(() => onEvent(event => {
    if (!selectedKey || refKey(event.ref) !== selectedKey) return
    setMessages(prev => prev.some(m => m.id === event.message.id)
      ? prev : [...prev, event.message])
    setPending(prev => prev.filter(p => p.status !== 'sending'))
  }), [onEvent, selectedKey])

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight })
  }, [messages, pending])

  const send = useCallback(() => {
    const stub = api?.stub
    const text = draft.trim()
    if (!stub || !selectedKey || !text) return
    const key = `${Date.now()}-${Math.random()}`
    setPending(prev => [...prev, { key, text, status: 'sending' }])
    setDraft('')
    stub.sendMessage(parseRefKey(selectedKey), text)
      .then(() => {
        setPending(prev => prev.filter(p => p.key !== key))
        loadMessages()
      })
      .catch(() => {
        // The send may or may not have reached Graph (no idempotency key): mark unknown,
        // reconcile by refetching, and never blind-resend.
        setPending(prev => prev.map(p => p.key === key ? { ...p, status: 'unknown' } : p))
        setTimeout(loadMessages, 2000)
      })
  }, [api, selectedKey, draft, loadMessages])

  if (available === false) {
    return (
      <PageChrome title="Conversations">
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
          <ChatsCircle size={40} className="text-kumo-inactive" />
          <p className="text-[14px] text-kumo-subtle">
            Connect your Microsoft account with the Teams capability to see your conversations here.
          </p>
        </div>
      </PageChrome>
    )
  }

  return (
    <PageChrome title="Conversations">
      <div className="flex h-full min-h-0">
        {/* Conversation list */}
        <div className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-kumo-line">
          <ListSection title="Conversations" items={conversations} selectedKey={selectedKey}
              avatarFor={avatarFor}
              onSelect={key => navigate({ search: { c: key } })} />
          <ListSection title="Channels" items={channels} selectedKey={selectedKey}
              avatarFor={avatarFor}
              onSelect={key => navigate({ search: { c: key } })} />
          {loading && conversations.length === 0 && (
            <div className="flex flex-col gap-1 p-3">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="h-9 animate-pulse rounded-md bg-kumo-elevated" />
              ))}
            </div>
          )}
        </div>

        {/* Thread */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <>
              <div className="flex h-12 shrink-0 items-center gap-2 border-b border-kumo-line px-4">
                <span className="text-[14px] font-medium text-kumo-default">{selected.title}</span>
                {selected.subtitle && (
                  <span className="text-[12px] text-kumo-inactive">{selected.subtitle}</span>
                )}
              </div>
              <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {messagesLoading && messages.length === 0 ? (
                  <div className="flex flex-col gap-2">
                    {[0, 1, 2].map(i => (
                      <div key={i} className="h-12 w-2/3 animate-pulse rounded-md bg-kumo-elevated" />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {messages.map(message => (
                      <MessageBubble key={message.id} message={message} avatarFor={avatarFor} />
                    ))}
                    {pending.map(p => (
                      <div key={p.key} className="flex justify-end">
                        <div className="max-w-[70%] rounded-lg bg-kumo-elevated px-3 py-2">
                          <p className="text-[13px] text-kumo-default">{p.text}</p>
                          <p className="mt-0.5 text-[10px] text-kumo-inactive">
                            {p.status === 'sending' ? 'Sending…'
                              : p.status === 'unknown' ? 'Delivery unknown — checking…'
                              : 'Failed'}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="shrink-0 border-t border-kumo-line p-3">
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        send()
                      }
                    }}
                    rows={1}
                    placeholder={`Message ${selected.title}`}
                    className="max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-[13px] text-kumo-default outline-none placeholder:text-kumo-inactive focus:border-kumo-brand"
                  />
                  <button
                    type="button"
                    onClick={send}
                    disabled={!draft.trim()}
                    aria-label="Send message"
                    className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-kumo-brand text-white transition-opacity disabled:opacity-40"
                  >
                    <PaperPlaneRight size={16} weight="fill" />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <ChatsCircle size={40} className="text-kumo-inactive" />
              <p className="text-[14px] text-kumo-subtle">Select a conversation</p>
            </div>
          )}
        </div>
      </div>
    </PageChrome>
  )
}

function ListSection({ title, items, selectedKey, avatarFor, onSelect }: {
  title: string
  items: ConversationSummary[]
  selectedKey: string | undefined
  avatarFor(userId: string | undefined): string | undefined
  onSelect(key: string): void
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col">
      <p className="px-3 pb-1 pt-3 text-[11px] font-medium tracking-[-0.1px] text-kumo-inactive">
        {title}
      </p>
      {items.map(conversation => {
        const key = refKey(conversation.ref)
        const photo = conversation.ref.kind === 'chat' && conversation.members.length === 1
          ? avatarFor(conversation.members[0]?.userId)
          : undefined
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            className={`flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-kumo-elevated ${
              key === selectedKey ? 'bg-kumo-elevated' : ''
            }`}
          >
            {photo ? (
              <img src={photo} alt="" className="size-8 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-kumo-elevated text-[11px] font-semibold text-kumo-subtle">
                {monogram(conversation.title)}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-medium text-kumo-default">
                  {conversation.title}
                </span>
                <span className="shrink-0 text-[10.5px] text-kumo-inactive">
                  {formatTime(conversation.lastActivity)}
                </span>
              </span>
              {conversation.lastMessage && (
                <span className="block truncate text-[12px] text-kumo-inactive">
                  {conversation.lastMessage.from ? `${conversation.lastMessage.from}: ` : ''}
                  {conversation.lastMessage.preview}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function MessageBubble({ message, avatarFor }: {
  message: ConversationMessage
  avatarFor(userId: string | undefined): string | undefined
}) {
  const photo = !message.fromSelf ? avatarFor(message.fromUserId) : undefined
  return (
    <div className={`flex gap-2 ${message.fromSelf ? 'justify-end' : ''}`}>
      {!message.fromSelf && (
        photo ? (
          <img src={photo} alt="" className="mt-1 size-7 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-kumo-elevated text-[10px] font-semibold text-kumo-subtle">
            {monogram(message.from)}
          </span>
        )
      )}
      <div className={`max-w-[70%] rounded-lg px-3 py-2 ${
        message.fromSelf ? 'bg-kumo-brand/10' : 'bg-kumo-elevated'
      }`}>
        {!message.fromSelf && (
          <p className="mb-0.5 flex items-baseline gap-2">
            <span className="text-[12px] font-medium text-kumo-default">{message.from}</span>
            <span className="text-[10px] text-kumo-inactive">{formatTime(message.created)}</span>
          </p>
        )}
        {/* Sanitized by the gatekeeper (allowlist HTMLRewriter) before it ever reaches the client. */}
        <div
          className="prose prose-sm max-w-none text-[13px] text-kumo-default [&_a]:text-kumo-brand"
          dangerouslySetInnerHTML={{ __html: message.html }}
        />
      </div>
    </div>
  )
}
