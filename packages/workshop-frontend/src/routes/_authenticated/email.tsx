import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { EnvelopeSimple, ArrowSquareOut, Paperclip } from '@phosphor-icons/react'
import CommsLayout from '../../conversations/CommsLayout'
import { useConversations } from '../../conversations/ConversationsContext'
import {
  conversationsCapabilityOptions,
  emailDetailOptions,
  emailsOptions,
  useEmailDetailQuery,
} from '../../query/conversations'
import { emailPreview } from '../../conversations/hoverPreviews'
import { Avatar, ListRow, PaneHeader, formatTime } from '../../conversations/primitives'
import { useDocumentTitle } from '../../useDocumentTitle'

export const Route = createFileRoute('/_authenticated/email')({
  validateSearch: (search: Record<string, unknown>): { m?: string } =>
    typeof search.m === 'string' ? { m: search.m } : {},
  loaderDeps: ({ search }) => ({ messageId: search.m }),
  loader: async ({ context, deps }) => {
    const available = await context.queryClient.ensureQueryData(
      conversationsCapabilityOptions(context.session),
    )
    if (!available) return
    await context.queryClient.ensureQueryData({
      ...emailsOptions(context.session),
      revalidateIfStale: true,
    })
    if (deps.messageId) {
      await context.queryClient.ensureQueryData({
        ...emailDetailOptions(context.session, deps.messageId),
        revalidateIfStale: true,
      })
    }
  },
  component: EmailPage,
})

function EmailPage() {
  useDocumentTitle('Email')
  const { m: selectedId } = Route.useSearch()
  const { emails, available } = useConversations()
  const { data: detail } = useEmailDetailQuery(selectedId ?? null)

  const selectedSummary = useMemo(() =>
    emails.find(e => e.id === selectedId) ?? null, [emails, selectedId])

  if (available === false) {
    return (
      <CommsLayout title="Email" list={null} detail={
        <Empty text="Connect your Microsoft account with the Mailbox capability to see email here." />
      } />
    )
  }

  return (
    <CommsLayout
      title="Email"
      list={
        <div className="flex flex-col py-1">
          {emails.map(email => (
            <ListRow
              key={email.id}
              selected={email.id === selectedId}
              to="/email"
              search={{ m: email.id }}
              avatar={<Avatar title={email.from?.name || email.from?.address || '?'} size="md" />}
              title={email.from?.name || email.from?.address || '(unknown sender)'}
              meta={formatTime(email.received)}
              preview={email.subject}
              unread={!email.isRead}
              hoverPreview={emailPreview(email)}
            />
          ))}
        </div>
      }
      detail={
        detail ? (
          <>
            <PaneHeader
              avatar={<Avatar title={detail.from?.name || detail.from?.address || '?'} size="lg" />}
              title={detail.subject || '(no subject)'}
              subtitle={`${detail.from?.name ?? ''} <${detail.from?.address ?? ''}> · to ${
                detail.to.map(t => t.name || t.address).join(', ')}`}
              actions={detail.webLink ? (
                <a href={detail.webLink} target="_blank" rel="noopener noreferrer"
                    aria-label="Open in Outlook"
                    className="flex size-8 items-center justify-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default">
                  <ArrowSquareOut size={16} />
                </a>
              ) : undefined}
            />
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {detail.hasAttachments && (
                <p className="mb-3 flex items-center gap-1.5 text-[12px] text-kumo-inactive">
                  <Paperclip size={14} /> Has attachments — open in Outlook to download.
                </p>
              )}
              <div
                className="prose prose-sm max-w-none text-[13.5px] text-kumo-default [&_a]:text-kumo-brand"
                dangerouslySetInnerHTML={{ __html: detail.html }}
              />
            </div>
          </>
        ) : selectedId && selectedSummary ? (
          <PaneHeader title={selectedSummary.subject || '(no subject)'} />
        ) : (
          <Empty text="Select an email" />
        )
      }
    />
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <EnvelopeSimple size={40} className="text-kumo-inactive" />
      <p className="text-[14px] text-kumo-subtle">{text}</p>
    </div>
  )
}
