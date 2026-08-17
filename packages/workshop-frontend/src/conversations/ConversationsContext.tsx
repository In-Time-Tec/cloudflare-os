import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import type { RpcStub } from 'capnweb'
import type {
  ConversationMessage, ConversationRef, ConversationsApi, ConversationSummary,
  EmailSummary,
} from '@gadgets/workshop-shared/gatekeeper'
import { useQueryClient } from '@tanstack/react-query'
import { useWorkshopSession } from '../session'
import {
  useChannelsQuery, useConversationsCapability, useConversationsQuery, useEmailsQuery,
  conversationsKey, channelsKey,
} from '../query/conversations'
import { refKey } from './refs'

export { refKey, parseRefKey } from './refs'

type ConversationsState = {
  emails: EmailSummary[]
  emailsLoading: boolean
  refreshEmails(): void
  available: boolean | null
  conversations: ConversationSummary[]
  channels: ConversationSummary[]
  loading: boolean
  refresh(): void
  api: { stub: RpcStub<ConversationsApi> } | null
  avatarFor(userId: string | undefined): string | undefined
  onEvent(listener: (event: LiveEvent) => void): () => void
  setViewing(key: string | null): void
  conversationsReady: boolean
  channelsReady: boolean
  emailsReady: boolean
}

export type LiveEvent = {
  kind: 'message'
  ref: ConversationRef
  message: ConversationMessage
}

const Context = createContext<ConversationsState | null>(null)

export function useConversations(): ConversationsState {
  const value = useContext(Context)
  if (!value) throw new Error('useConversations must be used inside ConversationsProvider')
  return value
}

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const session = useWorkshopSession()
  const queryClient = useQueryClient()
  const [api, setApi] = useState<{ stub: RpcStub<ConversationsApi> } | null>(null)
  const [avatars, setAvatars] = useState<Map<string, string>>(new Map())
  const avatarPending = useRef(new Set<string>())
  const listeners = useRef(new Set<(event: LiveEvent) => void>())
  const socketRef = useRef<WebSocket | null>(null)
  const viewingRef = useRef<string | null>(null)

  const { data: capability } = useConversationsCapability()
  const available = capability === undefined ? null : capability

  useEffect(() => {
    let cancelled = false
    session.ensureConversationsApi().then((stub) => {
      if (cancelled) return
      setApi(stub ? { stub } : null)
    }).catch(() => {
      if (!cancelled) setApi(null)
    })
    return () => {
      cancelled = true
      setApi(null)
    }
  }, [session, session.revision])

  const { data: conversations = [], isLoading: loading, isSuccess: conversationsReady } =
      useConversationsQuery()
  const { data: channels = [], isSuccess: channelsReady } = useChannelsQuery()
  const { data: emails = [], isLoading: emailsLoading, isSuccess: emailsReady } = useEmailsQuery()

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: conversationsKey() })
    void queryClient.invalidateQueries({ queryKey: channelsKey() })
  }, [queryClient])

  const refreshEmails = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['account', session.cacheScope, 'emails'] })
  }, [queryClient, session.cacheScope])

  useEffect(() => {
    const stub = api?.stub
    if (!stub) return
    let closed = false
    let socket: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const connect = () => {
      stub.getLiveEndpoint().then(({ webSocketUrl }) => {
        if (closed) return
        socket = new WebSocket(webSocketUrl)
        socketRef.current = socket
        socket.addEventListener('open', () => {
          attempt = 0
          if (viewingRef.current !== null) {
            socket?.send(JSON.stringify({ kind: 'viewing', refKey: viewingRef.current }))
          }
        })
        socket.addEventListener('message', messageEvent => {
          try {
            const event = JSON.parse(messageEvent.data) as LiveEvent
            if (event.kind === 'message') {
              for (const listener of listeners.current) listener(event)
              const key = refKey(event.ref)
              const preview = event.message.html.replace(/<[^>]+>/g, ' ').trim().slice(0, 120)
              const bump = (list: ConversationSummary[]) => {
                const index = list.findIndex(c => refKey(c.ref) === key)
                if (index < 0) return list
                const updated = { ...list[index], lastMessage: {
                  from: event.message.from, preview,
                  created: event.message.created ? new Date(event.message.created) : undefined,
                }, lastActivity: new Date() }
                return [updated, ...list.slice(0, index), ...list.slice(index + 1)]
              }
              queryClient.setQueryData(conversationsKey(), (prev: ConversationSummary[] | undefined) =>
                bump(prev ?? []))
              queryClient.setQueryData(channelsKey(), (prev: ConversationSummary[] | undefined) =>
                bump(prev ?? []))
            }
          } catch {
          }
        })
        socket.addEventListener('close', () => {
          socketRef.current = null
          if (closed) return
          attempt += 1
          retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** attempt))
        })
      }).catch(() => {
        if (!closed) {
          attempt += 1
          retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** attempt))
        }
      })
    }
    connect()
    return () => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      socket?.close()
      socketRef.current = null
    }
  }, [api, queryClient])

  const avatarFor = useCallback((userId: string | undefined): string | undefined => {
    if (!userId) return undefined
    const cached = avatars.get(userId)
    if (cached !== undefined) return cached || undefined
    const stub = api?.stub
    if (!stub || avatarPending.current.has(userId)) return undefined
    avatarPending.current.add(userId)
    stub.getAvatar(userId).then(bytes => {
      const url = bytes && bytes.byteLength > 0
        ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }))
        : ''
      setAvatars(prev => new Map(prev).set(userId, url))
    }).catch(() => {
      setAvatars(prev => new Map(prev).set(userId, ''))
    })
    return undefined
  }, [api, avatars])

  const onEvent = useCallback((listener: (event: LiveEvent) => void) => {
    listeners.current.add(listener)
    return () => { listeners.current.delete(listener) }
  }, [])

  const setViewing = useCallback((key: string | null) => {
    viewingRef.current = key
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ kind: 'viewing', refKey: key }))
    }
  }, [])

  const value = useMemo(() => ({
    available, conversations, channels, loading, refresh, api, avatarFor, onEvent, setViewing,
    emails, emailsLoading, refreshEmails,
    conversationsReady, channelsReady, emailsReady,
  }), [available, conversations, channels, loading, refresh, api, avatarFor, onEvent, setViewing,
       emails, emailsLoading, refreshEmails,
       conversationsReady, channelsReady, emailsReady])

  return <Context.Provider value={value}>{children}</Context.Provider>
}
