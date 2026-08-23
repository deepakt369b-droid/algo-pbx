import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { signOtpVerifiedToken, verifyOtpVerifiedToken } from "./two-factor";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-for-two-factor-unit-tests-only";
});

describe("signOtpVerifiedToken / verifyOtpVerifiedToken", () => {
  it("verifies a token for the same user id it was signed for", () => {
    const token = signOtpVerifiedToken("user-123");
    expect(verifyOtpVerifiedToken(token, "user-123")).toBe(true);
  });

  it("rejects a token presented for a different user id", () => {
    const token = signOtpVerifiedToken("user-123");
    expect(verifyOtpVerifiedToken(token, "user-456")).toBe(false);
  });

  it("rejects a missing token", () => {
    expect(verifyOtpVerifiedToken(undefined, "user-123")).toBe(false);
  });

  it("rejects a malformed token", () => {
    expect(verifyOtpVerifiedToken("not-a-real-token", "user-123")).toBe(false);
    expect(verifyOtpVerifiedToken("a.b", "user-123")).toBe(false);
  });

  it("rejects a token with a tampered signature", () => {
    const token = signOtpVerifiedToken("user-123");
    const [userId, expiresAt] = token.split(".");
    const forged = `${userId}.${expiresAt}.0000000000000000000000000000000000000000000000000000000000000000`;
    expect(verifyOtpVerifiedToken(forged, "user-123")).toBe(false);
  });

  it("rejects a token with a tampered user id but a recomputed-looking structure", () => {
    const token = signOtpVerifiedToken("user-123");
    const [, expiresAt, mac] = token.split(".");
    const forged = `attacker-id.${expiresAt}.${mac}`;
    expect(verifyOtpVerifiedToken(forged, "attacker-id")).toBe(false);
  });

  it("rejects an expired token", () => {
    // Construct a token with an already-past expiry using the same
    // signing scheme the module uses internally, since there's no
    // exported clock-injection seam — this exercises the real expiry
    // check via a forged-but-correctly-signed payload for a past time.
    const past = Date.now() - 1000;
    const payload = `user-123.${past}`;
    const mac = createHmac("sha256", process.env.AUTH_SECRET!).update(payload).digest("hex");
    expect(verifyOtpVerifiedToken(`${payload}.${mac}`, "user-123")).toBe(false);
  });
});
