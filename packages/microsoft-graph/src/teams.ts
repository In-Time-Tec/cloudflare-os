import { Effect, Schema } from "effect";
import { GraphDecodeError, GraphError } from "./errors.js";
import { GraphTransport, PageCursor, validateNextLink } from "./transport.js";

// Teams operations: list chats/teams/channels, read messages, and send a message (the send is
// approval-gated by the gatekeeper; this module only performs it once told to).

// ── Private DTOs ─────────────────────────────────────────────────────────────

const ChatMemberDto = Schema.Struct({
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  userId: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
});

const ChatDto = Schema.Struct({
  id: Schema.String,
  topic: Schema.optional(Schema.NullOr(Schema.String)),
  chatType: Schema.optional(Schema.String),
  lastUpdatedDateTime: Schema.optional(Schema.String),
  webUrl: Schema.optional(Schema.NullOr(Schema.String)),
  members: Schema.optional(Schema.Array(ChatMemberDto)),
  lastMessagePreview: Schema.optional(Schema.NullOr(Schema.Struct({
    createdDateTime: Schema.optional(Schema.NullOr(Schema.String)),
    isDeleted: Schema.optional(Schema.Boolean),
    body: Schema.optional(Schema.NullOr(Schema.Struct({
      contentType: Schema.optional(Schema.NullOr(Schema.String)),
      content: Schema.optional(Schema.NullOr(Schema.String)),
    }))),
    from: Schema.optional(Schema.NullOr(Schema.Struct({
      user: Schema.optional(Schema.NullOr(Schema.Struct({
        displayName: Schema.optional(Schema.NullOr(Schema.String)),
        id: Schema.optional(Schema.NullOr(Schema.String)),
      }))),
    }))),
  }))),
});

const ChatPageDto = Schema.Struct({
  value: Schema.Array(ChatDto),
  "@odata.nextLink": Schema.optional(Schema.String),
});

