import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { signGeoBlockCookie, verifyGeoBlockCookie } from "./geo-block-cookie";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-for-geo-block-cookie-unit-tests-only";
});

describe("signGeoBlockCookie / verifyGeoBlockCookie", () => {
  it("round-trips a valid payload", () => {
    const token = signGeoBlockCookie({ reason: "wrong_country", country: "PK", remaining: 3 });
    expect(verifyGeoBlockCookie(token)).toEqual({ reason: "wrong_country", country: "PK", remaining: 3 });
  });

  it("round-trips null country/remaining (locked case)", () => {
    const token = signGeoBlockCookie({ reason: "locked", country: null, remaining: null });
    expect(verifyGeoBlockCookie(token)).toEqual({ reason: "locked", country: null, remaining: null });
  });

  it("rejects a missing token", () => {
    expect(verifyGeoBlockCookie(undefined)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyGeoBlockCookie("not-a-real-token")).toBeNull();
    expect(verifyGeoBlockCookie("a.b")).toBeNull();
  });

  it("rejects a token with a tampered signature", () => {
    const token = signGeoBlockCookie({ reason: "wrong_country", country: "PK", remaining: 3 });
    const [encoded, expiresAt] = token.split(".");
    const forged = `${encoded}.${expiresAt}.0000000000000000000000000000000000000000000000000000000000000000`;
    expect(verifyGeoBlockCookie(forged)).toBeNull();
  });

  it("rejects a token with tampered payload but a recomputed-looking structure", () => {
    const token = signGeoBlockCookie({ reason: "wrong_country", country: "PK", remaining: 3 });
    const [, expiresAt, mac] = token.split(".");
    const forgedEncoded = Buffer.from(
      JSON.stringify({ reason: "allowed", country: null, remaining: null }),
      "utf8"
    ).toString("base64url");
    const forged = `${forgedEncoded}.${expiresAt}.${mac}`;
    expect(verifyGeoBlockCookie(forged)).toBeNull();
  });

  it("rejects an expired token", () => {
    // Construct a token with an already-past expiry using the same
    // signing scheme the module uses internally, since there's no
    // exported clock-injection seam — this exercises the real expiry
    // check via a forged-but-correctly-signed payload for a past time.
    const encoded = Buffer.from(
      JSON.stringify({ reason: "wrong_country", country: "PK", remaining: 3 }),
      "utf8"
    ).toString("base64url");
    const past = Date.now() - 1000;
    const body = `${encoded}.${past}`;
    const mac = createHmac("sha256", process.env.AUTH_SECRET!).update(body).digest("hex");
    expect(verifyGeoBlockCookie(`${body}.${mac}`)).toBeNull();
  });

  it("honors the 60-second expiry window (still valid just before expiry)", () => {
    const encoded = Buffer.from(
      JSON.stringify({ reason: "wrong_country", country: "PK", remaining: 3 }),
      "utf8"
    ).toString("base64url");
    const almostExpired = Date.now() + 1000;
    const body = `${encoded}.${almostExpired}`;
    const mac = createHmac("sha256", process.env.AUTH_SECRET!).update(body).digest("hex");
    expect(verifyGeoBlockCookie(`${body}.${mac}`)).toEqual({ reason: "wrong_country", country: "PK", remaining: 3 });
  });
});
