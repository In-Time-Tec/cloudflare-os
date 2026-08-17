import { queryOptions, useQuery } from '@tanstack/react-query'
import type { ConversationRef } from '@gadgets/workshop-shared/gatekeeper'
import { workshopSession, type WorkshopSession } from '../session'
import { refKey } from '../conversations/refs'
import { accountKey } from './hooks'
import { persistedQueryMeta } from './client'

export function conversationsCapabilityOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'conversationsCapability'),
    queryFn: async () => {
      const api = await session.ensureConversationsApi()
      return api !== null
    },
    meta: persistedQueryMeta,
  })
}

async function conversationsApi(session: WorkshopSession) {
  return session.ensureConversationsApi()
}

export function conversationsOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'conversations'),
    queryFn: async () => {
      const api = await conversationsApi(session)
      return api ? [...await api.listConversations()] : []
    },
    enabled: session.isAuthenticated,
    meta: persistedQueryMeta,
  })
}

export function channelsOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'channels'),
    queryFn: async () => {
      const api = await conversationsApi(session)
      return api ? [...await api.listChannels()] : []
    },
    enabled: session.isAuthenticated,
    meta: persistedQueryMeta,
  })
}

export function emailsOptions(session: WorkshopSession) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'emails'),
    queryFn: async () => {
      const api = await conversationsApi(session)
      return api ? [...await api.listEmails()] : []
    },
    enabled: session.isAuthenticated,
    meta: persistedQueryMeta,
  })
}

export function agendaOptions(session: WorkshopSession, from: Date, to: Date) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'agenda', from.toISOString().slice(0, 10)),
    queryFn: async () => {
      const api = await conversationsApi(session)
      return api ? [...await api.listAgenda(from, to)] : []
    },
    enabled: session.isAuthenticated,
    meta: persistedQueryMeta,
  })
}

export function messagesOptions(session: WorkshopSession, ref: ConversationRef) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'messages', refKey(ref)),
    queryFn: async () => {
      const api = await conversationsApi(session)
      if (!api) return { messages: [], hasMore: false }
      const result = await api.getMessages(ref)
      return { messages: [...result.messages], hasMore: result.hasMore }
    },
    meta: persistedQueryMeta,
  })
}

export function emailDetailOptions(session: WorkshopSession, id: string) {
  return queryOptions({
    queryKey: accountKey(session.cacheScope, 'emailDetail', id),
    queryFn: async () => {
      const api = await conversationsApi(session)
      if (!api) throw new Error('Conversations not connected')
      return { ...await api.getEmail(id) }
    },
    meta: persistedQueryMeta,
  })
}

export const conversationsKey = (session: WorkshopSession = workshopSession) => conversationsOptions(session).queryKey
export const channelsKey = (session: WorkshopSession = workshopSession) => channelsOptions(session).queryKey
export const emailsKey = (session: WorkshopSession = workshopSession) => emailsOptions(session).queryKey
export const messagesKey = (ref: ConversationRef, session: WorkshopSession = workshopSession) => messagesOptions(session, ref).queryKey
export const emailDetailKey = (id: string, session: WorkshopSession = workshopSession) => emailDetailOptions(session, id).queryKey
export const agendaKey = (weekStartIso: string, session: WorkshopSession = workshopSession) =>
  accountKey(session.cacheScope, 'agenda', weekStartIso)

export function useConversationsCapability() {
  return useQuery(conversationsCapabilityOptions(workshopSession))
}

export function useConversationsQuery() {
  return useQuery(conversationsOptions(workshopSession))
}

export function useChannelsQuery() {
  return useQuery(channelsOptions(workshopSession))
}

export function useEmailsQuery() {
  return useQuery(emailsOptions(workshopSession))
}

export function useAgendaQuery(from: Date, to: Date) {
  return useQuery(agendaOptions(workshopSession, from, to))
}

export function useMessagesQuery(ref: ConversationRef | null) {
  return useQuery({
    ...messagesOptions(workshopSession, ref ?? { kind: 'chat', chatId: 'none' }),
    enabled: ref !== null,
  })
}

export function useEmailDetailQuery(id: string | null) {
  return useQuery({
    ...emailDetailOptions(workshopSession, id ?? 'none'),
    enabled: id !== null,
  })
}
