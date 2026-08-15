import { Cursor } from "@gadgets/workshop-shared/gatekeeper";

export type { Cursor };

// ── Shared plain data ───────────────────────────────────────────────

/** An email address with optional display name. */
export type MailAddress = { address: string; name?: string };

// ── Outlook Mail ────────────────────────────────────────────────────

/** One message from a mailbox listing. */
export type OutlookMessageInfo = {
  id: string;
  subject: string;
  from?: MailAddress;
  to: MailAddress[];
  received?: Date;
  /** Short plain-text preview of the body. */
  preview: string;
  isRead: boolean;
  hasAttachments: boolean;
  /** Link that opens the message in Outlook on the web. */
  webLink?: string;
};

/** A full message: the summary plus its body in whichever formats exist. */
export type OutlookMessageDetail = OutlookMessageInfo & {
  bodyText?: string;
  bodyHtml?: string;
};

/** One mail folder. Well-known names ("inbox", "sentitems", "archive",
 *  "drafts", "deleteditems") also work anywhere a folder id is accepted. */
export type MailFolderInfo = {
  id: string;
  name: string;
  totalCount: number;
  unreadCount: number;
  hasChildren: boolean;
};

/** One attachment on a message (metadata). */
export type AttachmentInfo = {
  id: string;
  name: string;
  contentType?: string;
  size?: number;
  /** False for calendar-item or link attachments, which cannot be downloaded. */
  isFile: boolean;
};

export interface OutlookMailSession {
  /** List inbox messages, newest first. Returns a cursor that lazily fetches
   *  pages as consumed. */
  listInbox(): Promise<Cursor<OutlookMessageInfo>>;

  /** Search the whole mailbox (e.g. "from:bob quarterly report"). Returns a
   *  cursor that lazily fetches pages as consumed. */
  search(query: string): Promise<Cursor<OutlookMessageInfo>>;

  /** The mailbox's folders (Inbox, Sent Items, Archive, custom, ...). */
  listFolders(): Promise<MailFolderInfo[]>;

  /** List one folder's messages, newest first (folder id or well-known name).
   *  Returns a cursor that lazily fetches pages as consumed. */
  listFolder(folderId: string): Promise<Cursor<OutlookMessageInfo>>;

  /** Fetch one message including its body, by id from a listing or search. */
  getMessage(id: string): Promise<OutlookMessageDetail>;

  /** List a message's attachments (metadata only). */
  listAttachments(messageId: string): Promise<AttachmentInfo[]>;

  /** Download one file attachment's content as base64 (up to 3 MB). */
  getAttachment(messageId: string, attachmentId: string)
      : Promise<{ name: string; contentType?: string; base64: string }>;

  /** Create a draft in the user's Drafts folder for them to review and send.
   *  Never sends mail. Returns the new draft's id. */
  createDraft(to: string[], subject: string, body: string, cc?: string[])
      : Promise<{ id: string }>;

  /** Create a reply draft to an existing message (recipients and history are
   *  prefilled by Outlook). Never sends mail. Returns the new draft's id. */
  createReplyDraft(messageId: string, comment: string): Promise<{ id: string }>;

  /** Send an email from the user's address. It lands in their Sent Items. */
  sendMail(to: string[], subject: string, body: string,
           options?: { cc?: string[]; bcc?: string[] }): Promise<void>;

  /** Send an existing draft (by real draft id, e.g. after the user edited it
   *  in Outlook). */
  sendDraft(draftId: string): Promise<void>;

  /** Reply to a message's sender, sending immediately. */
  reply(messageId: string, body: string): Promise<void>;

  /** Reply to all recipients of a message, sending immediately. */
  replyAll(messageId: string, body: string): Promise<void>;

  /** Forward a message to new recipients, sending immediately. */
  forward(messageId: string, to: string[], comment?: string): Promise<void>;
}

// ── Outlook Calendar ────────────────────────────────────────────────

/** One event on the agenda. Times are UTC instants. */
export type CalendarEventInfo = {
  id: string;
  subject: string;
  start?: Date;
  end?: Date;
  location?: string;
  isAllDay: boolean;
  isCancelled: boolean;
  organizer?: MailAddress;
  attendees: { address: string; name?: string; response?: string }[];
  /** Teams meeting link, when the event has one. */
  joinUrl?: string;
  webLink?: string;
};

/** One busy/tentative/out-of-office span from an availability lookup. */
export type BusySpan = { status: string; start?: Date; end?: Date };

export interface OutlookCalendarSession {
  /** The user's agenda between two instants (recurring events expanded), in
   *  start order. Keep the window modest (days, not years). */
  agenda(from: Date, to: Date): Promise<CalendarEventInfo[]>;

  /** Busy/free spans for a set of people (SMTP addresses) in a time window.
   *  The result maps each requested address to its busy spans; a person whose
   *  calendar is not visible to this user yields an empty list. */
  availability(addresses: string[], from: Date, to: Date)
      : Promise<Record<string, BusySpan[]>>;

  /** Create an event on the user's default calendar. Outlook sends invitations
   *  to any attendees when the event is created. Set `onlineMeeting` to attach
   *  a Teams meeting link. Times are UTC instants. Returns the event id. */
  createEvent(event: {
    subject: string; start: Date; end: Date; body?: string; location?: string;
    attendees?: string[]; onlineMeeting?: boolean;
  }): Promise<{ id: string }>;

  /** Update an event the user organizes (only the provided fields change;
   *  `attendees` replaces the whole list). Outlook sends updates to attendees. */
  updateEvent(eventId: string, update: {
    subject?: string; start?: Date; end?: Date; body?: string; location?: string;
    attendees?: string[];
  }): Promise<void>;

