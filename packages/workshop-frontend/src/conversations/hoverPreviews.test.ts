import { describe, expect, it } from 'vitest'
import type { ConversationSummary, EmailSummary } from '@gadgets/workshop-shared/gatekeeper'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { conversationPreview, emailPreview, workspacePreview } from './hoverPreviews'

describe('hoverPreviews', () => {
  it('builds a conversation preview from the last message and team', () => {
    const conversation: ConversationSummary = {
      ref: { kind: 'channel', teamId: 'ops', channelId: 'general' },
      title: 'Simplot Opsys',
      subtitle: 'Operations',
      members: [{ name: 'Ada' }],
      lastMessage: { from: 'Ada', preview: 'Ship the build' },
      lastActivity: new Date(Date.now() - 3 * 60_000),
    }
    expect(conversationPreview(conversation)).toEqual({
      title: 'Simplot Opsys',
      meta: 'Updated 3m ago',
      body: 'Ada: Ship the build',
      footer: 'Operations',
    })
  })

  it('builds an email preview from subject, sender, and flags', () => {
    const email: EmailSummary = {
      id: 'm1',
      subject: 'Quarterly review',
      from: { name: 'Pat', address: 'pat@example.com' },
      received: new Date(Date.now() - 2 * 60_000),
      preview: 'Please review the attached deck.',
      isRead: false,
      hasAttachments: true,
    }
    expect(emailPreview(email)).toEqual({
      title: 'Quarterly review',
      meta: 'Pat · Received 2m ago',
      body: 'Please review the attached deck.',
      footer: 'Unread · Has attachments',
    })
  })

  it('builds a workspace preview from created, last active, and owner', () => {
    const gadget = {
      id: 'g1',
      title: 'Fixed-Bid SOW Pricing',
      created: new Date(Date.now() - 3 * 24 * 60 * 60_000),
      lastActive: new Date(),
      owner: { id: 'u1', name: 'Riley' },
    } as GadgetMetadataWithTimestamps
    expect(workspacePreview(gadget)).toEqual({
      title: 'Fixed-Bid SOW Pricing',
      meta: 'Created 3d ago, updated just now',
      footer: 'Shared by Riley',
    })
  })
})
