import type { ConversationSummary, EmailSummary } from '@gadgets/workshop-shared/gatekeeper'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { formatPreviewTime, type SidebarHoverPreview } from '../components/AppShell/sidebarHover'

export function conversationPreview(conversation: ConversationSummary): SidebarHoverPreview {
  const last = conversation.lastMessage
  const activity = formatPreviewTime(conversation.lastActivity)
  const members = conversation.members.map((member) => member.name).filter(Boolean).join(', ')
  return {
    title: conversation.title,
    meta: activity ? `Updated ${activity}` : undefined,
    body: last
      ? `${last.from ? `${last.from}: ` : ''}${last.preview}`
      : undefined,
    footer: conversation.subtitle || members || undefined,
  }
}

export function emailPreview(email: EmailSummary): SidebarHoverPreview {
  const from = email.from?.name || email.from?.address
  const when = formatPreviewTime(email.received)
  const meta = [from, when ? `Received ${when}` : ''].filter(Boolean).join(' · ')
  const footer = [
    email.isRead ? undefined : 'Unread',
    email.hasAttachments ? 'Has attachments' : undefined,
  ].filter(Boolean).join(' · ')
  return {
    title: email.subject || '(no subject)',
    meta: meta || undefined,
    body: email.preview || undefined,
    footer: footer || undefined,
  }
}

export function workspacePreview(gadget: GadgetMetadataWithTimestamps): SidebarHoverPreview {
  const created = formatPreviewTime(gadget.created)
  const updated = formatPreviewTime(gadget.lastActive)
  const meta = [
    created ? `Created ${created}` : '',
    updated ? `updated ${updated}` : '',
  ].filter(Boolean).join(', ')
  return {
    title: gadget.title || 'Untitled workspace',
    meta: meta || undefined,
    footer: gadget.owner ? `Shared by ${gadget.owner.name}` : 'Yours',
  }
}