const TeamDto = Schema.Struct({
  id: Schema.String,
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

const TeamPageDto = Schema.Struct({
  value: Schema.Array(TeamDto),
});

const ChannelDto = Schema.Struct({
  id: Schema.String,
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

const ChannelPageDto = Schema.Struct({
  value: Schema.Array(ChannelDto),
});

const ChatMessageDto = Schema.Struct({
  id: Schema.String,
  messageType: Schema.optional(Schema.String),
  createdDateTime: Schema.optional(Schema.NullOr(Schema.String)),
  from: Schema.optional(Schema.NullOr(Schema.Struct({
    user: Schema.optional(Schema.NullOr(Schema.Struct({
      displayName: Schema.optional(Schema.NullOr(Schema.String)),
      id: Schema.optional(Schema.NullOr(Schema.String)),
    }))),
  }))),
  mentions: Schema.optional(Schema.Array(Schema.Struct({
    mentioned: Schema.optional(Schema.NullOr(Schema.Struct({
      user: Schema.optional(Schema.NullOr(Schema.Struct({
        id: Schema.optional(Schema.NullOr(Schema.String)),
      }))),
    }))),
  }))),
  // System and deleted messages carry explicit nulls here.
  body: Schema.optional(Schema.NullOr(Schema.Struct({
    contentType: Schema.optional(Schema.NullOr(Schema.String)),
    content: Schema.optional(Schema.NullOr(Schema.String)),
  }))),
});

const ChatMessagePageDto = Schema.Struct({
  value: Schema.Array(ChatMessageDto),
  "@odata.nextLink": Schema.optional(Schema.String),
});

const MessageSentDto = Schema.Struct({ id: Schema.String });

// ── Public contracts ─────────────────────────────────────────────────────────

/** One member of a chat. */
export interface ChatMember {
  displayName?: string;
  userId?: string;
  email?: string;
}

/** One chat the signed-in user participates in. */
export interface ChatSummary {
  id: string;
  /** Group chats have topics; 1:1 chats have "". */
  topic: string;
  chatType: string;
  lastUpdated?: Date;
  members: ChatMember[];
  lastMessage?: { from?: string; preview: string; created?: Date };
}

/** One team the signed-in user is a member of. */
export interface TeamSummary { id: string; name: string; description?: string }

/** One channel of a team. */
export interface ChannelSummary { id: string; name: string; description?: string }

/** One message in a chat or channel. HTML bodies are passed through as-is. */
export interface TeamsMessage {
  id: string;
  from: string;
  /** The sender's directory object id, when Graph provides it. */
  fromUserId?: string;
  created?: Date;
  contentType: string;
  content: string;
  /** Directory ids of users @-mentioned in the message. */
  mentionedUserIds: string[];
}

/** One page of chat/channel messages plus the continuation, if more exist. */
export interface TeamsMessagePage {
  messages: TeamsMessage[];
  next?: PageCursor;
}

function toTeamsMessage(dto: typeof ChatMessageDto.Type): TeamsMessage {
  return {
    id: dto.id,
    from: dto.from?.user?.displayName ?? "unknown",
    fromUserId: dto.from?.user?.id ?? undefined,
    created: dto.createdDateTime ? new Date(dto.createdDateTime) : undefined,
    contentType: dto.body?.contentType ?? "text",
    content: dto.body?.content ?? "",
    mentionedUserIds: (dto.mentions ?? [])
        .flatMap(m => m.mentioned?.user?.id ? [m.mentioned.user.id] : []),
  };
}

function toMessagePage(dto: typeof ChatMessagePageDto.Type): TeamsMessagePage {
  const nextLink = dto["@odata.nextLink"];
  return {
    // System events (member added, etc.) are noise for reading a conversation.
    messages: dto.value.filter(m => (m.messageType ?? "message") === "message")
        .map(toTeamsMessage),
    next: nextLink ? validateNextLink(nextLink) ?? undefined : undefined,
  };
}

/** One page of chats plus the continuation, if more exist. */
export interface ChatPage {
  chats: ChatSummary[];
  next?: PageCursor;
}

function toChatPage(dto: typeof ChatPageDto.Type): ChatPage {
  const nextLink = dto["@odata.nextLink"];
  return {
    chats: dto.value.map(chat => {
      const preview = chat.lastMessagePreview;
      return {
        id: chat.id,
        topic: chat.topic ?? "",
        chatType: chat.chatType ?? "unknown",
        lastUpdated: chat.lastUpdatedDateTime
            ? new Date(chat.lastUpdatedDateTime) : undefined,
        members: (chat.members ?? []).map(member => ({
          displayName: member.displayName ?? undefined,
          userId: member.userId ?? undefined,
          email: member.email ?? undefined,
        })),
        lastMessage: preview && !preview.isDeleted ? {
          from: preview.from?.user?.displayName ?? undefined,
          preview: preview.body?.content ?? "",
          created: preview.createdDateTime ? new Date(preview.createdDateTime) : undefined,
        } : undefined,
      };
    }),
    next: nextLink ? validateNextLink(nextLink) ?? undefined : undefined,
  };
}

/** The signed-in user's chats, most recently active first, with members and last-message preview. */
export function listChats(transport: GraphTransport, options?: { top?: number })
    : Effect.Effect<ChatPage, GraphError> {
  return Effect.map(
      transport.get(["me", "chats"], ChatPageDto, {
        query: {
          top: options?.top ?? 40,
          // The only $orderby the list-chats API supports (400 otherwise).
          orderby: "lastMessagePreview/createdDateTime desc",
          expand: "members,lastMessagePreview",
        },
      }),
      toChatPage);
}

/**
 * Teams the user is associated with, including hosts of shared channels they can access —
 * a superset of joinedTeams for conversation discovery.
 */
export function listAssociatedTeams(transport: GraphTransport)
    : Effect.Effect<TeamSummary[], GraphError> {
  return Effect.map(
      transport.get(["me", "teamwork", "associatedTeams"], TeamPageDto),
      dto => dto.value.map(team => ({
        id: team.id,
        name: team.displayName ?? "",
        description: team.description ?? undefined,
      })));
}

/** Fetch the continuation of a previous chat listing. */
export function nextChatPage(transport: GraphTransport, cursor: PageCursor)
    : Effect.Effect<ChatPage, GraphError> {
  return Effect.map(transport.getPage(cursor, ChatPageDto), toChatPage);
}

/** Teams the signed-in user is a member of. */
export function listJoinedTeams(transport: GraphTransport)
    : Effect.Effect<TeamSummary[], GraphError> {
  return Effect.map(
      transport.get(["me", "joinedTeams"], TeamPageDto),
      dto => dto.value.map(team => ({
        id: team.id,
        name: team.displayName ?? "",
        description: team.description ?? undefined,
      })));
}

/** The channels of a team. */
export function listChannels(transport: GraphTransport, teamId: string)
    : Effect.Effect<ChannelSummary[], GraphError> {
  return Effect.map(
      transport.get(["teams", teamId, "channels"], ChannelPageDto),
      dto => dto.value.map(channel => ({
        id: channel.id,
        name: channel.displayName ?? "",
        description: channel.description ?? undefined,
      })));
}

/** Where a Teams conversation lives. */
export type ConversationRef =
  | { kind: "chat"; chatId: string }
  | { kind: "channel"; teamId: string; channelId: string };

function conversationSegments(ref: ConversationRef): string[] {
  return ref.kind === "chat"
      ? ["me", "chats", ref.chatId, "messages"]
      : ["teams", ref.teamId, "channels", ref.channelId, "messages"];
}

/** Recent messages in a chat or channel, newest first. */
export function listMessages(transport: GraphTransport, ref: ConversationRef,
                             options?: { top?: number })
    : Effect.Effect<TeamsMessagePage, GraphError> {
  return Effect.map(
      transport.get(conversationSegments(ref), ChatMessagePageDto, {
        query: { top: options?.top ?? 30 },
      }),
      toMessagePage);
}

/** Fetch the continuation of a previous message listing. */
export function nextTeamsMessagePage(transport: GraphTransport, cursor: PageCursor)
    : Effect.Effect<TeamsMessagePage, GraphError> {
  return Effect.map(transport.getPage(cursor, ChatMessagePageDto), toMessagePage);
}

/** Post a plain-text message to a chat or channel. */
export function sendMessage(transport: GraphTransport, ref: ConversationRef, text: string)
    : Effect.Effect<{ id: string }, GraphError> {
  return transport.post(conversationSegments(ref),
      { body: { contentType: "text", content: text } }, MessageSentDto);
}

const ChatCreatedDto = Schema.Struct({ id: Schema.String });

/**
 * Create a chat with other people, identified by SMTP address or Entra object id. Two members
 * (the signed-in user + one other) makes a oneOnOne chat; more makes a group chat. Creating a
 * chat that already exists (same 1:1 pair) returns the existing chat's id.
 */
export function createChat(transport: GraphTransport, selfId: string,
                           memberIdsOrAddresses: string[], topic?: string)
    : Effect.Effect<{ id: string }, GraphError> {
  const allMembers = [selfId, ...memberIdsOrAddresses];
  const chatType = allMembers.length > 2 ? "group" : "oneOnOne";
  return transport.post(["chats"], {
    chatType,
    ...(chatType === "group" && topic ? { topic } : {}),
    members: allMembers.map(member => ({
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${member.replaceAll("'", "''")}')`,
    })),
  }, ChatCreatedDto);
}

/** Post a plain-text reply to a channel message (channel threads). */
export function replyToChannelMessage(transport: GraphTransport, teamId: string,
                                      channelId: string, messageId: string, text: string)
    : Effect.Effect<{ id: string }, GraphError> {
  return transport.post(
      ["teams", teamId, "channels", channelId, "messages", messageId, "replies"],
      { body: { contentType: "text", content: text } }, MessageSentDto);
}

/** Recent replies to a channel message, newest first. */
export function listChannelReplies(transport: GraphTransport, teamId: string,
                                   channelId: string, messageId: string,
                                   options?: { top?: number })
    : Effect.Effect<TeamsMessagePage, GraphError> {
  return Effect.map(
      transport.get(
          ["teams", teamId, "channels", channelId, "messages", messageId, "replies"],
          ChatMessagePageDto, { query: { top: options?.top ?? 30 } }),
      toMessagePage);
}

/**
 * Fetch one message by the resource path a change notification carries, e.g.
 * "chats('19:...')/messages('1755...')" or
 * "teams('...')/channels('...')/messages('...')/replies('...')". The path is parsed and
 * re-addressed segment by segment — never followed as a raw URL.
 */
export function getMessageByNotificationResource(transport: GraphTransport, resource: string)
    : Effect.Effect<TeamsMessage & { chatId?: string; teamId?: string; channelId?: string },
                    GraphError> {
  const segments: string[] = [];
  const ids: Record<string, string> = {};
  const re = /([A-Za-z]+)\('([^']+)'\)/g;
  let match;
  while ((match = re.exec(resource)) !== null) {
    const collection = match[1];
    const id = match[2];
    segments.push(collection, id);
    ids[collection] = id;
  }
  if (segments.length < 4) {
    return Effect.fail(new GraphDecodeError({
      detail: `unrecognized notification resource shape`,
    }));
  }
  return Effect.map(
      transport.get(segments, ChatMessageDto),
      dto => ({
        ...toTeamsMessage(dto),
        chatId: ids["chats"],
        teamId: ids["teams"],
        channelId: ids["channels"],
      }));
}
