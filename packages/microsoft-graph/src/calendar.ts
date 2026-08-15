import { Effect, Schema } from "effect";
import { GraphError } from "./errors.js";
import { GraphTransport, PageCursor, validateNextLink } from "./transport.js";

// Calendar operations: agenda (calendarView), free/busy availability, and event creation.

// ── Private DTOs ─────────────────────────────────────────────────────────────

const DateTimeZoneDto = Schema.Struct({
  dateTime: Schema.String,
  timeZone: Schema.optional(Schema.String),
});

const EventDto = Schema.Struct({
  id: Schema.String,
  subject: Schema.optional(Schema.NullOr(Schema.String)),
  start: Schema.optional(DateTimeZoneDto),
  end: Schema.optional(DateTimeZoneDto),
  location: Schema.optional(Schema.NullOr(Schema.Struct({
    displayName: Schema.optional(Schema.String),
  }))),
  isAllDay: Schema.optional(Schema.Boolean),
  isCancelled: Schema.optional(Schema.Boolean),
  organizer: Schema.optional(Schema.NullOr(Schema.Struct({
    emailAddress: Schema.Struct({
      address: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    }),
  }))),
  attendees: Schema.optional(Schema.Array(Schema.Struct({
    emailAddress: Schema.Struct({
      address: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    }),
    status: Schema.optional(Schema.Struct({ response: Schema.optional(Schema.String) })),
  }))),
  onlineMeeting: Schema.optional(Schema.NullOr(Schema.Struct({
    joinUrl: Schema.optional(Schema.NullOr(Schema.String)),
  }))),
  webLink: Schema.optional(Schema.String),
});

const EventPageDto = Schema.Struct({
  value: Schema.Array(EventDto),
  "@odata.nextLink": Schema.optional(Schema.String),
});

const ScheduleResponseDto = Schema.Struct({
  value: Schema.Array(Schema.Struct({
    scheduleId: Schema.String,
    scheduleItems: Schema.optional(Schema.Array(Schema.Struct({
      status: Schema.optional(Schema.String),
      start: Schema.optional(DateTimeZoneDto),
      end: Schema.optional(DateTimeZoneDto),
    }))),
  })),
});

const EventCreatedDto = Schema.Struct({
  id: Schema.String,
  webLink: Schema.optional(Schema.String),
});

// ── Public contracts ─────────────────────────────────────────────────────────

/** One calendar event as it appears on the agenda. */
export interface EventSummary {
  id: string;
  subject: string;
  /** UTC instants; Graph is asked to render the view in UTC. */
  start?: Date;
  end?: Date;
  location?: string;
  isAllDay: boolean;
  isCancelled: boolean;
  organizer?: { address: string; name?: string };
  attendees: { address: string; name?: string; response?: string }[];
  joinUrl?: string;
  webLink?: string;
}

/** One page of agenda events plus the continuation, if more exist. */
export interface EventPage {
  events: EventSummary[];
  next?: PageCursor;
}

/** One busy/oof/tentative span from an availability lookup. */
export interface BusySpan {
  status: string;
  start?: Date;
  end?: Date;
}

function parseZoned(dto: typeof DateTimeZoneDto.Type | undefined): Date | undefined {
  if (!dto) return undefined;
  // With Prefer: outlook.timezone="UTC" Graph renders times in UTC without a zone suffix.
  const raw = dto.dateTime.endsWith("Z") || dto.dateTime.includes("+")
      ? dto.dateTime : dto.dateTime + "Z";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
}

function toEvent(dto: typeof EventDto.Type): EventSummary {
  const organizerAddress = dto.organizer?.emailAddress.address;
  return {
    id: dto.id,
    subject: dto.subject ?? "",
    start: parseZoned(dto.start),
    end: parseZoned(dto.end),
    location: dto.location?.displayName || undefined,
    isAllDay: dto.isAllDay ?? false,
    isCancelled: dto.isCancelled ?? false,
    organizer: organizerAddress
        ? { address: organizerAddress, name: dto.organizer?.emailAddress.name || undefined }
        : undefined,
    attendees: (dto.attendees ?? []).flatMap(a => a.emailAddress.address
        ? [{ address: a.emailAddress.address, name: a.emailAddress.name || undefined,
             response: a.status?.response }]
        : []),
    joinUrl: dto.onlineMeeting?.joinUrl ?? undefined,
    webLink: dto.webLink,
  };
}

function toEventPage(dto: typeof EventPageDto.Type): EventPage {
  const nextLink = dto["@odata.nextLink"];
  return {
    events: dto.value.map(toEvent),
    next: nextLink ? validateNextLink(nextLink) ?? undefined : undefined,
  };
}

const EVENT_SELECT = ["id", "subject", "start", "end", "location", "isAllDay", "isCancelled",
  "organizer", "attendees", "onlineMeeting", "webLink"] as const;

/**
 * The signed-in user's agenda between two instants (expanded occurrences of recurring events),
 * in start order.
 */
