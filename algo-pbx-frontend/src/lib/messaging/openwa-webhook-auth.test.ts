import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyOpenWaSignature } from "./openwa-webhook-auth";

const SECRET = "test-secret-abc123";

function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyOpenWaSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"event":"message.received","sessionId":"abc"}';
    expect(verifyOpenWaSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = '{"event":"message.received"}';
    const signature = sign(body);
    expect(verifyOpenWaSignature('{"event":"message.received","extra":1}', signature, SECRET)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = '{"event":"message.received"}';
    expect(verifyOpenWaSignature(body, sign(body, "wrong-secret"), SECRET)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyOpenWaSignature("{}", null, SECRET)).toBe(false);
  });

  it("rejects when no secret is configured", () => {
    const body = "{}";
    expect(verifyOpenWaSignature(body, sign(body), "")).toBe(false);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    expect(verifyOpenWaSignature("{}", "sha256=short", SECRET)).toBe(false);
  });
});
