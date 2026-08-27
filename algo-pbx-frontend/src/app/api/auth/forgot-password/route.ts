import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { sendOtp } from "@/lib/otp/service";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

const Schema = z.object({ email: z.string().email() });

// Always the same shape/message regardless of whether the account
// exists, is disabled, or has no verified phone — an attacker must not
// be able to enumerate accounts through this endpoint, same discipline
// src/auth.ts's authorize() and /api/auth-2fa/pre-login already apply.
// KNOWN, ACCEPTED GAP (not fixed): response TIMING still differs
// slightly between the real-account path (which awaits an actual
// WhatsApp send) and the no-such-account path (which returns
// immediately) — a determined attacker measuring latency could still
// extract a weak signal. Matching that timing exactly would mean faking
// a WhatsApp API round-trip on every miss, which isn't worth the
// complexity for a best-effort control; flagged here rather than either
// silently ignored or over-engineered.
const GENERIC_MESSAGE = "If an account with that email has a verified phone number on file, a reset code was just sent to it via WhatsApp.";

// POST /api/auth/forgot-password { email } — self-service password
// reset, step 1 (Loop C3). Reuses the same OtpChallenge machinery as
// phone verification / login 2FA (5/hour send throttle, 5-attempt guess
// throttle, hashed codes) via a new PASSWORD_RESET purpose, rather than
// inventing a parallel mechanism.
export const POST = withApiErrorHandler(async (request: NextRequest) => {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const user = await db.user.findUnique({ where: { email: parsed.data.email } });
  if (user && !user.disabled && user.phoneE164 && user.phoneVerifiedAt) {
    // Failure here (rate-limited, no WhatsApp instance connected, etc.)
    // is deliberately swallowed — surfacing it would distinguish "account
    // exists but send failed" from "no such account" to the caller.
    await sendOtp({ userId: user.id, phoneE164: user.phoneE164, purpose: "PASSWORD_RESET" }).catch(() => undefined);
  }

  return NextResponse.json({ ok: true, message: GENERIC_MESSAGE });
});
