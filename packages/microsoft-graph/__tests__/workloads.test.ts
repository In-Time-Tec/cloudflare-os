import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { makeTransport } from "../src/transport.js";
import * as mail from "../src/mail.js";
import * as calendar from "../src/calendar.js";
import * as files from "../src/files.js";
import * as teams from "../src/teams.js";
import * as profile from "../src/profile.js";

const TOKEN = async () => "t";

/** A transport whose fetch replays canned responses and records every request URL. */
function canned(responses: Record<string, unknown>) {
  const requests: { url: string; method: string; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const parsed = new URL(url);
    const key = Object.keys(responses).find(k => parsed.pathname === `/v1.0/${k}`);
    if (!key) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(responses[key]), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return { transport: makeTransport(TOKEN, fetchMock as unknown as typeof fetch), requests };
}

describe("mail", () => {
  const MESSAGE = {
    id: "m1",
    subject: "Quarterly report",
    from: { emailAddress: { address: "bob@corp.example", name: "Bob" } },
    toRecipients: [{ emailAddress: { address: "me@corp.example" } }],
    receivedDateTime: "2026-08-14T12:00:00Z",
    bodyPreview: "Here it is",
    isRead: false,
    hasAttachments: true,
    webLink: "https://outlook.office.com/x",
  };

  it("lists the inbox into summaries and validates the continuation", async () => {
    const { transport, requests } = canned({
      "me/mailFolders/inbox/messages": {
        value: [MESSAGE],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skip=25",
      },
    });
    const page = await Effect.runPromise(mail.listInbox(transport));
    expect(page.messages).toEqual([{
      id: "m1", subject: "Quarterly report",
      from: { address: "bob@corp.example", name: "Bob" },
      to: [{ address: "me@corp.example" }],
      received: new Date("2026-08-14T12:00:00Z"),
      preview: "Here it is", isRead: false, hasAttachments: true,
      webLink: "https://outlook.office.com/x",
    }]);
    expect(page.next).toBeDefined();
    const url = new URL(requests[0].url);
    expect(url.searchParams.get("$orderby")).toBe("receivedDateTime desc");
  });

  it("drops a foreign-host continuation instead of following it", async () => {
    const { transport } = canned({
      "me/mailFolders/inbox/messages": {
        value: [],
        "@odata.nextLink": "https://evil.example.com/v1.0/steal",
      },
    });
    const page = await Effect.runPromise(mail.listInbox(transport));
    expect(page.next).toBeUndefined();
  });

  it("reads one message with its body", async () => {
    const { transport } = canned({
      "me/messages/m1": {
        ...MESSAGE,
        body: { contentType: "html", content: "<p>Hi</p>" },
      },
    });
    const detail = await Effect.runPromise(mail.getMessage(transport, "m1"));
    expect(detail.bodyHtml).toBe("<p>Hi</p>");
    expect(detail.bodyText).toBeUndefined();
  });

  it("creates a draft with the right POST body", async () => {
    const { transport, requests } = canned({ "me/messages": { id: "d1" } });
    const created = await Effect.runPromise(mail.createDraft(transport, {
      to: ["a@x.example"], cc: ["b@x.example"], subject: "S", body: "B",
    }));
    expect(created.id).toBe("d1");
    expect(requests[0].method).toBe("POST");
    expect(requests[0].body).toEqual({
      subject: "S",
      body: { contentType: "Text", content: "B" },
      toRecipients: [{ emailAddress: { address: "a@x.example" } }],
      ccRecipients: [{ emailAddress: { address: "b@x.example" } }],
    });
  });
});

describe("calendar", () => {
  it("lists the agenda window and parses zoneless UTC datetimes", async () => {
    const { transport, requests } = canned({
      "me/calendarView": {
        value: [{
          id: "e1", subject: "Standup",
          start: { dateTime: "2026-08-15T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-08-15T09:15:00.0000000", timeZone: "UTC" },
          attendees: [{ emailAddress: { address: "bob@corp.example" },
                        status: { response: "accepted" } }],
          onlineMeeting: { joinUrl: "https://teams.microsoft.com/j/1" },
        }],
      },
    });
    const page = await Effect.runPromise(calendar.listAgenda(transport,
        new Date("2026-08-15T00:00:00Z"), new Date("2026-08-16T00:00:00Z")));
    expect(page.events[0].start).toEqual(new Date("2026-08-15T09:00:00Z"));
    expect(page.events[0].joinUrl).toBe("https://teams.microsoft.com/j/1");
    expect(page.events[0].attendees[0].response).toBe("accepted");
    const url = new URL(requests[0].url);
    expect(url.searchParams.get("startDateTime")).toBe("2026-08-15T00:00:00.000Z");
  });

  it("maps availability by address", async () => {
    const { transport } = canned({
      "me/calendar/getSchedule": {
        value: [{
          scheduleId: "bob@corp.example",
          scheduleItems: [{
            status: "busy",
            start: { dateTime: "2026-08-15T10:00:00" },
            end: { dateTime: "2026-08-15T11:00:00" },
          }],
        }],
      },
    });
    const map = await Effect.runPromise(calendar.getAvailability(transport,
        ["bob@corp.example"], new Date(), new Date()));
    expect(map.get("bob@corp.example")).toEqual([{
      status: "busy",
      start: new Date("2026-08-15T10:00:00Z"),
      end: new Date("2026-08-15T11:00:00Z"),
    }]);
  });

  it("creates an event with attendees and a Teams link", async () => {
    const { transport, requests } = canned({ "me/events": { id: "e9" } });
    await Effect.runPromise(calendar.createEvent(transport, {
      subject: "Review", start: new Date("2026-08-20T15:00:00Z"),
      end: new Date("2026-08-20T16:00:00Z"), attendees: ["bob@corp.example"],
      onlineMeeting: true,
    }));
    expect(requests[0].body).toMatchObject({
      subject: "Review",
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
      attendees: [{ emailAddress: { address: "bob@corp.example" }, type: "required" }],
    });
  });
});

describe("files", () => {
  it("lists folder children with kinds", async () => {
    const { transport } = canned({
      "me/drive/items/root/children": {
        value: [
          { id: "f1", name: "Docs", folder: { childCount: 3 },
            parentReference: { driveId: "d1" } },
          { id: "f2", name: "notes.md", size: 120, eTag: 'W/"1"',
            file: { mimeType: "text/markdown" },
            lastModifiedDateTime: "2026-08-01T00:00:00Z",
            lastModifiedBy: { user: { displayName: "Bob" } } },
        ],
      },
    });
    const page = await Effect.runPromise(files.listChildren(transport, { kind: "me" }, "root"));
    expect(page.entries.map(e => [e.name, e.kind])).toEqual([
      ["Docs", "folder"], ["notes.md", "file"],
    ]);
    expect(page.entries[1].etag).toBe('W/"1"');
    expect(page.entries[1].modifiedBy).toBe("Bob");
  });

  it("escapes quotes in drive search terms", async () => {
    const { transport, requests } = canned({});
    await Effect.runPromise(Effect.flip(
        files.searchDrive(transport, { kind: "me" }, "term'); DELETE")));
    // The whole search() segment arrives URL-encoded — single quotes doubled, parens encoded.
    expect(decodeURIComponent(new URL(requests[0].url).pathname))
        .toContain("search(q='term''); DELETE')");
  });

  it("lists SharePoint sites and drives", async () => {
    const { transport } = canned({
      "sites": { value: [{ id: "s1", displayName: "Intranet", webUrl: "https://sp/x" }] },
      "sites/s1/drives": { value: [{ id: "d9", name: "Documents" }] },
    });
    expect(await Effect.runPromise(files.searchSites(transport, "intranet")))
        .toEqual([{ id: "s1", name: "Intranet", webUrl: "https://sp/x" }]);
    expect(await Effect.runPromise(files.listSiteDrives(transport, "s1")))
        .toEqual([{ id: "d9", name: "Documents" }]);
  });
});

describe("teams", () => {
  it("lists chats, teams, and channels", async () => {
    const { transport } = canned({
      "me/chats": { value: [{ id: "c1", topic: "Project X", chatType: "group",
                              lastUpdatedDateTime: "2026-08-10T00:00:00Z" }] },
      "me/joinedTeams": { value: [{ id: "t1", displayName: "Engineering" }] },
      "teams/t1/channels": { value: [{ id: "ch1", displayName: "General" }] },
    });
    const { chats } = await Effect.runPromise(teams.listChats(transport));
    expect(chats[0]).toMatchObject({ id: "c1", topic: "Project X", chatType: "group" });
    expect(await Effect.runPromise(teams.listJoinedTeams(transport)))
        .toEqual([{ id: "t1", name: "Engineering", description: undefined }]);
    expect(await Effect.runPromise(teams.listChannels(transport, "t1")))
        .toEqual([{ id: "ch1", name: "General", description: undefined }]);
  });

  it("reads conversation messages and filters system events", async () => {
    const { transport } = canned({
      "me/chats/c1/messages": {
        value: [
          { id: "m1", messageType: "message",
            from: { user: { displayName: "Bob" } },
            body: { contentType: "text", content: "hello" } },
          { id: "m2", messageType: "systemEventMessage",
            body: { contentType: "html", content: "<systemEventMessage/>" } },
        ],
      },
    });
    const page = await Effect.runPromise(teams.listMessages(transport,
        { kind: "chat", chatId: "c1" }));
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ from: "Bob", content: "hello" });
  });

  it("posts a message to a channel", async () => {
    const { transport, requests } = canned({
      "teams/t1/channels/ch1/messages": { id: "sent1" },
    });
    const sent = await Effect.runPromise(teams.sendMessage(transport,
        { kind: "channel", teamId: "t1", channelId: "ch1" }, "ship it"));
    expect(sent.id).toBe("sent1");
    expect(requests[0].body).toEqual({ body: { contentType: "text", content: "ship it" } });
  });
});

describe("profile", () => {
  it("maps the directory profile and falls back to the UPN for email", async () => {
    const { transport } = canned({
      "me": { id: "oid-1", displayName: "Me", mail: null,
              userPrincipalName: "me@corp.example" },
    });
    expect(await Effect.runPromise(profile.getProfile(transport))).toEqual({
      id: "oid-1", displayName: "Me", email: "me@corp.example", jobTitle: undefined,
    });
  });
});
