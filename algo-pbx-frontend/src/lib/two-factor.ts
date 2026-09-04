import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { unsafeGlobalDb } from "@/lib/db";

// Wave 2a multi-tenant migration: TrustedDevice is tenant-scoped
// (src/lib/tenancy/scope-rules.ts). isTrustedDevice()/rememberDevice() are
// called from the pre-session two-phase login flow
// (api/auth-2fa/pre-login, api/auth-2fa/verify — there is no session yet at
// that point, by construction: this IS the code that decides whether one
// gets issued) — a legitimate `unsafeGlobalDb` exception per plan §2, not a
// DI conversion. `tokenHash` stays a real global-unique column
// (TrustedDevice.tokenHash @unique, unchanged by wave 1), so
// isTrustedDevice()'s lookup needs no tenantId to be correct or safe; it
// separately re-checks `device.userId === userId` exactly as before.
// rememberDevice() writes a new row and must supply `tenantId` explicitly
// (required column, no `TenantClient` in play here) — resolved from
// `userId`, the same pattern src/lib/otp/service.ts uses.
async function resolveTenantId(userId: string): Promise<string> {
  const user = await unsafeGlobalDb.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  if (!user) throw new Error(`two-factor: no such user ${userId}`);
  return user.tenantId;
}

// Login 2FA plumbing (Workstream 6 — new-device/new-IP challenge, 30-day
// trusted device). NextAuth's Credentials `authorize()` is single-shot:
// it gets one request and must synchronously accept or reject, which
// can't drive an interactive "we sent you a code, now type it" exchange
// on its own. This module is the bridge: a two-phase pre-login flow
// (POST /api/auth/pre-login -> POST /api/auth/verify-2fa) issues a
// short-lived SIGNED cookie once 2FA clears, and authorize() (src/auth.ts)
// requires that cookie to be present and valid — on top of the password
// check it already does — before a session is issued. A correct
// password alone is no longer sufficient for an untrusted device; a
// forged cookie is not accepted either, since it's HMAC-signed with
// AUTH_SECRET, the same secret NextAuth itself signs session JWTs with.

export const OTP_VERIFIED_COOKIE = "algopbx_otp_verified";
export const TRUSTED_DEVICE_COOKIE = "algopbx_trusted_device";

const OTP_VERIFIED_TTL_MS = 2 * 60 * 1000; // just long enough to complete the signIn() call right after
const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set.");
  return s;
}

/** Signs a short-lived "this userId cleared 2FA just now" token. Not a
 * session token itself — authorize() still runs its own password check;
 * this only unblocks that check from also requiring an OTP on this one
 * request. */
export function signOtpVerifiedToken(userId: string): string {
  const expiresAt = Date.now() + OTP_VERIFIED_TTL_MS;
  const payload = `${userId}.${expiresAt}`;
  const mac = createHmac("sha256", secret()).update(payload).digest("hex");
  return `${payload}.${mac}`;
}

export function verifyOtpVerifiedToken(token: string | undefined, expectedUserId: string): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [userId, expiresAtStr, mac] = parts;
  const payload = `${userId}.${expiresAtStr}`;
  const expectedMac = createHmac("sha256", secret()).update(payload).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  if (userId !== expectedUserId) return false;
  return Number(expiresAtStr) > Date.now();
}

function hashTrustedDeviceToken(token: string): string {
  return createHmac("sha256", secret()).update(token).digest("hex");
}

export function generateTrustedDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

/** True if the raw cookie token maps to a live, unexpired TrustedDevice
 * row for this exact user — checked server-side against the DB, never
 * trusted on the cookie's say-so alone (the cookie only carries an
 * opaque token; its hash is what's actually looked up, same one-way
 * pattern as Invite/ApiKey/McpApproval). */
export async function isTrustedDevice(token: string | undefined, userId: string): Promise<boolean> {
  if (!token) return false;
  const tokenHash = hashTrustedDeviceToken(token);
  const device = await unsafeGlobalDb.trustedDevice.findUnique({ where: { tokenHash } });
  if (!device || device.userId !== userId) return false;
  if (device.expiresAt.getTime() <= Date.now()) return false;
  await unsafeGlobalDb.trustedDevice.update({ where: { id: device.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return true;
}

export async function rememberDevice(userId: string, label: string, ip: string): Promise<string> {
  const token = generateTrustedDeviceToken();
  const tenantId = await resolveTenantId(userId);
  await unsafeGlobalDb.trustedDevice.create({
    data: {
      tenantId,
      userId,
      tokenHash: hashTrustedDeviceToken(token),
      label,
      lastSeenIp: ip,
      expiresAt: new Date(Date.now() + TRUSTED_DEVICE_TTL_MS),
    },
  });
  return token;
}

export const TRUSTED_DEVICE_MAX_AGE_SECONDS = TRUSTED_DEVICE_TTL_MS / 1000;
export const OTP_VERIFIED_MAX_AGE_SECONDS = OTP_VERIFIED_TTL_MS / 1000;
