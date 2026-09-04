import { randomInt, createHash } from "node:crypto";
import { unsafeGlobalDb } from "@/lib/db";
import { getProvider } from "@/lib/messaging/registry";
import { getSetting } from "@/lib/settings/service";

// Wave 2a multi-tenant migration: OtpChallenge and WaInstance are both
// tenant-scoped (src/lib/tenancy/scope-rules.ts). This module is a
// legitimate `unsafeGlobalDb` exception rather than a DI conversion —
// sendOtp()/verifyOtp() are called from BOTH session-guarded flows
// (register/send-fallback-otp) AND genuinely pre-session ones
// (api/auth-2fa/pre-login, api/auth/forgot-password — a user resetting a
// forgotten password cannot have a session by definition). A single
// consistent scoping strategy across the whole file, keyed off the
// `userId` every call site already has, is simpler and safer than two code
// paths. `resolveTenantId()` below resolves it explicitly from `userId` and
// every tenant-scoped query passes it into the query args by hand — per
// plan §2's "genuinely pre-tenant-resolution" exception category — rather
// than relying on any automatic scoping (there is none once
// `unsafeGlobalDb` is used directly).
async function resolveTenantId(userId: string): Promise<string> {
  const user = await unsafeGlobalDb.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  if (!user) throw new Error(`otp/service: no such user ${userId}`);
  return user.tenantId;
}

// Server-side OTP service, channel-routed. Firebase Phone Auth
// (src/lib/firebase/admin.ts) is a THIRD path entirely — client-driven,
// manages its own challenge state Google-side — and never touches this
// module; this file exists for whichever of OpenWA / Meta Cloud is
// selected as OTP_CHANNEL, plus login 2FA, which is always server-driven
// regardless of channel (see the plan's "Channel split for login 2FA"
// section for why 2FA can never use the client-side Firebase flow — it
// would leak the agent's full phone number to a not-yet-authenticated
// session).
//
// OTP_CHANNEL defaults to OPENWA: it needs no Meta template approval and
// no Firebase project to work at all, which is what makes OTP delivery
// functional the moment an OpenWA instance is paired, with zero external
// setup. An admin can switch to META_CLOUD from /admin/settings without
// a redeploy; FIREBASE routes registration to the client-driven flow
// instead (see src/app/register/page.tsx) and is not handled here at all
// — sendOtp()/verifyOtp() are only ever called for OPENWA/META_CLOUD.
//
// Every function here is deliberately conservative: codes are 6 digits,
// hashed (never stored plaintext), single-use, short-lived, and rate
// limited by real DB rows rather than an in-memory limiter — see
// OtpChallenge's schema comment for why checkSimpleRateLimit() was not
// reused for this.

