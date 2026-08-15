import { useCallback, useEffect, useRef, useState } from 'react'
import { PaperPlaneRight, ChatsCircle } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import type { ConversationMessage, ConversationSummary } from '@gadgets/workshop-shared/gatekeeper'
import { parseRefKey, refKey, useConversations } from './ConversationsContext'
import { useMessagesQuery, messagesKey } from '../query/conversations'
import { Avatar, PaneHeader, formatTime } from './primitives'
import { registerConversationsPush } from './push'

// The conversation thread pane: header (avatar + title), message history, composer with
// optimistic sends and the delivery-unknown reconcile contract. Used by both the conversations
// and channels pages.

type PendingSend = { key: string; text: string; status: 'sending' | 'failed' | 'unknown' }

export default function ThreadView({ conversation }: { conversation: ConversationSummary | null }) {
  const { api, avatarFor, onEvent, setViewing } = useConversations()
  const queryClient = useQueryClient()
  const selectedKey = conversation ? refKey(conversation.ref) : null
  const ref = conversation?.ref ?? null
  const { data, isLoading: messagesLoading } = useMessagesQuery(ref)
  const messages = data?.messages ?? []
  const [pending, setPending] = useState<PendingSend[]>([])
  const [draft, setDraft] = useState('')
  const scrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (api) void registerConversationsPush(api.stub)
  }, [api])

  useEffect(() => {
    setViewing(selectedKey)
    return () => setViewing(null)
  }, [selectedKey, setViewing])

  useEffect(() => onEvent(event => {
    if (!selectedKey || refKey(event.ref) !== selectedKey) return
    queryClient.setQueryData(messagesKey(parseRefKey(selectedKey)), (prev: { messages: ConversationMessage[]; hasMore: boolean } | undefined) => {
      const list = prev?.messages ?? []
      return { messages: list.some(m => m.id === event.message.id) ? list : [...list, event.message],
               hasMore: prev?.hasMore ?? false }
    })
    setPending(prev => prev.filter(p => p.status !== 'sending'))
  }), [onEvent, selectedKey, queryClient])

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
        queryClient.invalidateQueries({ queryKey: messagesKey(parseRefKey(selectedKey)) })
      })
      .catch(() => {
        // The send may or may not have reached the provider (no idempotency key): mark unknown,
        // reconcile by refetching, never blind-resend.
        setPending(prev => prev.map(p => p.key === key ? { ...p, status: 'unknown' } : p))
        setTimeout(() =>
          queryClient.invalidateQueries({ queryKey: messagesKey(parseRefKey(selectedKey)) }), 2000)
      })
  }, [api, selectedKey, draft, queryClient])

  if (!conversation) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <ChatsCircle size={40} className="text-kumo-inactive" />
        <p className="text-[14px] text-kumo-subtle">Select a conversation</p>
      </div>
    )
  }

  const headerPhoto = conversation.ref.kind === 'chat' && conversation.members.length === 1
    ? avatarFor(conversation.members[0]?.userId)
    : undefined

  return (
    <>
      <PaneHeader
        avatar={<Avatar photo={headerPhoto} title={conversation.title} size="lg" />}
        title={conversation.title}
        subtitle={conversation.subtitle
          ?? (conversation.members.length > 1
              ? conversation.members.map(m => m.name).filter(Boolean).join(', ')
              : undefined)}
      />
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
            placeholder={`Message ${conversation.title}`}
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
  )
}

function MessageBubble({ message, avatarFor }: {
  message: ConversationMessage
  avatarFor(userId: string | undefined): string | undefined
}) {
  const photo = !message.fromSelf ? avatarFor(message.fromUserId) : undefined
  return (
    <div className={`flex gap-2 ${message.fromSelf ? 'justify-end' : ''}`}>
      {!message.fromSelf && <Avatar photo={photo} title={message.from} size="md" />}
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
