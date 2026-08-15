// The four Microsoft capability gatekeepers (one Durable Object class per resource type) and
// their agent-facing sessions.
//
// Security model (uniform across all four):
//   - every read fetches from Graph, then calls approvalQueue.authorizeObservation() BEFORE any
//     data is returned to the caller;
//   - every write is staged in DO storage and submitted with approvalQueue.submitAction(); the
//     Graph call happens only in applyAction() after approval. Writes are not simulated, so every
//     ActionDescription sets awaitDecision — the agent pauses until the user decides;
//   - all four capabilities expose broad personal data, so observers are never allowed
//     (addObserver throws): a gadget bound to one of these cannot be shared.
//
// Effect stays inside this file: sessions run SDK operations with runGraph(), which converts
// tagged Graph failures into plain Errors whose messages tell the caller its next valid action.

import { DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { Effect, Result } from "effect";
import {
  ActionDescription, ActionKind, ApprovalQueue, Cursor, Gatekeeper, GatekeeperUserVerifier,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  GraphError, GraphTransport, makeTransport, PageCursor,
  calendar, files, mail, profile, teams,
} from "@gadgets/microsoft-graph";
import type {
  AttachmentInfo, BusySpan, CalendarEventInfo, ChannelInfo, FileEntry, MailFolderInfo,
  MicrosoftFilesSession, OutlookCalendarSession, OutlookMailSession, OutlookMessageDetail,
  OutlookMessageInfo, SiteInfo, TeamInfo, TeamsChatInfo, TeamsMessageInfo, TeamsSession,
} from "./types.js";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env;

type SessionProps = { userObjectId: string };

// ── Shared plumbing ─────────────────────────────────────────────────────────

/**
 * Run one SDK operation at the RPC boundary: Effect in, plain value out. Tagged failures become
 * Errors whose messages name the caller's next valid action; the tags never cross the boundary.
 */
async function runGraph<A>(operation: Effect.Effect<A, GraphError>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return result.success;
  const failure = result.failure;
  switch (failure._tag) {
    case "GraphAuthError":
      throw new Error(
          "Microsoft credentials have expired or been revoked. Please reconnect the account.");
    case "GraphConsentError":
      throw new Error(
          "The connected Microsoft account has not granted this capability. Expand the " +
          "account's access from the Connectors page.");
    case "GraphThrottledError":
      throw new Error(
          `Microsoft is throttling requests; try again in ${Math.ceil(failure.retryAfterMs / 1000)}s.`);
    case "GraphNotFoundError":
      throw new Error(`Not found: ${failure.resource}.`);
    case "GraphConflictError":
      throw new Error("The item changed remotely; re-read it and try again.");
    case "GraphUnavailableError":
      throw new Error("Microsoft Graph is temporarily unavailable. Try again shortly.");
    case "GraphDecodeError":
      throw new Error("Microsoft returned an unexpected response. Try again shortly.");
  }
}

/** Sequential action ids + staged payloads, keyed in DO storage. */
class PendingActionStore<Action> {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  submit(action: Action): number {
    const id = this.#kv.get<number>("pending:nextActionId") ?? 1;
    this.#kv.put("pending:nextActionId", id + 1);
    this.#kv.put(`pending:action:${id}`, action);
    return id;
  }

  get(id: number): Action | undefined {
    return this.#kv.get<Action>(`pending:action:${id}`);
  }

  remove(id: number): void {
    this.#kv.delete(`pending:action:${id}`);
  }
}

/**
 * Base class for the four capability gatekeepers: transport wiring, the private-only observer
 * policy, and the staged-action skeleton. Subclasses own their session, action set, and applys.
 */
abstract class MicrosoftGatekeeperBase<Action>
    extends DurableObject<Env, SessionProps> {
  protected transport(): GraphTransport {
    const account = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return makeTransport(() => account.getAccessToken());
  }

  protected actions(): PendingActionStore<Action> {
    return new PendingActionStore<Action>(this.ctx.storage.kv);
  }

  /**
   * Resolve an id that may be a placeholder from an earlier staged action ("pending-draft-3",
   * "pending-event-1", ...) to the real provider id recorded when that action was applied.
   * Sessions hand agents placeholder ids at submit time (writes are not simulated); an agent that
   * chains a follow-up action on one still works because the follow-up is itself staged, and by
   * the time it is applied the referenced action has been applied and its real id recorded.
   * Throws if the referenced action was denied or not yet applied.
   */
  protected resolveId(idOrPlaceholder: string, resultKey: string): string {
    const match = /^pending-[a-z]+-(\d+)$/.exec(idOrPlaceholder);
    if (!match) return idOrPlaceholder;
    const applied = this.ctx.storage.kv.get<Record<string, string>>(
        `applied:action:${match[1]}`);
    const real = applied?.[resultKey];
    if (!real) {
      throw new Error(
          `The referenced item (${idOrPlaceholder}) has not been created yet - its approval is ` +
          `still pending or was denied. Approve it first, then retry.`);
    }
    return real;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /**
   * Everything these gatekeepers read is broad personal Microsoft data (a whole mailbox,
   * calendar, drive, or Teams account), which no other user could be entitled to wholesale —
   * so gadgets bound to them cannot be shared.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
        "Workspaces connected to a Microsoft account cannot be shared: they may expose " +
        "personal mail, calendar, file, or Teams data.");
  }

  async removeObserver(_id: string): Promise<void> {}

  async rejectAction(actionId: number): Promise<void> {
    this.actions().remove(actionId);
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return {
      message: "This Microsoft action cannot be reverted automatically; undo it in the " +
          "Microsoft app if needed.",
      canRetry: false,
    };
  }
}

/** Format a bounded, human-readable field block for approval descriptions. */
function approvalField(label: string, value: string): string {
  const bounded = value.length > 2000 ? value.slice(0, 2000) + "…" : value;
  return `**${label}:**\n\n${bounded}\n`;
}

// ── Outlook Mail ────────────────────────────────────────────────────────────

type MailAction =
  | { type: "createDraft"; to: string[]; cc?: string[]; subject: string; body: string }
  | { type: "createReplyDraft"; messageId: string; comment: string }
  | { type: "sendMail"; to: string[]; cc?: string[]; bcc?: string[];
      subject: string; body: string }
  | { type: "sendDraft"; draftId: string }
  | { type: "reply"; messageId: string; body: string }
  | { type: "replyAll"; messageId: string; body: string }
  | { type: "forward"; messageId: string; to: string[]; comment?: string };

const CREATE_DRAFT_KIND: ActionKind = {
  tag: "microsoft.mail.draft.create", label: "Create Outlook drafts",
};

const SEND_MAIL_KIND: ActionKind = {
  tag: "microsoft.mail.send", label: "Send email",
};

export class MailboxGatekeeperImpl extends MicrosoftGatekeeperBase<MailAction>
    implements Gatekeeper<OutlookMailSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "https://outlook.office.com/mail/",
      title: "Outlook Mailbox",
      snippet: "The connected account's Outlook mailbox",
      suggestedBindingName: "OUTLOOK_MAIL",
      tsType: "OutlookMailSession",
    };
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    // Drafts are additive and invisible to recipients. Sending is visible to recipients but
    // offered for opt-in auto-approval per this deployment's policy; it defaults to manual review.
    return [CREATE_DRAFT_KIND, SEND_MAIL_KIND];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<OutlookMailSession> {
    return new MailSessionImpl(this.transport(), approvalQueue.dup(), this.actions());
  }

  async applyAction(actionId: number): Promise<void> {
    const action = this.actions().get(actionId);
    if (!action) throw new Error(`Unknown pending Microsoft mail action: ${actionId}`);
    const transport = this.transport();
    let result: Record<string, string> = {};
    switch (action.type) {
      case "createDraft": {
        const created = await runGraph(mail.createDraft(transport, {
          to: action.to, cc: action.cc, subject: action.subject, body: action.body,
        }));
        result = { draftId: created.id };
        break;
      }
      case "createReplyDraft": {
        const created = await runGraph(
            mail.createReplyDraft(transport, action.messageId, action.comment));
        result = { draftId: created.id };
        break;
      }
      case "sendMail":
        await runGraph(mail.sendMail(transport, {
          to: action.to, cc: action.cc, bcc: action.bcc,
          subject: action.subject, body: action.body,
        }));
        break;
      case "sendDraft":
        await runGraph(mail.sendDraft(transport,
            this.resolveId(action.draftId, "draftId")));
        break;
      case "reply":
        await runGraph(mail.replyToMessage(transport, action.messageId, action.body));
        break;
      case "replyAll":
        await runGraph(mail.replyAllToMessage(transport, action.messageId, action.body));
        break;
      case "forward":
        await runGraph(mail.forwardMessage(transport, action.messageId, action.to,
            action.comment));
        break;
    }
    // Record the terminal provider result alongside the consumed action.
    this.ctx.storage.kv.put(`applied:action:${actionId}`, { type: action.type, ...result });
    this.actions().remove(actionId);
  }
}

/** One decoded page: items plus the validated continuation, if any. */
type Paged<T> = { items: T[]; next?: PageCursor };

/**
 * Generic paged-listing cursor: pages any Graph listing through the Cursor RPC contract,
 * authorizing each page as an observation before it is returned.
 */
class GraphCursorImpl<T> extends RpcTarget implements Cursor<T> {
  #fetchFirst: () => Effect.Effect<Paged<T>, GraphError>;
  #fetchNext: (cursor: PageCursor) => Effect.Effect<Paged<T>, GraphError>;
  #describe: (items: T[]) => { title: string; description: string };
  #approvalQueue: RpcStub<ApprovalQueue>;
  #next: PageCursor | undefined;
  #started = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(approvalQueue: RpcStub<ApprovalQueue>,
              fetchFirst: () => Effect.Effect<Paged<T>, GraphError>,
              fetchNext: (cursor: PageCursor) => Effect.Effect<Paged<T>, GraphError>,
              describe: (items: T[]) => { title: string; description: string }) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#fetchFirst = fetchFirst;
    this.#fetchNext = fetchNext;
    this.#describe = describe;
  }

  next(): Promise<T[] | null> {
    const result = this.#tail.then(() => this.#nextPage());
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #nextPage(): Promise<T[] | null> {
    if (this.#started && !this.#next) return null;
    const page = await runGraph(this.#started
        ? this.#fetchNext(this.#next!)
        : this.#fetchFirst());
    this.#started = true;
    this.#next = page.next;
    if (page.items.length === 0) return null;
    await this.#approvalQueue.authorizeObservation(this.#describe(page.items));
    return page.items;
  }
}

function messageCursor(transport: GraphTransport, approvalQueue: RpcStub<ApprovalQueue>,
                       what: string,
                       fetchFirst: () => Effect.Effect<mail.MessagePage, GraphError>)
    : Cursor<OutlookMessageInfo> {
  const asPage = (page: mail.MessagePage): Paged<OutlookMessageInfo> =>
      ({ items: page.messages.map(toMessageInfo), next: page.next });
  return new GraphCursorImpl(approvalQueue,
      () => Effect.map(fetchFirst(), asPage),
      cursor => Effect.map(mail.nextMessagePage(transport, cursor), asPage),
      items => ({
        title: `Read ${items.length} Outlook messages (${what})`,
        description: `Fetch a page of Outlook message summaries.\n\n` +
            approvalField("Subjects", items.map(m => m.subject).join("\n")),
      }));
}

function toMessageInfo(summary: mail.MessageSummary): OutlookMessageInfo {
  return {
    id: summary.id, subject: summary.subject, from: summary.from, to: summary.to,
    received: summary.received, preview: summary.preview, isRead: summary.isRead,
    hasAttachments: summary.hasAttachments, webLink: summary.webLink,
  };
}

@validateRpc()
class MailSessionImpl extends RpcTarget implements OutlookMailSession {
  constructor(private transport: GraphTransport,
              private approvalQueue: RpcStub<ApprovalQueue>,
              private actions: PendingActionStore<MailAction>) {
    super();
  }

  async listInbox(): Promise<Cursor<OutlookMessageInfo>> {
    return messageCursor(this.transport, this.approvalQueue.dup(), "inbox",
        () => mail.listInbox(this.transport));
  }

  async search(query: string): Promise<Cursor<OutlookMessageInfo>> {
    return messageCursor(this.transport, this.approvalQueue.dup(), `search: ${query}`,
        () => mail.searchMessages(this.transport, query));
  }

  async listFolders(): Promise<MailFolderInfo[]> {
    const folders = await runGraph(mail.listFolders(this.transport));
    await this.approvalQueue.authorizeObservation({
      title: `List ${folders.length} mail folders`,
      description: approvalField("Folders", folders.map(f => f.name).join("\n")),
    });
    return folders;
  }

  async listFolder(folderId: string): Promise<Cursor<OutlookMessageInfo>> {
    return messageCursor(this.transport, this.approvalQueue.dup(), `folder: ${folderId}`,
        () => mail.listFolder(this.transport, folderId));
  }

  async getMessage(id: string): Promise<OutlookMessageDetail> {
    const detail = await runGraph(mail.getMessage(this.transport, id));
    await this.approvalQueue.authorizeObservation({
      title: `Read Outlook message: ${detail.subject || "(no subject)"}`,
      description: `Read the full content of one Outlook message.\n\n` +
          approvalField("From", detail.from?.address ?? "unknown") +
          approvalField("Subject", detail.subject || "(no subject)"),
    });
    return detail;
  }

  async createDraft(to: string[], subject: string, body: string, cc?: string[])
      : Promise<{ id: string }> {
    const actionId = this.actions.submit({ type: "createDraft", to, cc, subject, body });
    await this.approvalQueue.submitAction(actionId, draftDescription(
        `Create Outlook draft: ${subject || "(no subject)"}`,
        approvalField("To", to.join(", ")) +
        (cc?.length ? approvalField("Cc", cc.join(", ")) : "") +
        approvalField("Subject", subject) +
        approvalField("Body", body)));
    return { id: `pending-draft-${actionId}` };
  }

  async createReplyDraft(messageId: string, comment: string): Promise<{ id: string }> {
    const actionId = this.actions.submit({ type: "createReplyDraft", messageId, comment });
    await this.approvalQueue.submitAction(actionId, draftDescription(
        "Create Outlook reply draft",
        approvalField("In reply to message", messageId) +
        approvalField("Reply body", comment)));
    return { id: `pending-draft-${actionId}` };
  }

  async listAttachments(messageId: string): Promise<AttachmentInfo[]> {
    const attachments = await runGraph(mail.listAttachments(this.transport, messageId));
    await this.approvalQueue.authorizeObservation({
      title: `List ${attachments.length} attachments`,
      description: approvalField("Attachments",
          attachments.map(a => `${a.name} (${a.size ?? "?"} bytes)`).join("\n")),
    });
    return attachments;
  }

  async getAttachment(messageId: string, attachmentId: string)
      : Promise<{ name: string; contentType?: string; base64: string }> {
    const content = await runGraph(
        mail.getAttachmentContent(this.transport, messageId, attachmentId));
    await this.approvalQueue.authorizeObservation({
      title: `Download attachment: ${content.name}`,
      description: `Download one email attachment's full content.\n\n` +
          approvalField("Attachment", content.name),
    });
    return content;
  }

  async sendMail(to: string[], subject: string, body: string,
                 options?: { cc?: string[]; bcc?: string[] }): Promise<void> {
    const actionId = this.actions.submit({
      type: "sendMail", to, cc: options?.cc, bcc: options?.bcc, subject, body,
    });
    await this.approvalQueue.submitAction(actionId, sendDescription(
        `Send email: ${subject || "(no subject)"}`,
        approvalField("To", to.join(", ")) +
        (options?.cc?.length ? approvalField("Cc", options.cc.join(", ")) : "") +
        (options?.bcc?.length ? approvalField("Bcc", options.bcc.join(", ")) : "") +
        approvalField("Subject", subject) +
        approvalField("Body", body)));
  }

  async sendDraft(draftId: string): Promise<void> {
    const actionId = this.actions.submit({ type: "sendDraft", draftId });
    await this.approvalQueue.submitAction(actionId, sendDescription(
        "Send Outlook draft",
        approvalField("Draft", draftId)));
  }

  async reply(messageId: string, body: string): Promise<void> {
    const actionId = this.actions.submit({ type: "reply", messageId, body });
    await this.approvalQueue.submitAction(actionId, sendDescription(
        "Send reply",
        approvalField("In reply to message", messageId) +
        approvalField("Body", body)));
  }

  async replyAll(messageId: string, body: string): Promise<void> {
    const actionId = this.actions.submit({ type: "replyAll", messageId, body });
    await this.approvalQueue.submitAction(actionId, sendDescription(
        "Send reply-all",
        approvalField("In reply to message", messageId) +
        approvalField("Body", body)));
  }

  async forward(messageId: string, to: string[], comment?: string): Promise<void> {
    const actionId = this.actions.submit({ type: "forward", messageId, to, comment });
    await this.approvalQueue.submitAction(actionId, sendDescription(
        "Forward message",
        approvalField("Message", messageId) +
        approvalField("To", to.join(", ")) +
        (comment ? approvalField("Comment", comment) : "")));
  }
}

function sendDescription(title: string, fields: string): ActionDescription {
  return {
    title,
    description: `Send email from the user's address. Recipients see it immediately.\n\n` + fields,
    implementsRevert: false,
    awaitDecision: true,
    autoApprovable: true,
    actionKind: SEND_MAIL_KIND,
  };
}

function draftDescription(title: string, fields: string): ActionDescription {
  return {
    title,
    description: `Create a draft in the user's Outlook Drafts folder. Nothing is sent.\n\n` + fields,
    implementsRevert: false,
    awaitDecision: true,
    autoApprovable: true,
    actionKind: CREATE_DRAFT_KIND,
  };
}

// ── Outlook Calendar ────────────────────────────────────────────────────────

type CalendarAction =
  | { type: "createEvent";
      subject: string; startIso: string; endIso: string;
      body?: string; location?: string; attendees?: string[]; onlineMeeting?: boolean }
  | { type: "updateEvent"; eventId: string;
      subject?: string; startIso?: string; endIso?: string;
      body?: string; location?: string; attendees?: string[] }
  | { type: "cancelEvent"; eventId: string }
  | { type: "respondToEvent"; eventId: string;
      response: "accept" | "decline" | "tentativelyAccept"; comment?: string };

const CREATE_EVENT_KIND: ActionKind = {
  tag: "microsoft.calendar.event.create", label: "Create calendar events",
};
const MODIFY_EVENT_KIND: ActionKind = {
  tag: "microsoft.calendar.event.modify", label: "Update or cancel calendar events",
};
const RESPOND_EVENT_KIND: ActionKind = {
  tag: "microsoft.calendar.event.respond", label: "Respond to meeting invitations",
};

export class CalendarGatekeeperImpl
    extends MicrosoftGatekeeperBase<CalendarAction>
    implements Gatekeeper<OutlookCalendarSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "https://outlook.office.com/calendar/",
      title: "Outlook Calendar",
      snippet: "The connected account's Outlook calendar",
      suggestedBindingName: "OUTLOOK_CALENDAR",
      tsType: "OutlookCalendarSession",
    };
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    // All offered for opt-in auto-approval per deployment policy; every kind defaults to
    // manual review until the user enables it in the approvals UI.
    return [CREATE_EVENT_KIND, MODIFY_EVENT_KIND, RESPOND_EVENT_KIND];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<OutlookCalendarSession> {
    return new CalendarSessionImpl(this.transport(), approvalQueue.dup(), this.actions());
  }

  async applyAction(actionId: number): Promise<void> {
    const action = this.actions().get(actionId);
    if (!action) throw new Error(`Unknown pending Microsoft calendar action: ${actionId}`);
    const transport = this.transport();
    let result: Record<string, string> = {};
    switch (action.type) {
      case "createEvent": {
        const created = await runGraph(calendar.createEvent(transport, {
          subject: action.subject,
          start: new Date(action.startIso),
          end: new Date(action.endIso),
          body: action.body,
          location: action.location,
          attendees: action.attendees,
          onlineMeeting: action.onlineMeeting,
        }));
        result = { eventId: created.id };
        break;
      }
      case "updateEvent":
        await runGraph(calendar.updateEvent(transport,
            this.resolveId(action.eventId, "eventId"), {
          subject: action.subject,
          start: action.startIso ? new Date(action.startIso) : undefined,
          end: action.endIso ? new Date(action.endIso) : undefined,
          body: action.body,
          location: action.location,
          attendees: action.attendees,
        }));
        result = { eventId: this.resolveId(action.eventId, "eventId") };
        break;
      case "cancelEvent":
        await runGraph(calendar.deleteEvent(transport,
            this.resolveId(action.eventId, "eventId")));
        break;
      case "respondToEvent":
        await runGraph(calendar.respondToEvent(transport,
            this.resolveId(action.eventId, "eventId"), action.response, action.comment));
        break;
    }
    this.ctx.storage.kv.put(`applied:action:${actionId}`, { type: action.type, ...result });
    this.actions().remove(actionId);
  }
}

