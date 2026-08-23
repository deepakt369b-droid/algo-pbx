import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { checkLoginRateLimit, recordLoginFailure } from "@/lib/rate-limit";
import { sendOtp } from "@/lib/otp/service";
import { isTrustedDevice, signOtpVerifiedToken, TRUSTED_DEVICE_COOKIE, OTP_VERIFIED_COOKIE, OTP_VERIFIED_MAX_AGE_SECONDS } from "@/lib/two-factor";

export const dynamic = "force-dynamic";

// POST /api/auth-2fa/pre-login — phase 1 of the two-phase login flow
// (Workstream 6). Validates the password (same bcrypt/rate-limit/
// constant-time-miss discipline as src/auth.ts's authorize(), which
// still runs its OWN full check again at the final signIn() step — this
// route never itself creates a session). Two outcomes:
//   - A valid TrustedDevice cookie for this exact user -> 2FA is
//     skipped; an otp_verified cookie is set so the following
//     signIn("credentials") call clears authorize()'s check.
//   - No trusted device -> an OTP is sent via WhatsApp and the client is
//     told to collect it (POST /api/auth-2fa/verify next).
// Deliberately returns the SAME generic shape whether the account
// doesn't exist, the password is wrong, or the account is disabled —
// exactly the enumeration-avoidance discipline auth.ts's authorize()
// already applies, duplicated here since this route runs before
// authorize() ever sees the request.
const Schema = z.object({ email: z.string().email(), password: z.string().min(8) });

const DUMMY_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8Q9E3JJ7bTf2BzJhLmyxwaMH.87UbG";

export async function POST(request: NextRequest) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid credentials." }, { status: 400 });
  const { email, password } = parsed.data;

  const forwardedFor = request.headers.get("x-forwarded-for");
  const ip = forwardedFor?.split(",")[0]?.trim() || "unknown";

  const rateLimit = await checkLoginRateLimit(email, ip);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const user = await db.user.findUnique({ where: { email } });
  const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
  const validPassword = await bcrypt.compare(password, hashToCompare);

  if (!user || !user.passwordHash || !validPassword || user.disabled) {
    await recordLoginFailure(email, ip, user?.id);
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const trustedCookie = request.cookies.get(TRUSTED_DEVICE_COOKIE)?.value;
  const trusted = await isTrustedDevice(trustedCookie, user.id);

  if (trusted) {
    const response = NextResponse.json({ needs2fa: false });
    response.cookies.set(OTP_VERIFIED_COOKIE, signOtpVerifiedToken(user.id), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: OTP_VERIFIED_MAX_AGE_SECONDS,
      path: "/",
    });
    return response;
  }

  if (!user.phoneE164 || !user.phoneVerifiedAt) {
    // No verified number on file to challenge — can't do 2FA at all.
    // Fail OPEN here (skip 2FA) rather than lock the user out entirely:
    // an agent mid-registration (profile not complete yet) still needs
    // to be able to sign in to REACH the registration flow in the first
    // place — see src/middleware.ts's gate, which runs after this.
    const response = NextResponse.json({ needs2fa: false });
    response.cookies.set(OTP_VERIFIED_COOKIE, signOtpVerifiedToken(user.id), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: OTP_VERIFIED_MAX_AGE_SECONDS,
      path: "/",
    });
    return response;
  }

  const otpResult = await sendOtp({ userId: user.id, phoneE164: user.phoneE164, purpose: "LOGIN_2FA" });
  if (!otpResult.ok) {
    return NextResponse.json({ error: `Could not send verification code: ${otpResult.error}` }, { status: 502 });
  }

  // Masked number only — the client never receives the full number at
  // this not-yet-authenticated stage (see the plan's "Channel split for
  // login 2FA" section for why this is the whole reason 2FA doesn't
  // reuse the client-side Firebase flow registration uses).
  const masked = user.phoneE164.replace(/^(\+\d{1,3})\d+(\d{3})$/, "$1 ••••• $2");

  // No userId exposed to the client — verify-2fa re-derives the user
  // from `email` instead, matching the OTP challenge internally.
  return NextResponse.json({ needs2fa: true, maskedPhone: masked });
}
