import type { ConversationRef } from '@gadgets/workshop-shared/gatekeeper'

export function refKey(ref: ConversationRef): string {
  return ref.kind === 'chat' ? `chat:${ref.chatId}` : `channel:${ref.teamId}:${ref.channelId}`
}

export function parseRefKey(key: string): ConversationRef {
  const parts = key.split(':')
  return parts[0] === 'chat'
    ? { kind: 'chat', chatId: parts.slice(1).join(':') }
    : { kind: 'channel', teamId: parts[1], channelId: parts.slice(2).join(':') }
}