@validateRpc()
class CalendarSessionImpl extends RpcTarget implements OutlookCalendarSession {
  constructor(private transport: GraphTransport,
              private approvalQueue: RpcStub<ApprovalQueue>,
              private actions: PendingActionStore<CalendarAction>) {
    super();
  }

  async agenda(from: Date, to: Date): Promise<CalendarEventInfo[]> {
    // One agenda call returns at most one Graph page (50 events) plus follow-ups, bounded to
    // keep a runaway window from paging forever.
    const events: CalendarEventInfo[] = [];
    let page = await runGraph(calendar.listAgenda(this.transport, from, to));
    events.push(...page.events);
    for (let i = 0; page.next && i < 4; i++) {
      page = await runGraph(calendar.nextEventPage(this.transport, page.next));
      events.push(...page.events);
    }
    await this.approvalQueue.authorizeObservation({
      title: `Read ${events.length} calendar events`,
      description: `Read the agenda from ${from.toISOString()} to ${to.toISOString()}.\n\n` +
          approvalField("Events", events.map(e => e.subject).join("\n")),
    });
    return events;
  }

  async availability(addresses: string[], from: Date, to: Date)
      : Promise<Record<string, BusySpan[]>> {
    const map = await runGraph(
        calendar.getAvailability(this.transport, addresses, from, to));
    await this.approvalQueue.authorizeObservation({
      title: `Check availability for ${addresses.length} people`,
      description: `Read free/busy information.\n\n` +
          approvalField("People", addresses.join(", ")),
    });
    return Object.fromEntries(map);
  }