  /** Cancel (delete) an event. For events the user organizes, Outlook sends
   *  cancellations to attendees. */
  cancelEvent(eventId: string): Promise<void>;

  /** Respond to a meeting invitation. The organizer is notified. */
  respondToEvent(eventId: string, response: "accept" | "decline" | "tentativelyAccept",
                 comment?: string): Promise<void>;
}

// ── OneDrive / SharePoint files ─────────────────────────────────────

/** A file or folder in a drive. */
export type FileEntry = {
  id: string;
  name: string;
  kind: "file" | "folder";
  size?: number;
  mimeType?: string;
  /** For folders: how many children it has. */
  childCount?: number;
  modified?: Date;
  modifiedBy?: string;
  /** The drive containing this entry; pass to folder/file methods. */
  driveId?: string;
  /** Link that opens the item in its native web UI. */
  webUrl?: string;
};

/** A SharePoint site visible to the user. */
export type SiteInfo = { id: string; name: string; webUrl?: string };

export interface MicrosoftFilesSession {
  /** List the children of a folder in the user's OneDrive ("root" for the top
   *  level), folders first is NOT guaranteed — check `kind`. */
  listOneDrive(folderId: string): Promise<FileEntry[]>;

  /** Search the user's OneDrive by file name and content. */
  searchOneDrive(query: string): Promise<FileEntry[]>;

  /** Search SharePoint sites by name ("" lists commonly used sites). */
  searchSites(query: string): Promise<SiteInfo[]>;

  /** The document libraries of a SharePoint site. */
  listSiteDrives(siteId: string): Promise<{ id: string; name: string }[]>;

  /** List the children of a folder in a specific drive (from listSiteDrives or
   *  an entry's driveId); "root" for the top level. */
  listDrive(driveId: string, folderId: string): Promise<FileEntry[]>;

  /** Search a specific drive by file name and content. */
  searchDrive(driveId: string, query: string): Promise<FileEntry[]>;

  /** One item's metadata. `driveId` from the entry; pass null for OneDrive. */
  getFile(driveId: string | null, itemId: string): Promise<FileEntry>;

  /** Download a text file's content (txt, md, csv, json, source). Refuses
   *  files over 512 KB and garbles binary formats — check mimeType first and
   *  use webUrl for Office documents. */
  readTextContent(driveId: string | null, itemId: string): Promise<string>;

  /** Download any file's raw content as base64 (up to 3 MB). */
  readContent(driveId: string | null, itemId: string)
      : Promise<{ name: string; base64: string }>;

  /** Files and folders other people have shared with the user. */
  listSharedWithMe(): Promise<FileEntry[]>;

  /** Create a folder inside a parent folder ("root" for the top level).
   *  Fails if a sibling with the same name exists. */
  createFolder(driveId: string | null, parentFolderId: string, name: string)
      : Promise<FileEntry>;

  /** Create a new text file inside a folder ("root" for the top level).
   *  Fails if a file with the same name exists — use replaceFileContent to
   *  overwrite. Content is UTF-8 text, up to 4 MB. */
  uploadFile(driveId: string | null, parentFolderId: string, name: string,
             content: string, contentType?: string): Promise<FileEntry>;

  /** Replace an existing file's content with UTF-8 text, up to 4 MB. */
  replaceFileContent(driveId: string | null, itemId: string, content: string,
                     contentType?: string): Promise<FileEntry>;

  /** Delete a file or folder (it moves to the drive's recycle bin). */
  deleteFile(driveId: string | null, itemId: string): Promise<void>;
}

// ── Microsoft Teams ─────────────────────────────────────────────────

/** One chat the user participates in. */
export type TeamsChatInfo = {
  id: string;
  /** Group chats have topics; 1:1 chats have "". */
  topic: string;
  chatType: string;
  lastUpdated?: Date;
};

/** One team the user is a member of. */
export type TeamInfo = { id: string; name: string; description?: string };

/** One channel of a team. */
export type ChannelInfo = { id: string; name: string; description?: string };

/** One message in a chat or channel. `content` may be HTML (see contentType). */
export type TeamsMessageInfo = {
  id: string;
  from: string;
  created?: Date;
  contentType: string;
  content: string;
};

export interface TeamsSession {
  /** The user's chats, most recently active first. Returns a cursor that
   *  lazily fetches pages as consumed. */
  listChats(): Promise<Cursor<TeamsChatInfo>>;

  /** Teams the user is a member of. */
  listTeams(): Promise<TeamInfo[]>;

  /** The channels of a team. */
  listChannels(teamId: string): Promise<ChannelInfo[]>;

  /** Messages in a chat, newest first. Returns a cursor that lazily fetches
   *  pages as consumed (keep consuming to go further back in history). */
  readChat(chatId: string): Promise<Cursor<TeamsMessageInfo>>;

  /** Messages in a team channel, newest first. Returns a cursor that lazily
   *  fetches pages as consumed. */
  readChannel(teamId: string, channelId: string): Promise<Cursor<TeamsMessageInfo>>;

  /** Start a chat with other people (by email address). One other person makes
   *  a 1:1 chat (returns the existing chat if you already have one); more make
   *  a group chat with the given topic. Returns the chat id to post to. */
  createChat(memberAddresses: string[], topic?: string): Promise<{ id: string }>;

  /** Post a plain-text message to a chat. Returns the message id. */
  postToChat(chatId: string, text: string): Promise<{ id: string }>;

  /** Post a plain-text message to a team channel. Returns the message id. */
  postToChannel(teamId: string, channelId: string, text: string)
      : Promise<{ id: string }>;
}
