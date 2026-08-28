import { describe, expect, it } from "vitest";
import { describeReferNotify, parseReferNotify } from "./refer-notify";

describe("parseReferNotify", () => {
  it("reads a 100 Trying as pending", () => {
    const result = parseReferNotify("SIP/2.0 100 Trying");
    expect(result).toEqual({ progress: "pending", statusCode: 100, reason: "Trying" });
  });

  it("reads a 200 OK as succeeded", () => {
    const result = parseReferNotify("SIP/2.0 200 OK");
    expect(result).toEqual({ progress: "succeeded", statusCode: 200, reason: "OK" });
  });

  it("reads a 503 as failed, carrying the reason phrase", () => {
    const result = parseReferNotify("SIP/2.0 503 Service Unavailable");
    expect(result).toEqual({ progress: "failed", statusCode: 503, reason: "Service Unavailable" });
  });

  it("reads a 486 Busy Here as failed", () => {
    const result = parseReferNotify("SIP/2.0 486 Busy Here");
    expect(result.progress).toBe("failed");
    expect(result.statusCode).toBe(486);
  });

  it("never reports success for an empty body", () => {
    const result = parseReferNotify("");
    expect(result.progress).not.toBe("succeeded");
    expect(result.statusCode).toBeNull();
  });

  it("never reports success for a garbage body", () => {
    const result = parseReferNotify("not a sipfrag at all");
    expect(result.progress).not.toBe("succeeded");
  });

  it("handles CRLF line endings", () => {
    const result = parseReferNotify("SIP/2.0 200 OK\r\n");
    expect(result.progress).toBe("succeeded");
  });

  it("handles extra headers after the status line", () => {
    const result = parseReferNotify("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n");
    expect(result.progress).toBe("succeeded");
    expect(result.statusCode).toBe(200);
  });

  it("treats a status line with no reason phrase as reason: null", () => {
    const result = parseReferNotify("SIP/2.0 200");
    expect(result.progress).toBe("succeeded");
    expect(result.reason).toBeNull();
  });
});

describe("describeReferNotify", () => {
  it("names the code and reason for a failed transfer", () => {
    const text = describeReferNotify({ progress: "failed", statusCode: 503, reason: "Service Unavailable" });
    expect(text).toBe("Transfer rejected (503: Service Unavailable).");
  });

  it("falls back to 'unknown' when the code is missing", () => {
    const text = describeReferNotify({ progress: "failed", statusCode: null, reason: null });
    expect(text).toBe("Transfer rejected (unknown).");
  });

  it("reports pending status as unconfirmed", () => {
    const text = describeReferNotify({ progress: "pending", statusCode: null, reason: null });
    expect(text).toBe("Transfer status unconfirmed.");
  });
});
