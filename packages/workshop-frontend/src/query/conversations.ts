import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type {
  CalendarEntry, ConversationMessage, ConversationRef, ConversationSummary, EmailSummary,
} from '@gadgets/workshop-shared/gatekeeper'
import { getActiveConversationsApi } from './api'
import { refKey } from '../conversations/ConversationsContext'

// Read queries for the Teams-backed communications surface. Lists are shared cache entries; the
// per-item reads (messages, email detail) use keepPreviousData so navigating between items keeps the
// previous item rendered — no skeleton, no blank pane.

export const conversationsKey = ['conversations'] as const
export const channelsKey = ['channels'] as const
export const emailsKey = ['emails'] as const
export const messagesKey = (ref: ConversationRef) => ['messages', refKey(ref)] as const
export const emailDetailKey = (id: string) => ['emailDetail', id] as const
export const agendaKey = (weekStartIso: string) => ['agenda', weekStartIso] as const

function api() {
  const stub = getActiveConversationsApi()
  if (!stub) throw new Error('Conversations not connected')
  return stub
}

export function useConversationsQuery() {
  return useQuery({ queryKey: conversationsKey, queryFn: async () => await api().listConversations(), enabled: getActiveConversationsApi() !== null })
}

export function useChannelsQuery() {
  return useQuery({ queryKey: channelsKey, queryFn: async () => await api().listChannels(), enabled: getActiveConversationsApi() !== null })
}

export function useEmailsQuery() {
  return useQuery({ queryKey: emailsKey, queryFn: async () => await api().listEmails(), enabled: getActiveConversationsApi() !== null })
}

export function useAgendaQuery(from: Date, to: Date) {
  return useQuery({
    queryKey: agendaKey(from.toISOString().slice(0, 10)),
    queryFn: async () => await api().listAgenda(from, to),
    enabled: getActiveConversationsApi() !== null,
  })
}

export function useMessagesQuery(ref: ConversationRef | null) {
  return useQuery({
    queryKey: ref ? messagesKey(ref) : ['messages', 'none'],
    queryFn: async () => await api().getMessages(ref!),
    enabled: ref !== null,
    placeholderData: keepPreviousData,
  })
}

export function useEmailDetailQuery(id: string | null) {
  return useQuery({
    queryKey: id ? emailDetailKey(id) : ['emailDetail', 'none'],
    queryFn: async () => await api().getEmail(id!),
    enabled: id !== null,
    placeholderData: keepPreviousData,
  })
}

export type { CalendarEntry, ConversationMessage, ConversationRef, ConversationSummary, EmailSummary }