  async createEvent(event: {
    subject: string; start: Date; end: Date; body?: string; location?: string;
    attendees?: string[]; onlineMeeting?: boolean;
  }): Promise<{ id: string }> {
    const actionId = this.actions.submit({
      type: "createEvent", subject: event.subject,
      startIso: event.start.toISOString(), endIso: event.end.toISOString(),
      body: event.body, location: event.location, attendees: event.attendees,
      onlineMeeting: event.onlineMeeting,
    });
    await this.approvalQueue.submitAction(actionId, {
      title: `Create calendar event: ${event.subject}`,
      description: "Create an event on the user's calendar. Outlook sends invitations to " +
          "attendees when the event is created.\n\n" +
          approvalField("When", `${event.start.toISOString()} – ${event.end.toISOString()}`) +
          (event.attendees?.length ? approvalField("Attendees", event.attendees.join(", ")) : "") +
          (event.location ? approvalField("Location", event.location) : "") +
          (event.body ? approvalField("Description", event.body) : ""),
      implementsRevert: false,
      awaitDecision: true,
      autoApprovable: true,
      actionKind: CREATE_EVENT_KIND,
    });
    return { id: `pending-event-${actionId}` };
  }

  async updateEvent(eventId: string, update: {
    subject?: string; start?: Date; end?: Date; body?: string; location?: string;
    attendees?: string[];
  }): Promise<void> {
    const actionId = this.actions.submit({
      type: "updateEvent", eventId,
      subject: update.subject,
      startIso: update.start?.toISOString(), endIso: update.end?.toISOString(),
      body: update.body, location: update.location, attendees: update.attendees,
    });
    const changes = [
      update.subject !== undefined ? approvalField("New subject", update.subject) : "",
      update.start ? approvalField("New start", update.start.toISOString()) : "",
      update.end ? approvalField("New end", update.end.toISOString()) : "",
      update.location !== undefined ? approvalField("New location", update.location) : "",
      update.attendees ? approvalField("New attendees", update.attendees.join(", ")) : "",
      update.body !== undefined ? approvalField("New description", update.body) : "",
    ].join("");
    await this.approvalQueue.submitAction(actionId, {
      title: "Update calendar event",
      description: "Update an event on the user's calendar. Outlook sends updated invitations " +
          "to attendees.\n\n" + approvalField("Event", eventId) + changes,
      implementsRevert: false,
      awaitDecision: true,
      autoApprovable: true,
      actionKind: MODIFY_EVENT_KIND,
    });
  }

