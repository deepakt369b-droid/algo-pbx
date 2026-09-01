import { describe, expect, it, vi } from "vitest";
import { resolveWhatsAppConversation, createWhatsAppConversationWithInstance } from "./whatsapp-deep-link";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("resolveWhatsAppConversation", () => {
  it("opens an existing conversation instead of creating a new one", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("/api/messaging/conversations");
      return jsonResponse(200, {
        conversations: [
          { id: "conv-1", channel: "WHATSAPP", contact: { numberE164: "+971500000001" } },
          { id: "conv-2", channel: "WHATSAPP", contact: { numberE164: "+971500000002" } },
        ],
      });
    });

    const result = await resolveWhatsAppConversation("+971500000002", fetchImpl);

    expect(result).toEqual({ kind: "found", conversationId: "conv-2" });
    // The match was found on the GET — no POST create attempt should ever
    // have been made. This is the regression this test guards: the naive
    // "always POST" version this replaced would have hit create every time.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not silently swallow a 409 with no instance — surfaces the explicit agent empty state", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/api/messaging/conversations" && calls.filter((c) => c === url).length === 1) {
        return jsonResponse(200, { conversations: [] }); // no existing conversation
      }
      if (url === "/api/messaging/conversations") {
        return jsonResponse(409, { error: "No WhatsApp instance is assigned to you. Provide waInstanceId or ask an admin to assign one." });
      }
      if (url === "/api/admin/whatsapp/instances") {
        return jsonResponse(403, { error: "Forbidden" }); // caller is an ordinary agent, not an admin
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await resolveWhatsAppConversation("+971500000003", fetchImpl);

    expect(result).toEqual({ kind: "no-instance-agent" });
  });

  it("offers a SIM picker (excluding calls-only ports) when the caller is an admin with no instance", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/api/messaging/conversations" && calls.filter((c) => c === url).length === 1) {
        return jsonResponse(200, { conversations: [] });
      }
      if (url === "/api/messaging/conversations") {
        return jsonResponse(409, { error: "No WhatsApp instance is assigned to you. Provide waInstanceId or ask an admin to assign one." });
      }
      if (url === "/api/admin/whatsapp/instances") {
        return jsonResponse(200, {
          instances: [
            { id: "wa-1", label: "SIM 1", simPort: 1, provider: "OPENWA" },
            { id: "wa-2", label: "Calls only", simPort: 2, provider: "NONE" },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await resolveWhatsAppConversation("+971500000004", fetchImpl);

    expect(result).toEqual({
      kind: "no-instance-admin",
      instances: [{ id: "wa-1", label: "SIM 1", simPort: 1, provider: "OPENWA" }],
    });
  });

  it("surfaces a non-409 creation failure as a real error, not the instance-picker path", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/api/messaging/conversations" && calls.filter((c) => c === url).length === 1) {
        return jsonResponse(200, { conversations: [] });
      }
      if (url === "/api/messaging/conversations") {
        return jsonResponse(500, { error: "Internal error" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await resolveWhatsAppConversation("+971500000005", fetchImpl);

    expect(result).toEqual({ kind: "error", message: "Internal error" });
    // Must never reach the admin-instances probe for an unrelated failure.
    expect(calls).not.toContain("/api/admin/whatsapp/instances");
  });
});

describe("createWhatsAppConversationWithInstance", () => {
  it("creates a conversation with the chosen instance", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/messaging/conversations");
      expect(JSON.parse(init!.body as string)).toEqual({
        numberE164: "+971500000006",
        channel: "WHATSAPP",
        waInstanceId: "wa-1",
      });
      return jsonResponse(201, { conversationId: "conv-new" });
    });

    const result = await createWhatsAppConversationWithInstance("+971500000006", "wa-1", fetchImpl);

    expect(result).toEqual({ kind: "found", conversationId: "conv-new" });
  });

  it("surfaces a failure from the chosen instance as an error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(409, { error: "This SIM port is calls-only and has no WhatsApp identity." }));

    const result = await createWhatsAppConversationWithInstance("+971500000007", "wa-2", fetchImpl);

    expect(result).toEqual({ kind: "error", message: "This SIM port is calls-only and has no WhatsApp identity." });
  });
});
