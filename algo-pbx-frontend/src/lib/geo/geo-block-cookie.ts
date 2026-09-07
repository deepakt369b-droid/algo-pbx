// Delivers the geo-lock's agent-facing message across a redirect: the
// password and 2FA are already proven by the time src/auth.ts's
// authorize() rejects a sign-in for a geo reason (plan §3.3, W6's UI
// spec), so there's no enumeration risk left to protect — but
// NextAuth's Credentials `authorize()` can only return null/throw, it
// can't hand the calling page a message directly. This mirrors
// src/lib/two-factor.ts's OTP_VERIFIED_COOKIE sign/verify pattern
// exactly: reuse its HMAC-over-AUTH_SECRET scheme rather than reinvent
// signing, short expiry (60s — just long enough to complete the
// redirect and render the message), timing-safe comparison.

import { createHmac, timingSafeEqual } from "node:crypto";

export const GEO_BLOCK_COOKIE = "algopbx_geo_block";

const GEO_BLOCK_TTL_MS = 60 * 1000;

export type GeoBlockCookiePayload = {
  reason: string;
  country: string | null;
  remaining: number | null;
};

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set.");
  return s;
}

// The payload's `country`/`remaining` fields can legitimately be null;
// base64url-encode the JSON so the signed string stays a single
// dot-delimited token, matching two-factor.ts's `field.field.mac` shape.
function encodePayload(payload: GeoBlockCookiePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(encoded: string): GeoBlockCookiePayload | null {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.reason !== "string" ||
      (typeof parsed.country !== "string" && parsed.country !== null) ||
      (typeof parsed.remaining !== "number" && parsed.remaining !== null)
    ) {
      return null;
    }
    return { reason: parsed.reason, country: parsed.country, remaining: parsed.remaining };
  } catch {
    return null;
  }
}

/** Signs a 60-second-lived token carrying the geo-block reason. Not a
 * session token; purely a message-delivery vehicle for the redirect that
 * follows a geo-rejected sign-in. */
export function signGeoBlockCookie(payload: GeoBlockCookiePayload): string {
  const expiresAt = Date.now() + GEO_BLOCK_TTL_MS;
  const encoded = encodePayload(payload);
  const body = `${encoded}.${expiresAt}`;
  const mac = createHmac("sha256", secret()).update(body).digest("hex");
  return `${body}.${mac}`;
}

export function verifyGeoBlockCookie(token: string | undefined): GeoBlockCookiePayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encoded, expiresAtStr, mac] = parts;
  const body = `${encoded}.${expiresAtStr}`;
  const expectedMac = createHmac("sha256", secret()).update(body).digest("hex");

  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  return decodePayload(encoded);
}

export const GEO_BLOCK_MAX_AGE_SECONDS = GEO_BLOCK_TTL_MS / 1000;