  async cancelEvent(eventId: string): Promise<void> {
    const actionId = this.actions.submit({ type: "cancelEvent", eventId });
    await this.approvalQueue.submitAction(actionId, {
      title: "Cancel calendar event",
      description: "Delete an event from the user's calendar. For events the user organizes, " +
          "Outlook sends cancellations to attendees.\n\n" + approvalField("Event", eventId),
      implementsRevert: false,
      awaitDecision: true,
      autoApprovable: true,
      actionKind: MODIFY_EVENT_KIND,
    });
  }

  async respondToEvent(eventId: string, response: "accept" | "decline" | "tentativelyAccept",
                       comment?: string): Promise<void> {
    const actionId = this.actions.submit({ type: "respondToEvent", eventId, response, comment });
    await this.approvalQueue.submitAction(actionId, {
      title: `${response === "tentativelyAccept" ? "Tentatively accept" :
              response === "accept" ? "Accept" : "Decline"} meeting invitation`,
      description: "Respond to a meeting invitation. The organizer is notified.\n\n" +
          approvalField("Event", eventId) +
          (comment ? approvalField("Comment", comment) : ""),
      implementsRevert: false,
      awaitDecision: true,
      autoApprovable: true,
      actionKind: RESPOND_EVENT_KIND,
    });
  }
}

