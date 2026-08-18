import type { Capability, CapabilityGroup } from "@gadgets/workshop-shared/gatekeeper";
import {
  MAILBOX_RESOURCE, CALENDAR_RESOURCE, FILES_RESOURCE, TEAMS_RESOURCE,
} from "./resources.js";

/**
 * What a user can grant or withhold on a Microsoft account, one operation at a time.
 *
 * Reads and writes are both listed because both are grantable, but they are enforced differently:
 * a write is refused before it reaches Graph, while a read is refused after the gatekeeper fetched
 * it, so withholding a read stops the data reaching the agent rather than stopping the request.
 * The grant that genuinely prevents a request is the resource grant, which decides the OAuth
 * scopes -- hence `resourceUrlPattern` on each group.
 */
export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    id: "mail",
    label: "Mail",
    summary: "Your Outlook mailbox: read messages and attachments, draft and send mail.",
    resourceUrlPattern: MAILBOX_RESOURCE.urlPattern,
  },
  {
    id: "calendar",
    label: "Calendar",
    summary: "Your Outlook calendar: see events, create and change them, respond to invitations.",
    resourceUrlPattern: CALENDAR_RESOURCE.urlPattern,
  },
  {
    id: "files",
    label: "Files",
    summary: "OneDrive and SharePoint: browse and read files, create and delete them.",
    resourceUrlPattern: FILES_RESOURCE.urlPattern,
  },
  {
    id: "teams",
    label: "Teams",
    summary: "Your Teams chats and channels: read messages, post, and start chats.",
    resourceUrlPattern: TEAMS_RESOURCE.urlPattern,
  },
];

export const CAPABILITIES: Capability[] = [
  // --- Mail ---
  {
    tag: "microsoft.mail.read",
    label: "Read mail",
    summary: "Read messages, folders, and attachments in your mailbox.",
    mode: "read",
    group: "mail",
  },
  {
    tag: "microsoft.mail.draft.create",
    label: "Save drafts",
    summary: "Save drafts in your Drafts folder.",
    mode: "write",
    group: "mail",
    risk: {reversible: "automatic", reach: "creates-content", audience: "private", freeform: true},
  },
  {
    tag: "microsoft.mail.send",
    label: "Send mail",
    summary: "Send mail as you, to anyone.",
    mode: "write",
    group: "mail",
    risk: {reversible: "no", reach: "acts-on-world", audience: "external", freeform: true},
  },

  // --- Calendar ---
  {
    tag: "microsoft.calendar.read",
    label: "Read calendar",
    summary: "See your events, their times, and who is invited.",
    mode: "read",
    group: "calendar",
  },
  {
    tag: "microsoft.calendar.event.create",
    label: "Create events",
    summary: "Put events on your calendar and invite people.",
    mode: "write",
    group: "calendar",
    risk: {reversible: "manual", reach: "creates-content", audience: "external", freeform: true},
  },
  {
    tag: "microsoft.calendar.event.modify",
    label: "Change events",
    summary: "Change or cancel events already on your calendar.",
    mode: "write",
    group: "calendar",
    risk: {reversible: "no", reach: "modifies-content", audience: "external", freeform: true},
  },
  {
    tag: "microsoft.calendar.event.respond",
    label: "Respond to invitations",
    summary: "Accept, decline, or tentatively accept invitations for you.",
    mode: "write",
    group: "calendar",
    risk: {reversible: "manual", reach: "acts-on-world", audience: "external", freeform: false},
  },

  // --- Files ---
  {
    tag: "microsoft.files.read",
    label: "Read files",
    summary: "Browse and read files in OneDrive and SharePoint, including shared ones.",
    mode: "read",
    group: "files",
  },
  {
    tag: "microsoft.files.write",
    label: "Create and edit files",
    summary: "Create files and folders, and overwrite existing files.",
    mode: "write",
    group: "files",
    risk: {reversible: "manual", reach: "modifies-content", audience: "shared", freeform: true},
  },
  {
    tag: "microsoft.files.delete",
    label: "Delete files",
    summary: "Delete files and folders, including ones shared with colleagues.",
    mode: "write",
    group: "files",
    risk: {reversible: "manual", reach: "modifies-content", audience: "shared", freeform: false},
  },

  // --- Teams ---
  {
    tag: "microsoft.teams.read",
    label: "Read messages",
    summary: "Read your chats and the channels of teams you belong to.",
    mode: "read",
    group: "teams",
  },
  {
    tag: "microsoft.teams.message.post",
    label: "Post messages",
    summary: "Post messages as you in your chats and team channels.",
    mode: "write",
    group: "teams",
    risk: {reversible: "no", reach: "acts-on-world", audience: "external", freeform: true},
  },
  {
    tag: "microsoft.teams.chat.create",
    label: "Start chats",
    summary: "Start new chats with colleagues.",
    mode: "write",
    group: "teams",
    risk: {reversible: "manual", reach: "creates-content", audience: "shared", freeform: false},
  },
];
