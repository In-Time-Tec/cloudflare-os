import { Effect, Schema } from "effect";
import { GraphError } from "./errors.js";
import { GraphTransport, PageCursor, validateNextLink } from "./transport.js";

// OneDrive / SharePoint file operations: browse, search, metadata, and text-content download for
// reasonably-sized files. Uploads and edits are out of scope for this module version.

// ── Private DTOs ─────────────────────────────────────────────────────────────

const DriveItemDto = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  eTag: Schema.optional(Schema.String),
  lastModifiedDateTime: Schema.optional(Schema.String),
  webUrl: Schema.optional(Schema.String),
  folder: Schema.optional(Schema.NullOr(Schema.Struct({
    childCount: Schema.optional(Schema.Number),
  }))),
  file: Schema.optional(Schema.NullOr(Schema.Struct({
    mimeType: Schema.optional(Schema.NullOr(Schema.String)),
  }))),
  parentReference: Schema.optional(Schema.Struct({
    driveId: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
  })),
  lastModifiedBy: Schema.optional(Schema.Struct({
    user: Schema.optional(Schema.NullOr(Schema.Struct({
      displayName: Schema.optional(Schema.String),
    }))),
  })),
});

const DriveItemPageDto = Schema.Struct({
  value: Schema.Array(DriveItemDto),
  "@odata.nextLink": Schema.optional(Schema.String),
});

const SiteDto = Schema.Struct({
  id: Schema.String,
  displayName: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  webUrl: Schema.optional(Schema.String),
});

const SitePageDto = Schema.Struct({
  value: Schema.Array(SiteDto),
  "@odata.nextLink": Schema.optional(Schema.String),
});

// ── Public contracts ─────────────────────────────────────────────────────────

/** A file or folder in a drive. */
export interface DriveEntry {
  id: string;
  name: string;
  kind: "file" | "folder";
  size?: number;
  etag?: string;
  mimeType?: string;
  childCount?: number;
  modified?: Date;
  modifiedBy?: string;
  /** The containing drive, for addressing this entry later. */
  driveId?: string;
  webUrl?: string;
}

/** One page of drive entries plus the continuation, if more exist. */
export interface DrivePage {
  entries: DriveEntry[];
  next?: PageCursor;
}

/** A SharePoint site reachable by the signed-in user. */
export interface SiteInfo {
  id: string;
  name: string;
  webUrl?: string;
}

function toEntry(dto: typeof DriveItemDto.Type): DriveEntry {
  return {
    id: dto.id,
    name: dto.name ?? "",
    kind: dto.folder ? "folder" : "file",
    size: dto.size,
    etag: dto.eTag,
    mimeType: dto.file?.mimeType ?? undefined,
    childCount: dto.folder?.childCount,
    modified: dto.lastModifiedDateTime ? new Date(dto.lastModifiedDateTime) : undefined,
    modifiedBy: dto.lastModifiedBy?.user?.displayName,
    driveId: dto.parentReference?.driveId,
    webUrl: dto.webUrl,
  };
}

function toDrivePage(dto: typeof DriveItemPageDto.Type): DrivePage {
  const nextLink = dto["@odata.nextLink"];
  return {
    entries: dto.value.map(toEntry),
    next: nextLink ? validateNextLink(nextLink) ?? undefined : undefined,
  };
}

const ITEM_SELECT = ["id", "name", "size", "eTag", "lastModifiedDateTime", "webUrl", "folder",
  "file", "parentReference", "lastModifiedBy"] as const;

/**
 * Address one drive: the signed-in user's OneDrive ("me"), or a specific drive by id (e.g. a
 * SharePoint document library discovered via listSiteDrives).
 */
export type DriveRef = { kind: "me" } | { kind: "drive"; driveId: string };

function driveSegments(ref: DriveRef): string[] {
  return ref.kind === "me" ? ["me", "drive"] : ["drives", ref.driveId];
}

/** List the children of a folder ("root" for the drive root). */
export function listChildren(transport: GraphTransport, ref: DriveRef, folderId: string,
                             options?: { top?: number })
    : Effect.Effect<DrivePage, GraphError> {
  const folder = folderId === "root" ? "root" : folderId;
  return Effect.map(
      transport.get([...driveSegments(ref), "items", folder, "children"], DriveItemPageDto, {
        query: { select: ITEM_SELECT, top: options?.top ?? 50, orderby: "name" },
      }),
      toDrivePage);
}

/** Search a drive by name/content. */
export function searchDrive(transport: GraphTransport, ref: DriveRef, query: string,
                            options?: { top?: number })
    : Effect.Effect<DrivePage, GraphError> {
  // The search term is a path segment in Graph's API shape: /drive/root/search(q='term').
  // encodeURIComponent in buildUrl keeps embedded quotes inert.
  const q = query.replaceAll("'", "''");
  return Effect.map(
      transport.get([...driveSegments(ref), "root", `search(q='${q}')`], DriveItemPageDto, {
        query: { select: ITEM_SELECT, top: options?.top ?? 50 },
      }),
      toDrivePage);
}

/** Fetch the continuation of a previous listing/search. */
export function nextDrivePage(transport: GraphTransport, cursor: PageCursor)
    : Effect.Effect<DrivePage, GraphError> {
  return Effect.map(transport.getPage(cursor, DriveItemPageDto), toDrivePage);
}

/** Fetch one item's metadata. */
export function getItem(transport: GraphTransport, ref: DriveRef, itemId: string)
    : Effect.Effect<DriveEntry, GraphError> {
  return Effect.map(
      transport.get([...driveSegments(ref), "items", itemId], DriveItemDto, {
        query: { select: ITEM_SELECT },
      }),
      toEntry);
}

/** SharePoint sites matching a search term (or all followed/visible sites for ""). */
export function searchSites(transport: GraphTransport, query: string)
    : Effect.Effect<SiteInfo[], GraphError> {
  return Effect.map(
      transport.get(["sites"], SitePageDto, {
        query: { search: query || "*" },
      }),
      dto => dto.value.map(site => ({
        id: site.id,
        name: site.displayName || site.name || "",
        webUrl: site.webUrl,
      })));
}

/** The document libraries (drives) of a SharePoint site. */
export function listSiteDrives(transport: GraphTransport, siteId: string)
    : Effect.Effect<{ id: string; name: string }[], GraphError> {
  const DrivesDto = Schema.Struct({
    value: Schema.Array(Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
    })),
  });
  return Effect.map(
      transport.get(["sites", siteId, "drives"], DrivesDto),
      dto => dto.value.map(d => ({ id: d.id, name: d.name ?? "" })));
}

/** Cap for text-content downloads: keeps agent-bound file reads bounded. */
export const MAX_TEXT_CONTENT_BYTES = 512 * 1024;

/**
 * Download a file's content as text. Intended for text-y formats (txt, md, csv, json, source);
 * refuses content larger than MAX_TEXT_CONTENT_BYTES. Binary formats come back garbled — callers
 * should check `mimeType` first and prefer webUrl for Office formats.
 */
export function downloadTextContent(transport: GraphTransport, ref: DriveRef, itemId: string)
    : Effect.Effect<string, GraphError> {
  return transport.getText([...driveSegments(ref), "items", itemId, "content"],
      MAX_TEXT_CONTENT_BYTES);
}