// ── OneDrive / SharePoint files ─────────────────────────────────────────────

type FilesAction =
  | { type: "createFolder"; driveId: string | null; parentFolderId: string; name: string }
  | { type: "uploadFile"; driveId: string | null; parentFolderId: string; name: string;
      content: string; contentType: string }
  | { type: "replaceFileContent"; driveId: string | null; itemId: string;
      content: string; contentType: string }
  | { type: "deleteFile"; driveId: string | null; itemId: string };

const WRITE_FILES_KIND: ActionKind = {
  tag: "microsoft.files.write", label: "Create and edit files",
};
const DELETE_FILES_KIND: ActionKind = {
  tag: "microsoft.files.delete", label: "Delete files",
};

function fileRef(driveId: string | null): files.DriveRef {
  return driveId ? { kind: "drive", driveId } : { kind: "me" };
}

export class FilesGatekeeperImpl extends MicrosoftGatekeeperBase<FilesAction>
    implements Gatekeeper<MicrosoftFilesSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "https://onedrive.office.com/",
      title: "OneDrive & SharePoint Files",
      snippet: "The connected account's OneDrive and visible SharePoint libraries",
      suggestedBindingName: "MICROSOFT_FILES",
      tsType: "MicrosoftFilesSession",
    };
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    // Offered for opt-in auto-approval; deletes are grouped separately so a user can allow
    // file creation/edits without allowing deletion.
    return [WRITE_FILES_KIND, DELETE_FILES_KIND];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<MicrosoftFilesSession> {
    return new FilesSessionImpl(this.transport(), approvalQueue.dup(), this.actions());
  }

  async applyAction(actionId: number): Promise<void> {
    const action = this.actions().get(actionId);
    if (!action) throw new Error(`Unknown pending Microsoft files action: ${actionId}`);
    const transport = this.transport();
    let result: Record<string, string> = {};
    switch (action.type) {
      case "createFolder": {
        const created = await runGraph(files.createFolder(transport,
            fileRef(action.driveId), action.parentFolderId, action.name));
        result = { itemId: created.id };
        break;
      }
      case "uploadFile": {
        const created = await runGraph(files.uploadFile(transport,
            fileRef(action.driveId), this.resolveId(action.parentFolderId, "itemId"),
            action.name, action.content, action.contentType));
        result = { itemId: created.id };
        break;
      }
      case "replaceFileContent": {
        const updated = await runGraph(files.replaceFileContent(transport,
            fileRef(action.driveId), this.resolveId(action.itemId, "itemId"),
            action.content, action.contentType));
        result = { itemId: updated.id };
        break;
      }
      case "deleteFile":
        await runGraph(files.deleteItem(transport, fileRef(action.driveId),
            this.resolveId(action.itemId, "itemId")));
        break;
    }
    this.ctx.storage.kv.put(`applied:action:${actionId}`, { type: action.type, ...result });
    this.actions().remove(actionId);
  }
}

