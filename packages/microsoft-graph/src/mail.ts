import { Effect, Schema } from "effect";
import { GraphError } from "./errors.js";
import { GraphTransport, PageCursor, validateNextLink } from "./transport.js";

// Outlook Mail operations: inbox listing, search, single-message read, and draft creation.
// Sending is deliberately absent from this module's surface for now.

// ── Private DTOs (what Graph returns) ────────────────────────────────────────

const RecipientDto = Schema.Struct({
  emailAddress: Schema.Struct({
    address: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
  }),
});

const MessageDto = Schema.Struct({
  id: Schema.String,
  subject: Schema.optional(Schema.NullOr(Schema.String)),
  from: Schema.optional(Schema.NullOr(RecipientDto)),
  toRecipients: Schema.optional(Schema.Array(RecipientDto)),
  receivedDateTime: Schema.optional(Schema.String),
  bodyPreview: Schema.optional(Schema.NullOr(Schema.String)),
  isRead: Schema.optional(Schema.Boolean),
  hasAttachments: Schema.optional(Schema.Boolean),
  webLink: Schema.optional(Schema.String),
});

const MessageWithBodyDto = Schema.Struct({
  ...MessageDto.fields,
  body: Schema.optional(Schema.NullOr(Schema.Struct({
    contentType: Schema.optional(Schema.String),
    content: Schema.optional(Schema.String),
  }))),
});

const MessagePageDto = Schema.Struct({
  value: Schema.Array(MessageDto),
  "@odata.nextLink": Schema.optional(Schema.String),
});

const DraftCreatedDto = Schema.Struct({
  id: Schema.String,
  webLink: Schema.optional(Schema.String),
});

// ── Public contracts ─────────────────────────────────────────────────────────

/** An email address with optional display name. */
export type MailAddress = { address: string; name?: string };

/** One message from a mailbox listing. */
export interface MessageSummary {
  id: string;
  subject: string;
  from?: MailAddress;
  to: MailAddress[];
  received?: Date;
  preview: string;
  isRead: boolean;
  hasAttachments: boolean;
  webLink?: string;
}

/** A full message: the summary plus its body in whichever formats Graph returned. */
export interface MessageDetail extends MessageSummary {
  bodyText?: string;
  bodyHtml?: string;
}

/** One page of a mailbox listing plus the continuation, if more pages exist. */
export interface MessagePage {
  messages: MessageSummary[];
  next?: PageCursor;
}

const SUMMARY_SELECT = ["id", "subject", "from", "toRecipients", "receivedDateTime",
  "bodyPreview", "isRead", "hasAttachments", "webLink"] as const;

function toAddress(dto: typeof RecipientDto.Type | null | undefined): MailAddress | undefined {
  const address = dto?.emailAddress.address;
  return address ? { address, name: dto.emailAddress.name || undefined } : undefined;
}

function toSummary(dto: typeof MessageDto.Type): MessageSummary {
  return {
    id: dto.id,
    subject: dto.subject ?? "",
    from: toAddress(dto.from),
    to: (dto.toRecipients ?? []).map(toAddress).filter((a): a is MailAddress => a !== undefined),
    received: dto.receivedDateTime ? new Date(dto.receivedDateTime) : undefined,
    preview: dto.bodyPreview ?? "",
    isRead: dto.isRead ?? true,
    hasAttachments: dto.hasAttachments ?? false,
    webLink: dto.webLink,
  };
}

function toPage(dto: typeof MessagePageDto.Type): MessagePage {
  const nextLink = dto["@odata.nextLink"];
  const next = nextLink ? validateNextLink(nextLink) ?? undefined : undefined;
  return { messages: dto.value.map(toSummary), next };
}

/** List inbox messages, newest first. */
export function listInbox(transport: GraphTransport, options?: { top?: number })
    : Effect.Effect<MessagePage, GraphError> {
  return Effect.map(
      transport.get(["me", "mailFolders", "inbox", "messages"], MessagePageDto, {
        query: {
          select: SUMMARY_SELECT,
          top: options?.top ?? 25,
          orderby: "receivedDateTime desc",
        },
      }),
      toPage);
}

/** Search the whole mailbox with Graph $search (KQL-lite, e.g. "from:bob quarterly"). */
export function searchMessages(transport: GraphTransport, query: string,
                               options?: { top?: number })
    : Effect.Effect<MessagePage, GraphError> {
  return Effect.map(
      transport.get(["me", "messages"], MessagePageDto, {
        query: { select: SUMMARY_SELECT, top: options?.top ?? 25, search: query },
      }),
      toPage);
}

/** Fetch the continuation of a previous listing/search. */
export function nextMessagePage(transport: GraphTransport, cursor: PageCursor)
    : Effect.Effect<MessagePage, GraphError> {
  return Effect.map(transport.getPage(cursor, MessagePageDto), toPage);
}

/** Fetch one message including its body. */
export function getMessage(transport: GraphTransport, messageId: string)
    : Effect.Effect<MessageDetail, GraphError> {
  return Effect.map(
      transport.get(["me", "messages", messageId], MessageWithBodyDto, {
        query: { select: [...SUMMARY_SELECT, "body"] },
      }),
      dto => {
        const detail: MessageDetail = toSummary(dto);
        const body = dto.body;
        if (body?.content) {
          if (body.contentType?.toLowerCase() === "html") detail.bodyHtml = body.content;
          else detail.bodyText = body.content;
        }
        return detail;
      });
}

/** What a new draft contains. Body is plain text; Outlook renders it as such. */
export interface DraftInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

/** Create a draft in the signed-in user's Drafts folder. Never sends. */
export function createDraft(transport: GraphTransport, draft: DraftInput)
    : Effect.Effect<{ id: string; webLink?: string }, GraphError> {
  const recipients = (addresses: string[]) =>
      addresses.map(address => ({ emailAddress: { address } }));
  return transport.post(["me", "messages"], {
    subject: draft.subject,
    body: { contentType: "Text", content: draft.body },
    toRecipients: recipients(draft.to),
    ...(draft.cc?.length ? { ccRecipients: recipients(draft.cc) } : {}),
  }, DraftCreatedDto);
}

/** Create a reply draft to an existing message (recipients prefilled by Outlook). Never sends. */
export function createReplyDraft(transport: GraphTransport, messageId: string,
                                 comment: string)
    : Effect.Effect<{ id: string; webLink?: string }, GraphError> {
  return transport.post(["me", "messages", messageId, "createReply"],
      { comment }, DraftCreatedDto);
}