export function listAgenda(transport: GraphTransport, from: Date, to: Date,
                           options?: { top?: number })
    : Effect.Effect<EventPage, GraphError> {
  return Effect.map(
      transport.get(["me", "calendarView"], EventPageDto, {
        query: {
          select: EVENT_SELECT,
          top: options?.top ?? 50,
          orderby: "start/dateTime",
          window: { start: from.toISOString(), end: to.toISOString() },
        },
      }),
      toEventPage);
}

/** Fetch the continuation of a previous agenda listing. */
export function nextEventPage(transport: GraphTransport, cursor: PageCursor)
    : Effect.Effect<EventPage, GraphError> {
  return Effect.map(transport.getPage(cursor, EventPageDto), toEventPage);
}

/**
 * Busy/tentative/out-of-office spans for a set of users (getSchedule). `addresses` are SMTP
 * addresses visible to the signed-in user; each entry in the result matches one address.
 */
export function getAvailability(transport: GraphTransport, addresses: string[],
                                from: Date, to: Date)
    : Effect.Effect<Map<string, BusySpan[]>, GraphError> {
  return Effect.map(
      transport.post(["me", "calendar", "getSchedule"], {
        schedules: addresses,
        startTime: { dateTime: from.toISOString(), timeZone: "UTC" },
        endTime: { dateTime: to.toISOString(), timeZone: "UTC" },
        availabilityViewInterval: 30,
      }, ScheduleResponseDto),
      dto => new Map(dto.value.map(entry => [
        entry.scheduleId,
        (entry.scheduleItems ?? []).map(item => ({
          status: item.status ?? "busy",
          start: parseZoned(item.start),
          end: parseZoned(item.end),
        })),
      ])));
}

/** What a new event contains. Times are UTC instants. */
export interface EventInput {
  subject: string;
  start: Date;
  end: Date;
  body?: string;
  location?: string;
  attendees?: string[];
  /** Request a Teams meeting link on the event. */
  onlineMeeting?: boolean;
}

/** Create an event on the signed-in user's default calendar. Invitations are sent by Outlook. */
export function createEvent(transport: GraphTransport, event: EventInput)
    : Effect.Effect<{ id: string; webLink?: string }, GraphError> {
  return transport.post(["me", "events"], {
    subject: event.subject,
    start: { dateTime: event.start.toISOString(), timeZone: "UTC" },
    end: { dateTime: event.end.toISOString(), timeZone: "UTC" },
    ...(event.body ? { body: { contentType: "Text", content: event.body } } : {}),
    ...(event.location ? { location: { displayName: event.location } } : {}),
    ...(event.attendees?.length ? {
      attendees: event.attendees.map(address => ({
        emailAddress: { address }, type: "required",
      })),
    } : {}),
    ...(event.onlineMeeting ? {
      isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness",
    } : {}),
  }, EventCreatedDto);
}

/** Delete (cancel) an event the user organizes, or decline it otherwise. */
export function deleteEvent(transport: GraphTransport, eventId: string)
    : Effect.Effect<void, GraphError> {
  return transport.del(["me", "events", eventId]);
}

/** Fields of an event that can be updated. Times are UTC instants. */
export interface EventUpdate {
  subject?: string;
  start?: Date;
  end?: Date;
  body?: string;
  location?: string;
  /** Full replacement attendee list, when present. */
  attendees?: string[];
}

/** Update an event the user organizes. Outlook sends updated invitations to attendees. */
export function updateEvent(transport: GraphTransport, eventId: string, update: EventUpdate)
    : Effect.Effect<{ id: string }, GraphError> {
  const UpdatedDto = Schema.Struct({ id: Schema.String });
  return transport.patch(["me", "events", eventId], {
    ...(update.subject !== undefined ? { subject: update.subject } : {}),
    ...(update.start ? { start: { dateTime: update.start.toISOString(), timeZone: "UTC" } } : {}),
    ...(update.end ? { end: { dateTime: update.end.toISOString(), timeZone: "UTC" } } : {}),
    ...(update.body !== undefined
        ? { body: { contentType: "Text", content: update.body } } : {}),
    ...(update.location !== undefined
        ? { location: { displayName: update.location } } : {}),
    ...(update.attendees ? {
      attendees: update.attendees.map(address => ({
        emailAddress: { address }, type: "required",
      })),
    } : {}),
  }, UpdatedDto);
}

/** How to respond to a meeting invitation. */
export type EventResponse = "accept" | "decline" | "tentativelyAccept";

/**
 * Respond to a meeting invitation on the user's calendar. `sendResponse` controls whether the
 * organizer is notified (Graph's default is true).
 */
export function respondToEvent(transport: GraphTransport, eventId: string,
                               response: EventResponse, comment?: string)
    : Effect.Effect<void, GraphError> {
  return transport.postVoid(["me", "events", eventId, response], {
    sendResponse: true,
    ...(comment ? { comment } : {}),
  });
}