const CODE_LENGTH = 6;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 5;
const SEND_WINDOW_MS = 60 * 60 * 1000;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function generateCode(): string {
  // randomInt is CSPRNG-backed (Node's crypto), not Math.random — an OTP
  // is exactly the kind of value where a predictable RNG is a real
  // vulnerability, not a theoretical one.
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

export interface OtpSendResult {
  ok: boolean;
  error?: string;
  challengeId?: string;
}

/** Resolve which OpenWA SESSION sends OTP. Explicit OTP_WA_INSTANCE_ID
 * setting names a WaInstance.id (an operator can dedicate one SIM to OTP
 * to isolate its ban-risk blast radius from customer messaging); it is
 * resolved to that instance's openwaSessionId — the id OpenWA's own API
 * calls need, NOT WaInstance.id. Otherwise the first CONNECTED OpenWA
 * instance with a bound session is used. Throws if none exists — a clear,
 * named failure rather than silently picking an arbitrary disconnected
 * instance. */
async function resolveOpenWaSessionId(tenantId: string): Promise<string> {
  const configuredInstanceId = await getSetting("OTP_WA_INSTANCE_ID");
  if (configuredInstanceId) {
    const configured = await unsafeGlobalDb.waInstance.findUnique({ where: { id: configuredInstanceId } });
    // Guard against a stale/cross-tenant OTP_WA_INSTANCE_ID setting pointing
    // at another tenant's instance — treat it the same as "not found" rather
    // than ever sending an OTP through another tenant's WhatsApp session.
    if (!configured || configured.tenantId !== tenantId || !configured.openwaSessionId) {
      throw new Error("OTP_WA_INSTANCE_ID is set but that instance has no active OpenWA session. Re-pair it in /admin/whatsapp.");
    }
    return configured.openwaSessionId;
  }

  const instance = await unsafeGlobalDb.waInstance.findFirst({
    where: { tenantId, provider: "OPENWA", status: "CONNECTED", openwaSessionId: { not: null } },
    orderBy: { simPort: "asc" },
  });
  if (!instance?.openwaSessionId) {
    throw new Error("No connected OpenWA instance is available to send OTPs. Pair one in /admin/whatsapp or set OTP_WA_INSTANCE_ID.");
  }
  return instance.openwaSessionId;
}

/**
 * Issue a new OTP challenge and deliver it over the configured channel
 * (OTP_CHANNEL: OPENWA or META_CLOUD). Throttled to MAX_SENDS_PER_HOUR
 * per (user, purpose) — counts existing OtpChallenge rows in the window
 * rather than trusting a caller-supplied counter.
 */
export async function sendOtp(params: {
  userId: string;
  phoneE164: string;
  purpose: "PHONE_VERIFICATION" | "LOGIN_2FA" | "PASSWORD_RESET";
}): Promise<OtpSendResult> {
  const tenantId = await resolveTenantId(params.userId);

  const windowStart = new Date(Date.now() - SEND_WINDOW_MS);
  const recentCount = await unsafeGlobalDb.otpChallenge.count({
    where: { tenantId, userId: params.userId, purpose: params.purpose, createdAt: { gte: windowStart } },
  });
  if (recentCount >= MAX_SENDS_PER_HOUR) {
    return { ok: false, error: "Too many verification codes requested. Try again later." };
  }

  const code = generateCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  const channel = ((await getSetting("OTP_CHANNEL")) || "OPENWA") as "OPENWA" | "META_CLOUD" | "FIREBASE";
  if (channel === "FIREBASE") {
    // Should never reach here — the registration UI branches to the
    // client-driven Firebase flow before ever calling this function for
    // that channel, and login 2FA never uses Firebase regardless of this
    // setting (see file header). Fail loudly rather than silently
    // falling back to a different channel than what was configured.
    return { ok: false, error: "OTP_CHANNEL is set to FIREBASE, which this server-side flow does not handle." };
  }

  const challenge = await unsafeGlobalDb.otpChallenge.create({
    data: {
      tenantId,
      userId: params.userId,
      phoneE164: params.phoneE164,
      codeHash,
      purpose: params.purpose,
      channel: "WHATSAPP",
      expiresAt,
    },
  });

  let result;
  if (channel === "OPENWA") {
    let openwaSessionId: string;
    try {
      openwaSessionId = await resolveOpenWaSessionId(tenantId);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "No OTP-capable WhatsApp instance available." };
    }
    const provider = getProvider("OPENWA");
    result = await provider.sendText({
      instanceId: openwaSessionId,
      toE164: params.phoneE164,
      text: `Your Algo PBX verification code is ${code}. It expires in 5 minutes.`,
    });
  } else {
    const provider = getProvider("META_CLOUD");
    if (!provider.sendTemplate) {
      return { ok: false, error: "WhatsApp OTP delivery is not configured on this provider." };
    }
    const [templateName, languageCode] = await Promise.all([
      getSetting("WHATSAPP_OTP_TEMPLATE_NAME"),
      getSetting("WHATSAPP_OTP_TEMPLATE_LANG"),
    ]);
    // MetaCloudProvider ignores instanceId entirely (one WABA phone
    // number serves every send — see that file's header comment).
    result = await provider.sendTemplate({
      instanceId: "otp",
      toE164: params.phoneE164,
      templateName: templateName || "agent_otp_verification",
      languageCode: languageCode || "en",
      params: [code],
    });
  }

  if (result.status === "failed") {
    return { ok: false, error: result.error ?? "WhatsApp delivery failed." };
  }

  return { ok: true, challengeId: challenge.id };
}

export interface OtpVerifyResult {
  ok: boolean;
  error?: string;
}

/**
 * Verify a code against the most recent unconsumed, unexpired challenge
 * for (user, purpose). Every failure path — wrong code, expired,
 * already consumed, attempts exhausted — increments `attempts` on the
 * SAME row so a guessing attacker can't reset their budget by triggering
 * a fresh lookup; only a brand new sendOtp() call issues a new row.
 */
export async function verifyOtp(params: {
  userId: string;
  purpose: "PHONE_VERIFICATION" | "LOGIN_2FA" | "PASSWORD_RESET";
  code: string;
}): Promise<OtpVerifyResult> {
  const tenantId = await resolveTenantId(params.userId);
  const challenge = await unsafeGlobalDb.otpChallenge.findFirst({
    where: { tenantId, userId: params.userId, purpose: params.purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!challenge) return { ok: false, error: "No pending verification code. Request a new one." };
  if (challenge.expiresAt.getTime() <= Date.now()) return { ok: false, error: "Code expired. Request a new one." };
  if (challenge.attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: "Too many incorrect attempts. Request a new code." };
  }

  const providedHash = hashCode(params.code.trim());
  if (providedHash !== challenge.codeHash) {
    await unsafeGlobalDb.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, error: "Incorrect code." };
  }

  await unsafeGlobalDb.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
  return { ok: true };
}
