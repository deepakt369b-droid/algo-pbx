import { describe, expect, it, vi } from "vitest";
import { OpenWaProvider } from "./openwa-provider";

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
