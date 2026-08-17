import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { ChatsCircle } from '@phosphor-icons/react'
import CommsLayout from '../../conversations/CommsLayout'
import ThreadView from '../../conversations/ThreadView'
import { parseRefKey, refKey, useConversations } from '../../conversations/ConversationsContext'
import {
  channelsOptions,
  conversationsCapabilityOptions,
  messagesOptions,
} from '../../query/conversations'
import { conversationPreview } from '../../conversations/hoverPreviews'
import { Avatar, ListRow, formatTime } from '../../conversations/primitives'
import { useDocumentTitle } from '../../useDocumentTitle'

export const Route = createFileRoute('/_authenticated/channels')({
  validateSearch: (search: Record<string, unknown>): { c?: string } =>
    typeof search.c === 'string' ? { c: search.c } : {},
  loaderDeps: ({ search }) => ({ conversationKey: search.c }),
  loader: async ({ context, deps }) => {
    const available = await context.queryClient.ensureQueryData(
      conversationsCapabilityOptions(context.session),
    )
    if (!available) return
    await context.queryClient.ensureQueryData({
      ...channelsOptions(context.session),
      revalidateIfStale: true,
    })
    if (deps.conversationKey) {
      await context.queryClient.ensureQueryData({
        ...messagesOptions(context.session, parseRefKey(deps.conversationKey)),
        revalidateIfStale: true,
      })
    }
  },
  component: Page,
})

function Page() {
  useDocumentTitle('Channels')
  const { c: selectedKey } = Route.useSearch()
  const { channels, avatarFor, available } = useConversations()
  const items = channels
  const selected = useMemo(() =>
    items.find(x => refKey(x.ref) === selectedKey) ?? null, [items, selectedKey])

  if (available === false) {
    return (
      <CommsLayout title="Channels" list={null} detail={
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <ChatsCircle size={40} className="text-kumo-inactive" />
          <p className="text-[14px] text-kumo-subtle">
            Connect your Microsoft account with the Teams capability to see your channels here.
          </p>
        </div>
      } />
    )
  }

  return (
    <CommsLayout
      title="Channels"
      list={
        <div className="flex flex-col py-1">
          {items.map(conversation => {
            const key = refKey(conversation.ref)
            const photo = conversation.ref.kind === 'chat' && conversation.members.length === 1
              ? avatarFor(conversation.members[0]?.userId)
              : undefined
            return (
              <ListRow
                key={key}
                selected={key === selectedKey}
                to="/channels"
                search={{ c: key }}
                avatar={<Avatar photo={photo} title={conversation.title} size="md" />}
                title={conversation.title}
                meta={formatTime(conversation.lastActivity)}
                preview={conversation.lastMessage
                  ? `${conversation.lastMessage.from ? conversation.lastMessage.from + ': ' : ''}${conversation.lastMessage.preview}`
                  : conversation.subtitle}
                hoverPreview={conversationPreview(conversation)}
              />
            )
          })}
        </div>
      }
      detail={<ThreadView conversation={selected} />}
    />
  )
}