@validateRpc()
class FilesSessionImpl extends RpcTarget implements MicrosoftFilesSession {
  constructor(private transport: GraphTransport,
              private approvalQueue: RpcStub<ApprovalQueue>,
              private actions: PendingActionStore<FilesAction>) {
    super();
  }

  async #authorizeListing(title: string, entries: FileEntry[]): Promise<void> {
    await this.approvalQueue.authorizeObservation({
      title,
      description: approvalField("Entries", entries.map(e => e.name).join("\n")),
    });
  }

  async listOneDrive(folderId: string): Promise<FileEntry[]> {
    const page = await runGraph(
        files.listChildren(this.transport, { kind: "me" }, folderId));
    await this.#authorizeListing(`List OneDrive folder (${page.entries.length} entries)`,
        page.entries);
    return page.entries;
  }

  async searchOneDrive(query: string): Promise<FileEntry[]> {
    const page = await runGraph(
        files.searchDrive(this.transport, { kind: "me" }, query));
    await this.#authorizeListing(`Search OneDrive: ${query}`, page.entries);
    return page.entries;
  }

  async searchSites(query: string): Promise<SiteInfo[]> {
    const sites = await runGraph(files.searchSites(this.transport, query));
    await this.approvalQueue.authorizeObservation({
      title: `Search SharePoint sites: ${query || "(all)"}`,
      description: approvalField("Sites", sites.map(s => s.name).join("\n")),
    });
    return sites;
  }

  async listSiteDrives(siteId: string): Promise<{ id: string; name: string }[]> {
    const drives = await runGraph(files.listSiteDrives(this.transport, siteId));
    await this.approvalQueue.authorizeObservation({
      title: "List SharePoint document libraries",
      description: approvalField("Libraries", drives.map(d => d.name).join("\n")),
    });
    return drives;
  }

  async listDrive(driveId: string, folderId: string): Promise<FileEntry[]> {
    const page = await runGraph(
        files.listChildren(this.transport, { kind: "drive", driveId }, folderId));
    await this.#authorizeListing(`List drive folder (${page.entries.length} entries)`,
        page.entries);
    return page.entries;
  }

  async searchDrive(driveId: string, query: string): Promise<FileEntry[]> {
    const page = await runGraph(
        files.searchDrive(this.transport, { kind: "drive", driveId }, query));
    await this.#authorizeListing(`Search drive: ${query}`, page.entries);
    return page.entries;
  }

  async getFile(driveId: string | null, itemId: string): Promise<FileEntry> {
    const ref = fileRef(driveId);
    const entry = await runGraph(files.getItem(this.transport, ref, itemId));
    await this.approvalQueue.authorizeObservation({
      title: `Read file metadata: ${entry.name}`,
      description: approvalField("File", entry.name),
    });
    return entry;
  }

  async readTextContent(driveId: string | null, itemId: string): Promise<string> {
    const ref = fileRef(driveId);
    const entry = await runGraph(files.getItem(this.transport, ref, itemId));
    const content = await runGraph(files.downloadTextContent(this.transport, ref, itemId));
    await this.approvalQueue.authorizeObservation({
      title: `Read file content: ${entry.name}`,
      description: `Read a file's full text content (${content.length} characters).\n\n` +
          approvalField("File", entry.name),
    });
    return content;
  }

  async readContent(driveId: string | null, itemId: string)
      : Promise<{ name: string; base64: string }> {
    const ref = fileRef(driveId);
    const entry = await runGraph(files.getItem(this.transport, ref, itemId));
    const bytes = await runGraph(files.downloadContent(this.transport, ref, itemId));
    await this.approvalQueue.authorizeObservation({
      title: `Download file: ${entry.name}`,
      description: `Download a file's full content (${bytes.byteLength} bytes).\n\n` +
          approvalField("File", entry.name),
    });
    return { name: entry.name, base64: bytes.toBase64() };
  }

  async listSharedWithMe(): Promise<FileEntry[]> {
    const entries = await runGraph(files.listSharedWithMe(this.transport));
    await this.#authorizeListing(`List ${entries.length} shared files`, entries);
    return entries;
  }

  async createFolder(driveId: string | null, parentFolderId: string, name: string)
      : Promise<FileEntry> {
    const actionId = this.actions.submit({ type: "createFolder", driveId, parentFolderId, name });
    await this.approvalQueue.submitAction(actionId, {
      title: `Create folder: ${name}`,
      description: "Create a folder in the user's drive.\n\n" +
          approvalField("Folder name", name) +
          approvalField("Inside", parentFolderId),
      implementsRevert: false,
      awaitDecision: true,
      autoApprovable: true,
      actionKind: WRITE_FILES_KIND,
    });
    return {
      id: `pending-folder-${actionId}`, name, kind: "folder",
      driveId: driveId ?? undefined,
    };
  }

  async uploadFile(driveId: string | null, parentFolderId: string, name: string,
                   content: string, contentType?: string): Promise<FileEntry> {
    const actionId = this.actions.submit({
      type: "uploadFile", driveId, parentFolderId, name, content,
      contentType: contentType ?? "text/plain",
    });
    await this.approvalQueue.submitAction(actionId, {
      title: `Create file: ${name}`,
      description: "Create a new file in the user's drive.\n\n" +
          approvalField("File name", name) +
          approvalField("Inside", parentFolderId) +
          approvalField("Content", content),
      implementsRevert: false,
      awaitDecision: true,
      autoApprovable: true,
      actionKind: WRITE_FILES_KIND,
    });
    return {
      id: `pending-file-${actionId}`, name, kind: "file", size: content.length,
      driveId: driveId ?? undefined,
    };
  }

  async replaceFileContent(driveId: string | null, itemId: string, content: string,
                           contentType?: string): Promise<FileEntry> {
    // Name the file in the approval so the user reviews "replace notes.md", not an opaque id.
    // A placeholder id (pending upload) can't be looked up yet; fall back to the id itself.
    const entry = itemId.startsWith("pending-")
        ? { id: itemId, name: itemId, kind: "file" as const, driveId: driveId ?? undefined }
        : await runGraph(files.getItem(this.transport, fileRef(driveId), itemId));
    const actionId = this.actions.submit({
      type: "replaceFileContent", driveId, itemId, content,
      contentType: contentType ?? "text/plain",
    });
    await this.approvalQueue.submitAction(actionId, {
      title: `Replace file content: ${entry.name}`,
      description: "Overwrite an existing file's content.\n\n" +
          approvalField("File", entry.name) +
          approvalField("New content", content),
      implementsRevert: false,
      awaitDecision: true,
      autoApprovable: true,
      actionKind: WRITE_FILES_KIND,
    });
    return { ...entry, size: content.length };
  }

  async deleteFile(driveId: string | null, itemId: string): Promise<void> {
    const entry = itemId.startsWith("pending-")
        ? { name: itemId }
        : await runGraph(files.getItem(this.transport, fileRef(driveId), itemId));
    const actionId = this.actions.submit({ type: "deleteFile", driveId, itemId });
    await this.approvalQueue.submitAction(actionId, {
      title: `Delete: ${entry.name}`,
      description: "Delete a file or folder (it moves to the drive's recycle bin).\n\n" +
          approvalField("Item", entry.name),
      implementsRevert: false,
      awaitDecision: true,
      autoApprovable: true,
      actionKind: DELETE_FILES_KIND,
    });
  }
}

