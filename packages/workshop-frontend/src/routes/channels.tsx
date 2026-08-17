import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { ChatsCircle } from '@phosphor-icons/react'
import CommsLayout from '../conversations/CommsLayout'
import ThreadView from '../conversations/ThreadView'
import { refKey, useConversations } from '../conversations/ConversationsContext'
import { Avatar, ListRow, formatTime } from '../conversations/primitives'
import { SkeletonRows } from '../components/Skeleton'
import { useDocumentTitle } from '../useDocumentTitle'

// The Channels page: Teams channels only — the list pane is scoped to this section.

export const Route = createFileRoute('/channels')({
  component: Page,
  validateSearch: (search: Record<string, unknown>): { c?: string } =>
    typeof search.c === 'string' ? { c: search.c } : {},
})

function Page() {
  useDocumentTitle('Channels')
  const { c: selectedKey } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { channels, loading, avatarFor, available } = useConversations()
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
                onClick={() => navigate({ search: { c: key } })}
                avatar={<Avatar photo={photo} title={conversation.title} size="md" />}
                title={conversation.title}
                meta={formatTime(conversation.lastActivity)}
                preview={conversation.lastMessage
                  ? `${conversation.lastMessage.from ? conversation.lastMessage.from + ': ' : ''}${conversation.lastMessage.preview}`
                  : conversation.subtitle}
              />
            )
          })}
          {loading && items.length === 0 && (
            <SkeletonRows count={8}>{i => <ListRow key={i} />}</SkeletonRows>
          )}
        </div>
      }
      detail={<ThreadView conversation={selected} />}
    />
  )
}
