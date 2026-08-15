import { Effect, Schema } from "effect";
import { GraphError } from "./errors.js";
import { GraphTransport, PageCursor, validateNextLink } from "./transport.js";

// Teams operations: list chats/teams/channels, read messages, and send a message (the send is
// approval-gated by the gatekeeper; this module only performs it once told to).

// ── Private DTOs ─────────────────────────────────────────────────────────────

const ChatDto = Schema.Struct({
  id: Schema.String,
  topic: Schema.optional(Schema.NullOr(Schema.String)),
  chatType: Schema.optional(Schema.String),
  lastUpdatedDateTime: Schema.optional(Schema.String),
  webUrl: Schema.optional(Schema.NullOr(Schema.String)),
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
  createdDateTime: Schema.optional(Schema.String),
  from: Schema.optional(Schema.NullOr(Schema.Struct({
    user: Schema.optional(Schema.NullOr(Schema.Struct({
      displayName: Schema.optional(Schema.NullOr(Schema.String)),
    }))),
  }))),
  body: Schema.optional(Schema.Struct({
    contentType: Schema.optional(Schema.String),
    content: Schema.optional(Schema.String),
  })),
});

const ChatMessagePageDto = Schema.Struct({
  value: Schema.Array(ChatMessageDto),
  "@odata.nextLink": Schema.optional(Schema.String),
});

const MessageSentDto = Schema.Struct({ id: Schema.String });

// ── Public contracts ─────────────────────────────────────────────────────────

/** One chat the signed-in user participates in. */
export interface ChatSummary {
  id: string;
  topic: string;
  chatType: string;
  lastUpdated?: Date;
}

/** One team the signed-in user is a member of. */
export interface TeamSummary { id: string; name: string; description?: string }

/** One channel of a team. */
export interface ChannelSummary { id: string; name: string; description?: string }

/** One message in a chat or channel. HTML bodies are passed through as-is. */
export interface TeamsMessage {
  id: string;
  from: string;
  created?: Date;
  contentType: string;
  content: string;
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
    created: dto.createdDateTime ? new Date(dto.createdDateTime) : undefined,
    contentType: dto.body?.contentType ?? "text",
    content: dto.body?.content ?? "",
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

/** The signed-in user's chats, most recently active first. */
export function listChats(transport: GraphTransport, options?: { top?: number })
    : Effect.Effect<{ chats: ChatSummary[]; next?: PageCursor }, GraphError> {
  return Effect.map(
      transport.get(["me", "chats"], ChatPageDto, {
        query: { top: options?.top ?? 25, orderby: "lastUpdatedDateTime desc" },
      }),
      dto => {
        const nextLink = dto["@odata.nextLink"];
        return {
          chats: dto.value.map(chat => ({
            id: chat.id,
            topic: chat.topic ?? "",
            chatType: chat.chatType ?? "unknown",
            lastUpdated: chat.lastUpdatedDateTime
                ? new Date(chat.lastUpdatedDateTime) : undefined,
          })),
          next: nextLink ? validateNextLink(nextLink) ?? undefined : undefined,
        };
      });
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
