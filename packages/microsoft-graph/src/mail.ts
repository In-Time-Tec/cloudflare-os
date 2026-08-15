import { Effect, Schema } from "effect";
import { GraphDecodeError, GraphError } from "./errors.js";
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

// ── Folders ──────────────────────────────────────────────────────────────────

const FolderDto = Schema.Struct({
  id: Schema.String,
  displayName: Schema.optional(Schema.String),
  totalItemCount: Schema.optional(Schema.Number),
  unreadItemCount: Schema.optional(Schema.Number),
  childFolderCount: Schema.optional(Schema.Number),
});

const FolderPageDto = Schema.Struct({
  value: Schema.Array(FolderDto),
  "@odata.nextLink": Schema.optional(Schema.String),
});

/** One mail folder. Well-known ids ("inbox", "sentitems", "archive", ...) also work as ids. */
export interface MailFolder {
  id: string;
  name: string;
  totalCount: number;
  unreadCount: number;
  hasChildren: boolean;
}

/** Top-level mail folders (Inbox, Sent Items, Archive, custom folders, ...). */
export function listFolders(transport: GraphTransport)
    : Effect.Effect<MailFolder[], GraphError> {
  return Effect.map(
      transport.get(["me", "mailFolders"], FolderPageDto, { query: { top: 100 } }),
      dto => dto.value.map(folder => ({
        id: folder.id,
        name: folder.displayName ?? "",
        totalCount: folder.totalItemCount ?? 0,
        unreadCount: folder.unreadItemCount ?? 0,
        hasChildren: (folder.childFolderCount ?? 0) > 0,
      })));
}

/** List messages in one folder (by id or well-known name), newest first. */
export function listFolder(transport: GraphTransport, folderId: string,
                           options?: { top?: number })
    : Effect.Effect<MessagePage, GraphError> {
  return Effect.map(
      transport.get(["me", "mailFolders", folderId, "messages"], MessagePageDto, {
        query: {
          select: SUMMARY_SELECT,
          top: options?.top ?? 25,
          orderby: "receivedDateTime desc",
        },
      }),
      toPage);
}

// ── Sending ──────────────────────────────────────────────────────────────────

function toRecipients(addresses: readonly string[]) {
  return addresses.map(address => ({ emailAddress: { address } }));
}

/** What a sent email contains. Body is plain text. */
export interface SendMailInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

/** Send an email immediately (it lands in Sent Items). */
export function sendMail(transport: GraphTransport, input: SendMailInput)
    : Effect.Effect<void, GraphError> {
  return transport.postVoid(["me", "sendMail"], {
    message: {
      subject: input.subject,
      body: { contentType: "Text", content: input.body },
      toRecipients: toRecipients(input.to),
      ...(input.cc?.length ? { ccRecipients: toRecipients(input.cc) } : {}),
      ...(input.bcc?.length ? { bccRecipients: toRecipients(input.bcc) } : {}),
    },
    saveToSentItems: true,
  });
}

/** Send an existing draft (e.g. one created by createDraft and edited by the user). */
export function sendDraft(transport: GraphTransport, draftId: string)
    : Effect.Effect<void, GraphError> {
  return transport.postVoid(["me", "messages", draftId, "send"], {});
}

/** Reply to the sender of a message, sending immediately. */
export function replyToMessage(transport: GraphTransport, messageId: string, comment: string)
    : Effect.Effect<void, GraphError> {
  return transport.postVoid(["me", "messages", messageId, "reply"], { comment });
}

/** Reply to all recipients of a message, sending immediately. */
export function replyAllToMessage(transport: GraphTransport, messageId: string, comment: string)
    : Effect.Effect<void, GraphError> {
  return transport.postVoid(["me", "messages", messageId, "replyAll"], { comment });
}

/** Forward a message to new recipients, sending immediately. */
export function forwardMessage(transport: GraphTransport, messageId: string,
                               to: string[], comment?: string)
    : Effect.Effect<void, GraphError> {
  return transport.postVoid(["me", "messages", messageId, "forward"], {
    toRecipients: toRecipients(to),
    ...(comment ? { comment } : {}),
  });
}

// ── Attachments ──────────────────────────────────────────────────────────────

const AttachmentDto = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  contentType: Schema.optional(Schema.NullOr(Schema.String)),
  size: Schema.optional(Schema.Number),
  "@odata.type": Schema.optional(Schema.String),
  // fileAttachment carries the content inline as base64 when fetched by id.
  contentBytes: Schema.optional(Schema.String),
});

const AttachmentPageDto = Schema.Struct({
  value: Schema.Array(AttachmentDto),
});

/** One attachment on a message. Only file attachments can be downloaded. */
export interface AttachmentInfo {
  id: string;
  name: string;
  contentType?: string;
  size?: number;
  /** False for item/reference attachments (calendar items, links), which have no bytes. */
  isFile: boolean;
}

/** Cap for attachment downloads, matching Graph's own ~3 MB inline limit. */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/** List a message's attachments (metadata only). */
export function listAttachments(transport: GraphTransport, messageId: string)
    : Effect.Effect<AttachmentInfo[], GraphError> {
  return Effect.map(
      transport.get(["me", "messages", messageId, "attachments"], AttachmentPageDto, {
        query: { select: ["id", "name", "contentType", "size"] },
      }),
      dto => dto.value.map(a => ({
        id: a.id,
        name: a.name ?? "",
        contentType: a.contentType ?? undefined,
        size: a.size,
        isFile: (a["@odata.type"] ?? "#microsoft.graph.fileAttachment")
            === "#microsoft.graph.fileAttachment",
      })));
}

/** Download one file attachment's content as base64. Refuses non-file or oversized attachments. */
export function getAttachmentContent(transport: GraphTransport, messageId: string,
                                     attachmentId: string)
    : Effect.Effect<{ name: string; contentType?: string; base64: string }, GraphError> {
  return Effect.flatMap(
      transport.get(["me", "messages", messageId, "attachments", attachmentId], AttachmentDto),
      dto => {
        if ((dto.size ?? 0) > MAX_ATTACHMENT_BYTES) {
          return Effect.fail(new GraphDecodeError({
            detail: `attachment is ${dto.size} bytes; limit is ${MAX_ATTACHMENT_BYTES}`,
          }));
        }
        if (!dto.contentBytes) {
          return Effect.fail(new GraphDecodeError({
            detail: "attachment has no downloadable content (item or link attachment)",
          }));
        }
        return Effect.succeed({
          name: dto.name ?? "attachment",
          contentType: dto.contentType ?? undefined,
          base64: dto.contentBytes,
        });
      });
}