// ── Microsoft Teams ─────────────────────────────────────────────────────────

type TeamsAction =
  | { type: "postToChat"; chatId: string; text: string }
  | { type: "postToChannel"; teamId: string; channelId: string; text: string }
  | { type: "createChat"; memberAddresses: string[]; topic?: string };

const POST_MESSAGE_KIND: ActionKind = {
  tag: "microsoft.teams.message.post", label: "Post Teams messages",
};
const CREATE_CHAT_KIND: ActionKind = {
  tag: "microsoft.teams.chat.create", label: "Start Teams chats",
};

export class TeamsGatekeeperImpl extends MicrosoftGatekeeperBase<TeamsAction>
    implements Gatekeeper<TeamsSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "https://teams.microsoft.com/",
      title: "Microsoft Teams",
      snippet: "The connected account's Teams chats and channels",
      suggestedBindingName: "TEAMS",
      tsType: "TeamsSession",
    };
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    // Offered for opt-in auto-approval per deployment policy; all default to manual review.
    return [POST_MESSAGE_KIND, CREATE_CHAT_KIND];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<TeamsSession> {
    return new TeamsSessionImpl(this.transport(), approvalQueue.dup(), this.actions());
  }

  async applyAction(actionId: number): Promise<void> {
    const action = this.actions().get(actionId);
    if (!action) throw new Error(`Unknown pending Teams action: ${actionId}`);
    const transport = this.transport();
    let result: Record<string, string>;
    if (action.type === "createChat") {
      // Graph binds chat members by user id or UPN; the signed-in user's own UPN comes from
      // their profile.
      const self = await runGraph(profile.getProfile(transport));
      const created = await runGraph(teams.createChat(transport, self.id,
          action.memberAddresses, action.topic));
      result = { chatId: created.id };
    } else {
      const ref = action.type === "postToChat"
          ? { kind: "chat" as const, chatId: this.resolveId(action.chatId, "chatId") }
          : { kind: "channel" as const, teamId: action.teamId, channelId: action.channelId };
      const sent = await runGraph(teams.sendMessage(transport, ref, action.text));
      result = { messageId: sent.id };
    }
    this.ctx.storage.kv.put(`applied:action:${actionId}`, { type: action.type, ...result });
    this.actions().remove(actionId);
  }
}

