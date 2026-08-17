import { mutationOptions, type QueryClient } from '@tanstack/react-query'
import type { ConversationRef } from '@gadgets/workshop-shared/gatekeeper'
import type { WorkshopSession } from '../session'
import { messagesOptions } from './conversations'

export function sendConversationMessageOptions(session: WorkshopSession, queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ['conversations', 'send'] as const,
    mutationFn: async ({ ref, text }: { ref: ConversationRef; text: string }) => {
      const api = await session.ensureConversationsApi()
      if (!api) throw new Error('Conversations not connected')
      await api.sendMessage(ref, text)
    },
    onSettled: (_data, _error, vars) => {
      void queryClient.invalidateQueries({ queryKey: messagesOptions(session, vars.ref).queryKey })
    },
  })
}
