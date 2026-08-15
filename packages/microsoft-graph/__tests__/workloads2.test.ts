import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { makeTransport } from "../src/transport.js";
import * as mail from "../src/mail.js";
import * as calendar from "../src/calendar.js";
import * as files from "../src/files.js";
import * as teams from "../src/teams.js";

const TOKEN = async () => "t";

/** Canned transport recording method+path+body; 202-empty for send-style endpoints. */
function canned(responses: Record<string, unknown>) {
  const requests: { url: URL; method: string; body?: unknown; contentType?: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const headers = new Headers(init?.headers);
    requests.push({
      url: parsed,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" && headers.get("Content-Type") === "application/json"
          ? JSON.parse(init.body) : init?.body,
      contentType: headers.get("Content-Type") ?? undefined,
    });
    const key = Object.keys(responses).find(k => parsed.pathname === `/v1.0/${k}`);
    if (key === undefined) return new Response("{}", { status: 404 });
    const value = responses[key];
    if (value === null) return new Response(null, { status: 202 });  // fire-and-forget
    return new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return { transport: makeTransport(TOKEN, fetchMock as unknown as typeof fetch), requests };
}

describe("mail sending", () => {
  it("sendMail posts the full message and tolerates the empty 202", async () => {
    const { transport, requests } = canned({ "me/sendMail": null });
    await Effect.runPromise(mail.sendMail(transport, {
      to: ["a@x.example"], cc: ["c@x.example"], bcc: ["b@x.example"],
      subject: "S", body: "B",
    }));
    expect(requests[0].method).toBe("POST");
    expect(requests[0].body).toEqual({
      message: {
        subject: "S",
        body: { contentType: "Text", content: "B" },
        toRecipients: [{ emailAddress: { address: "a@x.example" } }],
        ccRecipients: [{ emailAddress: { address: "c@x.example" } }],
        bccRecipients: [{ emailAddress: { address: "b@x.example" } }],
      },
      saveToSentItems: true,
    });
  });

  it("sendDraft / reply / replyAll / forward hit their endpoints", async () => {
    const { transport, requests } = canned({
      "me/messages/d1/send": null,
      "me/messages/m1/reply": null,
      "me/messages/m1/replyAll": null,
      "me/messages/m1/forward": null,
    });
    await Effect.runPromise(mail.sendDraft(transport, "d1"));
    await Effect.runPromise(mail.replyToMessage(transport, "m1", "ok"));
    await Effect.runPromise(mail.replyAllToMessage(transport, "m1", "ok all"));
    await Effect.runPromise(mail.forwardMessage(transport, "m1", ["f@x.example"], "fyi"));
    expect(requests.map(r => r.url.pathname)).toEqual([
      "/v1.0/me/messages/d1/send",
      "/v1.0/me/messages/m1/reply",
      "/v1.0/me/messages/m1/replyAll",
      "/v1.0/me/messages/m1/forward",
    ]);
    expect(requests[3].body).toEqual({
      toRecipients: [{ emailAddress: { address: "f@x.example" } }], comment: "fyi",
    });
  });
});

describe("mail folders and attachments", () => {
  it("lists folders and a folder's messages", async () => {
    const { transport } = canned({
      "me/mailFolders": { value: [
        { id: "f1", displayName: "Archive", totalItemCount: 5, unreadItemCount: 1,
          childFolderCount: 0 },
      ] },
      "me/mailFolders/f1/messages": { value: [
        { id: "m1", subject: "Old", receivedDateTime: "2026-01-01T00:00:00Z" },
      ] },
    });
    const folders = await Effect.runPromise(mail.listFolders(transport));
    expect(folders).toEqual([{
      id: "f1", name: "Archive", totalCount: 5, unreadCount: 1, hasChildren: false,
    }]);
    const page = await Effect.runPromise(mail.listFolder(transport, "f1"));
    expect(page.messages[0].subject).toBe("Old");
  });

  it("lists attachments and downloads file content, refusing oversized ones", async () => {
    const { transport } = canned({
      "me/messages/m1/attachments": { value: [
        { id: "a1", name: "report.pdf", contentType: "application/pdf", size: 100,
          "@odata.type": "#microsoft.graph.fileAttachment" },
        { id: "a2", name: "meeting", "@odata.type": "#microsoft.graph.itemAttachment" },
      ] },
      "me/messages/m1/attachments/a1": {
        id: "a1", name: "report.pdf", contentType: "application/pdf", size: 100,
        contentBytes: "QUJD",
      },
      "me/messages/m1/attachments/big": {
        id: "big", name: "huge.bin", size: 99_000_000, contentBytes: "x",
      },
    });
    const list = await Effect.runPromise(mail.listAttachments(transport, "m1"));
    expect(list.map(a => [a.name, a.isFile])).toEqual([["report.pdf", true], ["meeting", false]]);

    const content = await Effect.runPromise(
        mail.getAttachmentContent(transport, "m1", "a1"));
    expect(content).toEqual({ name: "report.pdf", contentType: "application/pdf", base64: "QUJD" });

    const failure = await Effect.runPromise(Effect.flip(
        mail.getAttachmentContent(transport, "m1", "big")));
    expect(failure._tag).toBe("GraphDecodeError");
  });
});

describe("calendar updates and responses", () => {
  it("PATCHes only the provided fields", async () => {
    const { transport, requests } = canned({ "me/events/e1": { id: "e1" } });
    await Effect.runPromise(calendar.updateEvent(transport, "e1", {
      subject: "Moved", start: new Date("2026-09-01T10:00:00Z"),
    }));
    expect(requests[0].method).toBe("PATCH");
    expect(requests[0].body).toEqual({
      subject: "Moved",
      start: { dateTime: "2026-09-01T10:00:00.000Z", timeZone: "UTC" },
    });
  });

  it("responds to invitations with organizer notification", async () => {
    const { transport, requests } = canned({ "me/events/e1/decline": null });
    await Effect.runPromise(calendar.respondToEvent(transport, "e1", "decline", "conflict"));
    expect(requests[0].body).toEqual({ sendResponse: true, comment: "conflict" });
  });
});

describe("files writes and sharing", () => {
  it("lists sharedWithMe flattening remote items", async () => {
    const { transport } = canned({
      "me/drive/sharedWithMe": { value: [
        { id: "local1", name: "wrapper", remoteItem: {
          id: "r1", name: "Plan.docx", size: 5,
          file: { mimeType: "application/vnd.openxmlformats" },
          parentReference: { driveId: "owner-drive" },
          shared: { sharedBy: { user: { displayName: "Bob" } } },
        } },
        { id: "local2", name: "no-remote" },
      ] },
    });
    const entries = await Effect.runPromise(files.listSharedWithMe(transport));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "r1", name: "Plan.docx", kind: "file", driveId: "owner-drive", modifiedBy: "Bob",
    });
  });

  it("creates folders with conflict-fail behavior", async () => {
    const { transport, requests } = canned({
      "me/drive/items/root/children": { id: "nf", name: "Reports", folder: {} },
    });
    const entry = await Effect.runPromise(
        files.createFolder(transport, { kind: "me" }, "root", "Reports"));
    expect(entry.kind).toBe("folder");
    expect(requests[0].body).toEqual({
      name: "Reports", folder: {}, "@microsoft.graph.conflictBehavior": "fail",
    });
  });

  it("uploads new files via path-addressed PUT and replaces by item id", async () => {
    const { transport, requests } = canned({
      "me/drive/items/root:/notes.md:/content": { id: "up1", name: "notes.md", file: {} },
      "me/drive/items/up1/content": { id: "up1", name: "notes.md", file: {}, eTag: 'W/"2"' },
    });
    await Effect.runPromise(files.uploadFile(transport, { kind: "me" }, "root",
        "notes.md", "# hi", "text/markdown"));
    expect(requests[0].method).toBe("PUT");
    expect(requests[0].body).toBe("# hi");
    expect(requests[0].contentType).toBe("text/markdown");

    const updated = await Effect.runPromise(files.replaceFileContent(transport,
        { kind: "me" }, "up1", "# hi v2", "text/markdown"));
    expect(updated.etag).toBe('W/"2"');
  });

  it("deletes items and downloads bounded binary content", async () => {
    const { transport, requests } = canned({ "me/drive/items/f1": null });
    await Effect.runPromise(files.deleteItem(transport, { kind: "me" }, "f1"));
    expect(requests[0].method).toBe("DELETE");

    const binary = canned({});
    binary.transport = makeTransport(TOKEN, (async () =>
        new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch);
    const bytes = await Effect.runPromise(
        files.downloadContent(binary.transport, { kind: "me" }, "f1"));
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});

describe("teams chats", () => {
  it("pages chats through the validated continuation", async () => {
    const { transport } = canned({
      "me/chats": {
        value: [{ id: "c1", chatType: "oneOnOne" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats?$skip=25",
      },
    });
    const page = await Effect.runPromise(teams.listChats(transport));
    expect(page.chats).toHaveLength(1);
    expect(page.next).toBeDefined();
  });

  it("creates 1:1 and group chats with bound members", async () => {
    const { transport, requests } = canned({ "chats": { id: "chat-1" } });
    await Effect.runPromise(teams.createChat(transport, "self-oid", ["bob@corp.example"]));
    const chatBody = requests[0].body as {
      chatType: string; members: Record<string, string>[];
    };
    expect(chatBody).toMatchObject({ chatType: "oneOnOne" });
    expect(chatBody.members).toHaveLength(2);
    expect(chatBody.members[1]["user@odata.bind"])
        .toBe("https://graph.microsoft.com/v1.0/users('bob@corp.example')");

    await Effect.runPromise(teams.createChat(transport, "self-oid",
        ["bob@corp.example", "carol@corp.example"], "Project X"));
    expect(requests[1].body).toMatchObject({ chatType: "group", topic: "Project X" });
  });
});