@validateRpc()
class TeamsSessionImpl extends RpcTarget implements TeamsSession {
  constructor(private transport: GraphTransport,
              private approvalQueue: RpcStub<ApprovalQueue>,
              private actions: PendingActionStore<TeamsAction>) {
    super();
  }

  async listChats(): Promise<Cursor<TeamsChatInfo>> {
    const transport = this.transport;
    return new GraphCursorImpl<TeamsChatInfo>(this.approvalQueue.dup(),
        () => Effect.map(teams.listChats(transport),
            page => ({ items: [...page.chats], next: page.next })),
        cursor => Effect.map(teams.nextChatPage(transport, cursor),
            page => ({ items: [...page.chats], next: page.next })),
        items => ({
          title: `List ${items.length} Teams chats`,
          description: approvalField("Chats",
              items.map(c => c.topic || `(${c.chatType})`).join("\n")),
        }));
  }

  async listTeams(): Promise<TeamInfo[]> {
    const joined = await runGraph(teams.listJoinedTeams(this.transport));
    await this.approvalQueue.authorizeObservation({
      title: `List ${joined.length} teams`,
      description: approvalField("Teams", joined.map(t => t.name).join("\n")),
    });
    return joined;
  }

  async listChannels(teamId: string): Promise<ChannelInfo[]> {
    const channels = await runGraph(teams.listChannels(this.transport, teamId));
    await this.approvalQueue.authorizeObservation({
      title: `List ${channels.length} channels`,
      description: approvalField("Channels", channels.map(c => c.name).join("\n")),
    });
    return channels;
  }

  #messageCursor(ref: teams.ConversationRef, what: string): Cursor<TeamsMessageInfo> {
    const transport = this.transport;
    return new GraphCursorImpl<TeamsMessageInfo>(this.approvalQueue.dup(),
        () => Effect.map(teams.listMessages(transport, ref),
            page => ({ items: [...page.messages], next: page.next })),
        cursor => Effect.map(teams.nextTeamsMessagePage(transport, cursor),
            page => ({ items: [...page.messages], next: page.next })),
        items => ({
          title: `Read ${items.length} Teams messages (${what})`,
          description: approvalField("From", items.map(m => m.from).join(", ")),
        }));
  }

  async readChat(chatId: string): Promise<Cursor<TeamsMessageInfo>> {
    return this.#messageCursor({ kind: "chat", chatId }, "chat");
  }

  async readChannel(teamId: string, channelId: string): Promise<Cursor<TeamsMessageInfo>> {
    return this.#messageCursor({ kind: "channel", teamId, channelId }, "channel");
  }

  async createChat(memberAddresses: string[], topic?: string): Promise<{ id: string }> {
    const actionId = this.actions.submit({ type: "createChat", memberAddresses, topic });
    await this.approvalQueue.submitAction(actionId, {
      title: `Start Teams chat with ${memberAddresses.join(", ")}`,
      description: "Start a chat. The other participants see it once the first message is " +
          "posted.\n\n" +
          approvalField("With", memberAddresses.join(", ")) +
          (topic ? approvalField("Topic", topic) : ""),
      implementsRevert: false,
      awaitDecision: true,
      autoApprovable: true,
      actionKind: CREATE_CHAT_KIND,
    });
    return { id: `pending-chat-${actionId}` };
  }

  async #post(action: Exclude<TeamsAction, { type: "createChat" }>, where: string)
      : Promise<{ id: string }> {
    const actionId = this.actions.submit(action);
    await this.approvalQueue.submitAction(actionId, {
      title: `Post Teams message to ${where}`,
      description: "Post a message that is immediately visible to the other participants.\n\n" +
          approvalField("Message", action.text),
      implementsRevert: false,
      awaitDecision: true,
      autoApprovable: true,
      actionKind: POST_MESSAGE_KIND,
    });
    return { id: `pending-message-${actionId}` };
  }

  async postToChat(chatId: string, text: string): Promise<{ id: string }> {
    return this.#post({ type: "postToChat", chatId, text }, "a chat");
  }

  async postToChannel(teamId: string, channelId: string, text: string): Promise<{ id: string }> {
    return this.#post({ type: "postToChannel", teamId, channelId, text }, "a channel");
  }
}
