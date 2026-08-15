// The Microsoft gatekeeper's resource catalog: four whole-capability resource types, each
// independently grantable so connecting an account requests only the delegated scopes for the
// capabilities the user enables (incremental consent).

import { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

export const MAILBOX_RESOURCE: SupportedResource = {
  urlPattern: "https://outlook.office.com/mail/*",
  title: "Outlook Mailbox",
  description:
      "Read and search the connected mailbox, and create drafts for the user to review and send.",
  grantable: true,
};

export const CALENDAR_RESOURCE: SupportedResource = {
  urlPattern: "https://outlook.office.com/calendar/*",
  title: "Outlook Calendar",
  description:
      "Read the agenda, check people's availability, and create events on the user's calendar.",
  grantable: true,
};

export const FILES_RESOURCE: SupportedResource = {
  urlPattern: "https://onedrive.office.com/*",
  title: "OneDrive & SharePoint Files",
  description:
      "Browse and search OneDrive and SharePoint document libraries and read text file content.",
  grantable: true,
};

export const TEAMS_RESOURCE: SupportedResource = {
  urlPattern: "https://teams.microsoft.com/*",
  title: "Microsoft Teams",
  description:
      "Read chats and channels the user participates in, and post messages on their behalf.",
  grantable: true,
};

export const SUPPORTED_RESOURCES: SupportedResource[] = [
  MAILBOX_RESOURCE, CALENDAR_RESOURCE, FILES_RESOURCE, TEAMS_RESOURCE,
];

/** The delegated Graph scopes each resource type needs. */
const RESOURCE_SCOPES: Record<string, string[]> = {
  [MAILBOX_RESOURCE.urlPattern]: ["Mail.ReadWrite"],
  [CALENDAR_RESOURCE.urlPattern]: ["Calendars.ReadWrite", "Calendars.Read.Shared"],
  [FILES_RESOURCE.urlPattern]: ["Files.Read.All", "Sites.Read.All"],
  [TEAMS_RESOURCE.urlPattern]: [
    "Chat.ReadWrite", "Team.ReadBasic.All", "Channel.ReadBasic.All",
    "ChannelMessage.Read.All", "ChannelMessage.Send",
  ],
};

/**
 * The union of delegated scopes needed for a set of resource urlPatterns. An omitted/empty list
 * means "all resource types" (the connect flow's default).
 */
export function scopesForResources(resourceUrlPatterns?: readonly string[]): string[] {
  const patterns = resourceUrlPatterns?.length
      ? resourceUrlPatterns
      : SUPPORTED_RESOURCES.map(resource => resource.urlPattern);
  const scopes = new Set<string>();
  for (const pattern of patterns) {
    for (const scope of RESOURCE_SCOPES[pattern] ?? []) scopes.add(scope);
  }
  return [...scopes];
}

/** Match a concrete resource URL to its resource type, or null. */
export function resourceForUrl(url: string): SupportedResource | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname === "outlook.office.com") {
    if (parsed.pathname.startsWith("/mail")) return MAILBOX_RESOURCE;
    if (parsed.pathname.startsWith("/calendar")) return CALENDAR_RESOURCE;
    return null;
  }
  if (parsed.hostname === "onedrive.office.com") return FILES_RESOURCE;
  if (parsed.hostname === "teams.microsoft.com") return TEAMS_RESOURCE;
  return null;
}
