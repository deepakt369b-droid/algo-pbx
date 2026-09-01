import { describe, expect, it, vi } from "vitest";
import { OpenWaProvider, mapOpenWaMessage } from "./openwa-provider";

// Regression test for the live 400 a real send hit tonight: openwa-client's
// sendText/sendMedia used to build a body keyed `to`, but the real OpenWA
// send-text/send-media DTOs (sdk/javascript/src/types.ts SendTextRequest /
// SendMediaRequest at the pinned commit) key the destination `chatId` — a
// field the real server's validation doesn't recognize at all rejects the
// whole request with 400. Asserting the exact wire body here pins the
// contract so this can't silently regress back to `to`.
vi.mock("./openwa-client", () => ({
  sendText: vi.fn(async () => ({ messageId: "abc123", timestamp: 0 })),
  sendMedia: vi.fn(async () => ({ messageId: "def456", timestamp: 0 })),
}));

describe("OpenWaProvider", () => {
  it("sendText sends the destination as chatId, not to", async () => {
    const openwa = await import("./openwa-client");
    const provider = new OpenWaProvider();

    const result = await provider.sendText({
      instanceId: "session-1",
      toE164: "+971501234567",
      text: "hello",
    });

    expect(openwa.sendText).toHaveBeenCalledWith("session-1", {
      chatId: "971501234567@c.us",
      text: "hello",
    });
    expect(result).toEqual({ providerMessageId: "abc123", status: "sent" });
  });

  it("sendMedia sends the destination as chatId, not to", async () => {
    const openwa = await import("./openwa-client");
    const provider = new OpenWaProvider();

    const result = await provider.sendMedia({
      instanceId: "session-1",
      toE164: "+971501234567",
      mediaUrl: "https://example.com/a.jpg",
      mimeType: "image/jpeg",
    });

    expect(openwa.sendMedia).toHaveBeenCalledWith("session-1", {
      chatId: "971501234567@c.us",
      url: "https://example.com/a.jpg",
      caption: "",
      mimetype: "image/jpeg",
    });
    expect(result).toEqual({ providerMessageId: "def456", status: "sent" });
  });

  it("sendText fails cleanly without calling the client for a non-E.164 destination", async () => {
    const openwa = await import("./openwa-client");
    vi.mocked(openwa.sendText).mockClear();
    const provider = new OpenWaProvider();

    const result = await provider.sendText({ instanceId: "session-1", toE164: "not-e164", text: "hi" });

    expect(result.status).toBe("failed");
    expect(openwa.sendText).not.toHaveBeenCalled();
  });
});

// The core inbound bug: OpenWA v0.23.1 reports `direction: "incoming"/"outgoing"`,
// NOT a `fromMe` boolean — the old `m.fromMe === true` skip silently ingested
// our own outbound messages as inbound with empty bodies, and every voice
// note / image (base64 under metadata.media, never `mediaUrl`) landed as an
// empty bubble.
describe("mapOpenWaMessage", () => {
  it("maps an incoming voice note to a voice mediaKind, from the sender", () => {
    const ev = mapOpenWaMessage(
      {
        id: "row-1",
        waMessageId: "WAMSG1",
        from: "971504852446@c.us",
        to: "971502644615@c.us",
        chatId: "971504852446@c.us",
        chatName: "Sarath Rk",
        body: "",
        type: "voice",
        direction: "incoming",
        timestamp: 1788249230,
        status: "read",
        metadata: { media: { mimetype: "audio/ogg; codecs=opus", data: "BASE64…" } },
      },
      "sess-1"
    );
    expect(ev).toMatchObject({
      fromE164: "+971504852446",
      direction: "incoming",
      mediaKind: "voice",
      mediaMimeType: "audio/ogg; codecs=opus",
      mediaUrl: null,
      waMessageId: "WAMSG1",
      contactName: "Sarath Rk",
    });
    expect(ev?.body).toBeNull();
  });

  it("treats an outgoing message as OUTBOUND and attributes it to the OTHER party", () => {
    const ev = mapOpenWaMessage(
      {
        id: "row-2",
        from: "971502644615@c.us",
        to: "971504852446@c.us",
        chatId: "971504852446@c.us",
        body: "Ok",
        type: "text",
        direction: "outgoing",
        timestamp: 1788248028,
      },
      "sess-1"
    );
    expect(ev).toMatchObject({ fromE164: "+971504852446", direction: "outgoing", body: "Ok" });
    // chatName on an outgoing row is the account owner — never adopted as the contact name.
    expect(ev?.contactName).toBeNull();
  });

  it("parseInbound skips outgoing rows (history-sync backfills those instead)", () => {
    const provider = new OpenWaProvider();
    const events = provider.parseInbound({
      sessionId: "sess-1",
      data: [
        { id: "a", from: "971504852446@c.us", body: "hi", type: "text", direction: "incoming" },
        { id: "b", from: "971502644615@c.us", to: "971504852446@c.us", body: "reply", type: "text", direction: "outgoing" },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ direction: "incoming", body: "hi" });
  });

  it("drops group messages", () => {
    expect(
      mapOpenWaMessage(
        { id: "g", from: "120363348217299705@g.us", body: "x", type: "text", direction: "incoming" },
        "sess-1"
      )
    ).toBeNull();
  });
});
