// The four Microsoft capability gatekeepers (one Durable Object class per resource type) and
// their agent-facing sessions.
//
// Security model (uniform across all four):
//   - every read fetches from Graph, then calls recorder.authorizeObservation() BEFORE any
//     data is returned to the caller;
//   - every write is authorized with recorder.authorizeAction(), performed against Graph inline,
//     and its outcome reported on the returned handle, so sessions return real provider ids;
//   - all four capabilities expose broad personal data, so observers are never allowed
//     (addObserver throws): a gadget bound to one of these cannot be shared.
//
// Effect stays inside this file: sessions run SDK operations with runGraph(), which converts
// tagged Graph failures into plain Errors whose messages tell the caller its next valid action.

import { DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { Effect, Result } from "effect";
import {
  ActionCapability, ActionDescription, ActionKind, ActionRecorder, Cursor, Gatekeeper,
  GatekeeperUserVerifier, ResourceDescription,
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

/** The message a tagged Graph failure becomes at the RPC boundary: what to do about it. */
function graphMessage(failure: GraphError): string {
  switch (failure._tag) {
    case "GraphAuthError":
      return "Microsoft credentials have expired or been revoked. Please reconnect the account.";
    case "GraphConsentError":
      return "The connected Microsoft account has not granted this capability. Expand the " +
          "account's access from the Connectors page.";
    case "GraphThrottledError":
      return `Microsoft is throttling requests; try again in ` +
          `${Math.ceil(failure.retryAfterMs / 1000)}s.`;
    case "GraphNotFoundError":
      return `Not found: ${failure.resource}.`;
    case "GraphConflictError":
      return "The item changed remotely; re-read it and try again.";
    case "GraphUnavailableError":
      return "Microsoft Graph is temporarily unavailable. Try again shortly.";
    case "GraphDecodeError":
      return "Microsoft returned an unexpected response. Try again shortly.";
  }
}

/**
 * Whether a failed write may still have landed. Graph refused the call outright for every tag but
 * two: a transport-level failure never produced an answer, and a decode failure is either a
 * rejected request or a response we could not read — both leave the outcome genuinely unknown.
 * Mutations are never auto-retried, so nothing else can have reached Microsoft twice.
 */
function mayHaveTakenEffect(failure: GraphError): boolean {
  return failure._tag === "GraphUnavailableError" || failure._tag === "GraphDecodeError";
}

/**
 * Run one SDK operation at the RPC boundary: Effect in, plain value out. Tagged failures become
 * Errors whose messages name the caller's next valid action; the tags never cross the boundary.
 */
async function runGraph<A>(operation: Effect.Effect<A, GraphError>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return result.success;
  throw new Error(graphMessage(result.failure));
}

/**
 * Run one side-effecting Graph operation as a recorded action: authorize it, perform it, then
 * report its outcome on the handle exactly once. An authorization refusal propagates before
 * anything reaches Microsoft; a Graph failure is recorded and then rethrown for the caller.
 * `detail` names what the call produced (e.g. the new item's id) for the activity log.
 */
async function performAction<A>(recorder: RpcStub<ActionRecorder>,
                                description: ActionDescription,
                                operation: Effect.Effect<A, GraphError>,
                                detail?: (value: A) => string): Promise<A> {
  const handle = await recorder.authorizeAction(description);
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) {
    await handle.succeeded(detail?.(result.success));
    return result.success;
  }
  const message = graphMessage(result.failure);
  await handle.failed(message, mayHaveTakenEffect(result.failure));
  throw new Error(message);
}

/**
 * Base class for the four capability gatekeepers: transport wiring and the private-only observer
 * policy. Subclasses own their session, action catalog, and writes.
 */
abstract class MicrosoftGatekeeperBase extends DurableObject<Env, SessionProps> {
  protected transport(): GraphTransport {
    const account = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return makeTransport(() => account.getAccessToken());
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
}

/** Format a bounded, human-readable field block for activity-log descriptions. */
function detailField(label: string, value: string): string {
  const bounded = value.length > 2000 ? value.slice(0, 2000) + "…" : value;
  return `**${label}:**\n\n${bounded}\n`;
}

// ── Outlook Mail ────────────────────────────────────────────────────────────

const CREATE_DRAFT_KIND: ActionKind = {
  tag: "microsoft.mail.draft.create", label: "Create Outlook drafts",
};

const SEND_MAIL_KIND: ActionKind = {
  tag: "microsoft.mail.send", label: "Send email",
};

export class MailboxGatekeeperImpl extends MicrosoftGatekeeperBase
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

  async getActionCatalog(): Promise<ActionCapability[]> {
    return [
      {
        kind: CREATE_DRAFT_KIND,
        summary: "Save drafts in your Drafts folder",
        risk: {
          // A draft sits in the owner's own mailbox until they send it, and deleting it undoes
          // the action entirely.
          reversible: "automatic",
          reach: "creates-content",
          audience: "private",
          freeform: true,
        },
      },
      {
        kind: SEND_MAIL_KIND,
        summary: "Send mail as you, to anyone",
        risk: {
          // Delivered mail cannot be recalled outside the tenant, and the recipients are
          // whoever the agent addressed.
          reversible: "no",
          reach: "acts-on-world",
          audience: "external",
          freeform: true,
        },
      },
    ];
  }

  async startSession(recorder: RpcStub<ActionRecorder>): Promise<OutlookMailSession> {
    return new MailSessionImpl(this.transport(), recorder.dup());
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
  #recorder: RpcStub<ActionRecorder>;
  #next: PageCursor | undefined;
  #started = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(recorder: RpcStub<ActionRecorder>,
              fetchFirst: () => Effect.Effect<Paged<T>, GraphError>,
              fetchNext: (cursor: PageCursor) => Effect.Effect<Paged<T>, GraphError>,
              describe: (items: T[]) => { title: string; description: string }) {
    super();
    this.#recorder = recorder;
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
    await this.#recorder.authorizeObservation(this.#describe(page.items));
    return page.items;
  }
}

function messageCursor(transport: GraphTransport, recorder: RpcStub<ActionRecorder>,
                       what: string,
                       fetchFirst: () => Effect.Effect<mail.MessagePage, GraphError>)
    : Cursor<OutlookMessageInfo> {
  const asPage = (page: mail.MessagePage): Paged<OutlookMessageInfo> =>
      ({ items: page.messages.map(toMessageInfo), next: page.next });
  return new GraphCursorImpl(recorder,
      () => Effect.map(fetchFirst(), asPage),
      cursor => Effect.map(mail.nextMessagePage(transport, cursor), asPage),
      items => ({
        title: `Read ${items.length} Outlook messages (${what})`,
        description: `Fetch a page of Outlook message summaries.\n\n` +
            detailField("Subjects", items.map(m => m.subject).join("\n")),
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
              private recorder: RpcStub<ActionRecorder>) {
    super();
  }

  async listInbox(): Promise<Cursor<OutlookMessageInfo>> {
    return messageCursor(this.transport, this.recorder.dup(), "inbox",
        () => mail.listInbox(this.transport));
  }

  async search(query: string): Promise<Cursor<OutlookMessageInfo>> {
    return messageCursor(this.transport, this.recorder.dup(), `search: ${query}`,
        () => mail.searchMessages(this.transport, query));
  }

  async listFolders(): Promise<MailFolderInfo[]> {
    const folders = await runGraph(mail.listFolders(this.transport));
    await this.recorder.authorizeObservation({
      title: `List ${folders.length} mail folders`,
      description: detailField("Folders", folders.map(f => f.name).join("\n")),
    });
    return folders;
  }

  async listFolder(folderId: string): Promise<Cursor<OutlookMessageInfo>> {
    return messageCursor(this.transport, this.recorder.dup(), `folder: ${folderId}`,
        () => mail.listFolder(this.transport, folderId));
  }

  async getMessage(id: string): Promise<OutlookMessageDetail> {
    const detail = await runGraph(mail.getMessage(this.transport, id));
    await this.recorder.authorizeObservation({
      title: `Read Outlook message: ${detail.subject || "(no subject)"}`,
      description: `Read the full content of one Outlook message.\n\n` +
          detailField("From", detail.from?.address ?? "unknown") +
          detailField("Subject", detail.subject || "(no subject)"),
    });
    return detail;
  }

  async createDraft(to: string[], subject: string, body: string, cc?: string[])
      : Promise<{ id: string }> {
    const created = await performAction(this.recorder, draftDescription(
        `Create Outlook draft: ${subject || "(no subject)"}`,
        detailField("To", to.join(", ")) +
        (cc?.length ? detailField("Cc", cc.join(", ")) : "") +
        detailField("Subject", subject) +
        detailField("Body", body)),
        mail.createDraft(this.transport, { to, cc, subject, body }),
        draft => `Draft id: ${draft.id}`);
    return { id: created.id };
  }

  async createReplyDraft(messageId: string, comment: string): Promise<{ id: string }> {
    const created = await performAction(this.recorder, draftDescription(
        "Create Outlook reply draft",
        detailField("In reply to message", messageId) +
        detailField("Reply body", comment)),
        mail.createReplyDraft(this.transport, messageId, comment),
        draft => `Draft id: ${draft.id}`);
    return { id: created.id };
  }

  async listAttachments(messageId: string): Promise<AttachmentInfo[]> {
    const attachments = await runGraph(mail.listAttachments(this.transport, messageId));
    await this.recorder.authorizeObservation({
      title: `List ${attachments.length} attachments`,
      description: detailField("Attachments",
          attachments.map(a => `${a.name} (${a.size ?? "?"} bytes)`).join("\n")),
    });
    return attachments;
  }

  async getAttachment(messageId: string, attachmentId: string)
      : Promise<{ name: string; contentType?: string; base64: string }> {
    const content = await runGraph(
        mail.getAttachmentContent(this.transport, messageId, attachmentId));
    await this.recorder.authorizeObservation({
      title: `Download attachment: ${content.name}`,
      description: `Download one email attachment's full content.\n\n` +
          detailField("Attachment", content.name),
    });
    return content;
  }

  async sendMail(to: string[], subject: string, body: string,
                 options?: { cc?: string[]; bcc?: string[] }): Promise<void> {
    await performAction(this.recorder, sendDescription(
        `Send email: ${subject || "(no subject)"}`,
        detailField("To", to.join(", ")) +
        (options?.cc?.length ? detailField("Cc", options.cc.join(", ")) : "") +
        (options?.bcc?.length ? detailField("Bcc", options.bcc.join(", ")) : "") +
        detailField("Subject", subject) +
        detailField("Body", body)),
        mail.sendMail(this.transport, {
          to, cc: options?.cc, bcc: options?.bcc, subject, body,
        }));
  }

  async sendDraft(draftId: string): Promise<void> {
    await performAction(this.recorder, sendDescription(
        "Send Outlook draft",
        detailField("Draft", draftId)),
        mail.sendDraft(this.transport, draftId));
  }

  async reply(messageId: string, body: string): Promise<void> {
    await performAction(this.recorder, sendDescription(
        "Send reply",
        detailField("In reply to message", messageId) +
        detailField("Body", body)),
        mail.replyToMessage(this.transport, messageId, body));
  }

  async replyAll(messageId: string, body: string): Promise<void> {
    await performAction(this.recorder, sendDescription(
        "Send reply-all",
        detailField("In reply to message", messageId) +
        detailField("Body", body)),
        mail.replyAllToMessage(this.transport, messageId, body));
  }

  async forward(messageId: string, to: string[], comment?: string): Promise<void> {
    await performAction(this.recorder, sendDescription(
        "Forward message",
        detailField("Message", messageId) +
        detailField("To", to.join(", ")) +
        (comment ? detailField("Comment", comment) : "")),
        mail.forwardMessage(this.transport, messageId, to, comment));
  }
}

function sendDescription(title: string, fields: string): ActionDescription {
  return {
    title,
    description: `Send email from the user's address. Recipients see it immediately.\n\n` + fields,
    actionKind: SEND_MAIL_KIND,
  };
}

function draftDescription(title: string, fields: string): ActionDescription {
  return {
    title,
    description: `Create a draft in the user's Outlook Drafts folder. Nothing is sent.\n\n` + fields,
    actionKind: CREATE_DRAFT_KIND,
  };
}

// ── Outlook Calendar ────────────────────────────────────────────────────────

const CREATE_EVENT_KIND: ActionKind = {
  tag: "microsoft.calendar.event.create", label: "Create calendar events",
};
const MODIFY_EVENT_KIND: ActionKind = {
  tag: "microsoft.calendar.event.modify", label: "Update or cancel calendar events",
};
const RESPOND_EVENT_KIND: ActionKind = {
  tag: "microsoft.calendar.event.respond", label: "Respond to meeting invitations",
};

export class CalendarGatekeeperImpl extends MicrosoftGatekeeperBase
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

  async getActionCatalog(): Promise<ActionCapability[]> {
    return [
      {
        kind: CREATE_EVENT_KIND,
        summary: "Put events on your calendar and invite people",
        risk: {
          // Deleting the event undoes it, but attendees keep the invitation mail they were
          // already sent, so undoing needs a human.
          reversible: "manual",
          reach: "creates-content",
          audience: "external",
          freeform: true,
        },
      },
      {
        kind: MODIFY_EVENT_KIND,
        summary: "Change or cancel events already on your calendar",
        risk: {
          // The previous version of the event is not retained anywhere, and attendees are
          // notified of the change or cancellation.
          reversible: "no",
          reach: "modifies-content",
          audience: "external",
          freeform: true,
        },
      },
      {
        kind: RESPOND_EVENT_KIND,
        summary: "Accept, decline, or tentatively accept invitations for you",
        risk: {
          // A response can be changed by responding again, but the organizer was already told.
          reversible: "manual",
          reach: "acts-on-world",
          audience: "external",
          freeform: true,
        },
      },
    ];
  }

  async startSession(recorder: RpcStub<ActionRecorder>): Promise<OutlookCalendarSession> {
    return new CalendarSessionImpl(this.transport(), recorder.dup());
  }
}

@validateRpc()
class CalendarSessionImpl extends RpcTarget implements OutlookCalendarSession {
  constructor(private transport: GraphTransport,
              private recorder: RpcStub<ActionRecorder>) {
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
    await this.recorder.authorizeObservation({
      title: `Read ${events.length} calendar events`,
      description: `Read the agenda from ${from.toISOString()} to ${to.toISOString()}.\n\n` +
          detailField("Events", events.map(e => e.subject).join("\n")),
    });
    return events;
  }

  async availability(addresses: string[], from: Date, to: Date)
      : Promise<Record<string, BusySpan[]>> {
    const map = await runGraph(
        calendar.getAvailability(this.transport, addresses, from, to));
    await this.recorder.authorizeObservation({
      title: `Check availability for ${addresses.length} people`,
      description: `Read free/busy information.\n\n` +
          detailField("People", addresses.join(", ")),
    });
    return Object.fromEntries(map);
  }

  async createEvent(event: {
    subject: string; start: Date; end: Date; body?: string; location?: string;
    attendees?: string[]; onlineMeeting?: boolean;
  }): Promise<{ id: string }> {
    const created = await performAction(this.recorder, {
      title: `Create calendar event: ${event.subject}`,
      description: "Create an event on the user's calendar. Outlook sends invitations to " +
          "attendees when the event is created.\n\n" +
          detailField("When", `${event.start.toISOString()} – ${event.end.toISOString()}`) +
          (event.attendees?.length ? detailField("Attendees", event.attendees.join(", ")) : "") +
          (event.location ? detailField("Location", event.location) : "") +
          (event.body ? detailField("Description", event.body) : ""),
      actionKind: CREATE_EVENT_KIND,
    }, calendar.createEvent(this.transport, event), created => `Event id: ${created.id}`);
    return { id: created.id };
  }

  async updateEvent(eventId: string, update: {
    subject?: string; start?: Date; end?: Date; body?: string; location?: string;
    attendees?: string[];
  }): Promise<void> {
    const changes = [
      update.subject !== undefined ? detailField("New subject", update.subject) : "",
      update.start ? detailField("New start", update.start.toISOString()) : "",
      update.end ? detailField("New end", update.end.toISOString()) : "",
      update.location !== undefined ? detailField("New location", update.location) : "",
      update.attendees ? detailField("New attendees", update.attendees.join(", ")) : "",
      update.body !== undefined ? detailField("New description", update.body) : "",
    ].join("");
    await performAction(this.recorder, {
      title: "Update calendar event",
      description: "Update an event on the user's calendar. Outlook sends updated invitations " +
          "to attendees.\n\n" + detailField("Event", eventId) + changes,
      actionKind: MODIFY_EVENT_KIND,
    }, calendar.updateEvent(this.transport, eventId, update));
  }

  async cancelEvent(eventId: string): Promise<void> {
    await performAction(this.recorder, {
      title: "Cancel calendar event",
      description: "Delete an event from the user's calendar. For events the user organizes, " +
          "Outlook sends cancellations to attendees.\n\n" + detailField("Event", eventId),
      actionKind: MODIFY_EVENT_KIND,
    }, calendar.deleteEvent(this.transport, eventId));
  }

  async respondToEvent(eventId: string, response: "accept" | "decline" | "tentativelyAccept",
                       comment?: string): Promise<void> {
    await performAction(this.recorder, {
      title: `${response === "tentativelyAccept" ? "Tentatively accept" :
              response === "accept" ? "Accept" : "Decline"} meeting invitation`,
      description: "Respond to a meeting invitation. The organizer is notified.\n\n" +
          detailField("Event", eventId) +
          (comment ? detailField("Comment", comment) : ""),
      actionKind: RESPOND_EVENT_KIND,
    }, calendar.respondToEvent(this.transport, eventId, response, comment));
  }
}

// ── OneDrive / SharePoint files ─────────────────────────────────────────────

const WRITE_FILES_KIND: ActionKind = {
  tag: "microsoft.files.write", label: "Create and edit files",
};
const DELETE_FILES_KIND: ActionKind = {
  tag: "microsoft.files.delete", label: "Delete files",
};

function fileRef(driveId: string | null): files.DriveRef {
  return driveId ? { kind: "drive", driveId } : { kind: "me" };
}

export class FilesGatekeeperImpl extends MicrosoftGatekeeperBase
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

  async getActionCatalog(): Promise<ActionCapability[]> {
    return [
      {
        kind: WRITE_FILES_KIND,
        summary: "Create files and folders, and overwrite existing files",
        risk: {
          // Overwriting a file replaces its content in place; OneDrive keeps version history,
          // but restoring a previous version is a human's job.
          reversible: "manual",
          reach: "modifies-content",
          audience: "shared",
          freeform: true,
        },
      },
      {
        kind: DELETE_FILES_KIND,
        summary: "Delete files and folders, including ones shared with colleagues",
        risk: {
          // A delete moves the item to the drive's recycle bin, from which only a human can
          // restore it. The name of the item is all the agent supplies.
          reversible: "manual",
          reach: "modifies-content",
          audience: "shared",
          freeform: false,
        },
      },
    ];
  }

  async startSession(recorder: RpcStub<ActionRecorder>): Promise<MicrosoftFilesSession> {
    return new FilesSessionImpl(this.transport(), recorder.dup());
  }
}

@validateRpc()
class FilesSessionImpl extends RpcTarget implements MicrosoftFilesSession {
  constructor(private transport: GraphTransport,
              private recorder: RpcStub<ActionRecorder>) {
    super();
  }

  async #authorizeListing(title: string, entries: FileEntry[]): Promise<void> {
    await this.recorder.authorizeObservation({
      title,
      description: detailField("Entries", entries.map(e => e.name).join("\n")),
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
    await this.recorder.authorizeObservation({
      title: `Search SharePoint sites: ${query || "(all)"}`,
      description: detailField("Sites", sites.map(s => s.name).join("\n")),
    });
    return sites;
  }

  async listSiteDrives(siteId: string): Promise<{ id: string; name: string }[]> {
    const drives = await runGraph(files.listSiteDrives(this.transport, siteId));
    await this.recorder.authorizeObservation({
      title: "List SharePoint document libraries",
      description: detailField("Libraries", drives.map(d => d.name).join("\n")),
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
    await this.recorder.authorizeObservation({
      title: `Read file metadata: ${entry.name}`,
      description: detailField("File", entry.name),
    });
    return entry;
  }

  async readTextContent(driveId: string | null, itemId: string): Promise<string> {
    const ref = fileRef(driveId);
    const entry = await runGraph(files.getItem(this.transport, ref, itemId));
    const content = await runGraph(files.downloadTextContent(this.transport, ref, itemId));
    await this.recorder.authorizeObservation({
      title: `Read file content: ${entry.name}`,
      description: `Read a file's full text content (${content.length} characters).\n\n` +
          detailField("File", entry.name),
    });
    return content;
  }

  async readContent(driveId: string | null, itemId: string)
      : Promise<{ name: string; base64: string }> {
    const ref = fileRef(driveId);
    const entry = await runGraph(files.getItem(this.transport, ref, itemId));
    const bytes = await runGraph(files.downloadContent(this.transport, ref, itemId));
    await this.recorder.authorizeObservation({
      title: `Download file: ${entry.name}`,
      description: `Download a file's full content (${bytes.byteLength} bytes).\n\n` +
          detailField("File", entry.name),
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
    return performAction(this.recorder, {
      title: `Create folder: ${name}`,
      description: "Create a folder in the user's drive.\n\n" +
          detailField("Folder name", name) +
          detailField("Inside", parentFolderId),
      actionKind: WRITE_FILES_KIND,
    }, files.createFolder(this.transport, fileRef(driveId), parentFolderId, name),
        created => `Folder id: ${created.id}`);
  }

  async uploadFile(driveId: string | null, parentFolderId: string, name: string,
                   content: string, contentType?: string): Promise<FileEntry> {
    return performAction(this.recorder, {
      title: `Create file: ${name}`,
      description: "Create a new file in the user's drive.\n\n" +
          detailField("File name", name) +
          detailField("Inside", parentFolderId) +
          detailField("Content", content),
      actionKind: WRITE_FILES_KIND,
    }, files.uploadFile(this.transport, fileRef(driveId), parentFolderId, name, content,
        contentType ?? "text/plain"),
        created => `File id: ${created.id}`);
  }

  async replaceFileContent(driveId: string | null, itemId: string, content: string,
                           contentType?: string): Promise<FileEntry> {
    // Name the file in the log entry so it reads "replace notes.md", not an opaque id.
    const entry = await runGraph(files.getItem(this.transport, fileRef(driveId), itemId));
    return performAction(this.recorder, {
      title: `Replace file content: ${entry.name}`,
      description: "Overwrite an existing file's content.\n\n" +
          detailField("File", entry.name) +
          detailField("New content", content),
      actionKind: WRITE_FILES_KIND,
    }, files.replaceFileContent(this.transport, fileRef(driveId), itemId, content,
        contentType ?? "text/plain"));
  }

  async deleteFile(driveId: string | null, itemId: string): Promise<void> {
    const entry = await runGraph(files.getItem(this.transport, fileRef(driveId), itemId));
    await performAction(this.recorder, {
      title: `Delete: ${entry.name}`,
      description: "Delete a file or folder (it moves to the drive's recycle bin).\n\n" +
          detailField("Item", entry.name),
      actionKind: DELETE_FILES_KIND,
    }, files.deleteItem(this.transport, fileRef(driveId), itemId));
  }
}

// ── Microsoft Teams ─────────────────────────────────────────────────────────

const POST_MESSAGE_KIND: ActionKind = {
  tag: "microsoft.teams.message.post", label: "Post Teams messages",
};
const CREATE_CHAT_KIND: ActionKind = {
  tag: "microsoft.teams.chat.create", label: "Start Teams chats",
};

export class TeamsGatekeeperImpl extends MicrosoftGatekeeperBase
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

  async getActionCatalog(): Promise<ActionCapability[]> {
    return [
      {
        kind: POST_MESSAGE_KIND,
        summary: "Post messages as you in your chats and team channels",
        risk: {
          // A posted message is visible to the whole conversation the moment it lands, and
          // this session offers no way to delete one.
          reversible: "no",
          reach: "acts-on-world",
          audience: "external",
          freeform: true,
        },
      },
      {
        kind: CREATE_CHAT_KIND,
        summary: "Start new chats with colleagues",
        risk: {
          // The chat exists but stays empty until a message is posted, and the participants
          // are named rather than free-form content.
          reversible: "manual",
          reach: "creates-content",
          audience: "shared",
          freeform: false,
        },
      },
    ];
  }

  async startSession(recorder: RpcStub<ActionRecorder>): Promise<TeamsSession> {
    return new TeamsSessionImpl(this.transport(), recorder.dup());
  }
}

@validateRpc()
class TeamsSessionImpl extends RpcTarget implements TeamsSession {
  constructor(private transport: GraphTransport,
              private recorder: RpcStub<ActionRecorder>) {
    super();
  }

  async listChats(): Promise<Cursor<TeamsChatInfo>> {
    const transport = this.transport;
    return new GraphCursorImpl<TeamsChatInfo>(this.recorder.dup(),
        () => Effect.map(teams.listChats(transport),
            page => ({ items: [...page.chats], next: page.next })),
        cursor => Effect.map(teams.nextChatPage(transport, cursor),
            page => ({ items: [...page.chats], next: page.next })),
        items => ({
          title: `List ${items.length} Teams chats`,
          description: detailField("Chats",
              items.map(c => c.topic || `(${c.chatType})`).join("\n")),
        }));
  }

  async listTeams(): Promise<TeamInfo[]> {
    const joined = await runGraph(teams.listJoinedTeams(this.transport));
    await this.recorder.authorizeObservation({
      title: `List ${joined.length} teams`,
      description: detailField("Teams", joined.map(t => t.name).join("\n")),
    });
    return joined;
  }

  async listChannels(teamId: string): Promise<ChannelInfo[]> {
    const channels = await runGraph(teams.listChannels(this.transport, teamId));
    await this.recorder.authorizeObservation({
      title: `List ${channels.length} channels`,
      description: detailField("Channels", channels.map(c => c.name).join("\n")),
    });
    return channels;
  }

  #messageCursor(ref: teams.ConversationRef, what: string): Cursor<TeamsMessageInfo> {
    const transport = this.transport;
    return new GraphCursorImpl<TeamsMessageInfo>(this.recorder.dup(),
        () => Effect.map(teams.listMessages(transport, ref),
            page => ({ items: [...page.messages], next: page.next })),
        cursor => Effect.map(teams.nextTeamsMessagePage(transport, cursor),
            page => ({ items: [...page.messages], next: page.next })),
        items => ({
          title: `Read ${items.length} Teams messages (${what})`,
          description: detailField("From", items.map(m => m.from).join(", ")),
        }));
  }

  async readChat(chatId: string): Promise<Cursor<TeamsMessageInfo>> {
    return this.#messageCursor({ kind: "chat", chatId }, "chat");
  }

  async readChannel(teamId: string, channelId: string): Promise<Cursor<TeamsMessageInfo>> {
    return this.#messageCursor({ kind: "channel", teamId, channelId }, "channel");
  }

  async createChat(memberAddresses: string[], topic?: string): Promise<{ id: string }> {
    // Graph binds chat members by user id or UPN; the signed-in user's own UPN comes from their
    // profile, read before the chat is authorized so the action itself is one call.
    const self = await runGraph(profile.getProfile(this.transport));
    return performAction(this.recorder, {
      title: `Start Teams chat with ${memberAddresses.join(", ")}`,
      description: "Start a chat. The other participants see it once the first message is " +
          "posted.\n\n" +
          detailField("With", memberAddresses.join(", ")) +
          (topic ? detailField("Topic", topic) : ""),
      actionKind: CREATE_CHAT_KIND,
    }, teams.createChat(this.transport, self.id, memberAddresses, topic),
        created => `Chat id: ${created.id}`);
  }

  async #post(ref: teams.ConversationRef, text: string, where: string): Promise<{ id: string }> {
    return performAction(this.recorder, {
      title: `Post Teams message to ${where}`,
      description: "Post a message that is immediately visible to the other participants.\n\n" +
          detailField("Message", text),
      actionKind: POST_MESSAGE_KIND,
    }, teams.sendMessage(this.transport, ref, text), sent => `Message id: ${sent.id}`);
  }

  async postToChat(chatId: string, text: string): Promise<{ id: string }> {
    return this.#post({ kind: "chat", chatId }, text, "a chat");
  }

  async postToChannel(teamId: string, channelId: string, text: string): Promise<{ id: string }> {
    return this.#post({ kind: "channel", teamId, channelId }, text, "a channel");
  }
}
