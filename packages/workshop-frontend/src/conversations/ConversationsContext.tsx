import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import type { RpcStub } from 'capnweb'
import type {
  ConversationMessage, ConversationRef, ConversationsApi, ConversationSummary,
} from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from '../AuthContext'

// Shared conversations state: the ConversationsApi stub (from the first connected account that
// provides one), the conversation/channel lists, avatar cache, and the live WebSocket. One
// provider under AppShell so the sidebar and the /conversations page share a single subscription.

export function refKey(ref: ConversationRef): string {
  return ref.kind === 'chat' ? `chat:${ref.chatId}` : `channel:${ref.teamId}:${ref.channelId}`
}

export function parseRefKey(key: string): ConversationRef {
  const parts = key.split(':')
  return parts[0] === 'chat'
    ? { kind: 'chat', chatId: parts.slice(1).join(':') }
    : { kind: 'channel', teamId: parts[1], channelId: parts.slice(2).join(':') }
}

type ConversationsState = {
  /** null = still probing; false = no provider account connected. */
  available: boolean | null
  conversations: ConversationSummary[]
  channels: ConversationSummary[]
  loading: boolean
  refresh(): void
  api: { stub: RpcStub<ConversationsApi> } | null
  /** Data-URL avatar for a provider user id, fetching on first use. */
  avatarFor(userId: string | undefined): string | undefined
  /** Register a listener for live message events. Returns an unsubscribe. */
  onEvent(listener: (event: LiveEvent) => void): () => void
  /** Tell the live socket which conversation is on screen (push suppression). */
  setViewing(key: string | null): void
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
  const { authenticatedApi } = useAuthenticatedApi()
  const [api, setApi] = useState<{ stub: RpcStub<ConversationsApi> } | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [channels, setChannels] = useState<ConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [avatars, setAvatars] = useState<Map<string, string>>(new Map())
  const avatarPending = useRef(new Set<string>())
  const listeners = useRef(new Set<(event: LiveEvent) => void>())
  const socketRef = useRef<WebSocket | null>(null)
  const viewingRef = useRef<string | null>(null)

  // Acquire the capability once per authenticated connection.
  useEffect(() => {
    let cancelled = false
    let acquired: RpcStub<ConversationsApi> | null = null
    authenticatedApi.getConversationsApi()
      .then(stub => {
        if (cancelled) {
          stub?.[Symbol.dispose]()
          return
        }
        acquired = stub
        setApi(stub ? { stub } : null)
        setAvailable(stub !== null)
        if (!stub) setLoading(false)
      })
      .catch(() => {
        if (!cancelled) {
          setAvailable(false)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
      acquired?.[Symbol.dispose]()
      setApi(null)
    }
  }, [authenticatedApi])

  const refresh = useCallback(() => {
    const stub = api?.stub
    if (!stub) return
    setLoading(true)
    Promise.all([stub.listConversations(), stub.listChannels()])
      .then(([chats, channelList]) => {
        setConversations(chats)
        setChannels(channelList)
      })
      .catch(err => console.debug('conversations refresh failed', err))
      .finally(() => setLoading(false))
  }, [api])

  useEffect(() => {
    if (api) refresh()
  }, [api, refresh])

  // Live socket: connect once the API exists; reconnect with backoff on close.
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
              // Keep list previews fresh without a full refetch.
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
              setConversations(bump)
              setChannels(bump)
            }
          } catch {
            // malformed frame — ignore
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
  }, [api])

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
  }), [available, conversations, channels, loading, refresh, api, avatarFor, onEvent, setViewing])

  return <Context.Provider value={value}>{children}</Context.Provider>
}
