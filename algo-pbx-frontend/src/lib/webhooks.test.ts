import { describe, expect, it } from "vitest";
import { signWebhookPayload } from "./webhooks";

describe("signWebhookPayload", () => {
  it("produces a stable HMAC-SHA256 hex digest for the same body/secret", () => {
    const body = JSON.stringify({ event: "call.ended", uniqueId: "abc123" });
    const sig1 = signWebhookPayload(body, "shared-secret");
    const sig2 = signWebhookPayload(body, "shared-secret");
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different signature for a different secret", () => {
    const body = JSON.stringify({ event: "call.ended" });
    expect(signWebhookPayload(body, "secret-a")).not.toBe(signWebhookPayload(body, "secret-b"));
  });

  it("produces a different signature for a different body", () => {
    const sig1 = signWebhookPayload(JSON.stringify({ a: 1 }), "secret");
    const sig2 = signWebhookPayload(JSON.stringify({ a: 2 }), "secret");
    expect(sig1).not.toBe(sig2);
  });
});
