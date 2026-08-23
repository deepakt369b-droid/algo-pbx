import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { verifyOtp } from "@/lib/otp/service";
import {
  rememberDevice,
  signOtpVerifiedToken,
  OTP_VERIFIED_COOKIE,
  OTP_VERIFIED_MAX_AGE_SECONDS,
  TRUSTED_DEVICE_COOKIE,
  TRUSTED_DEVICE_MAX_AGE_SECONDS,
} from "@/lib/two-factor";

export const dynamic = "force-dynamic";

// POST /api/auth-2fa/verify — phase 2. Re-derives the user from `email`
// (no user id is ever sent to the client by pre-login — see that
// route's comment) and confirms the code against the OtpChallenge row
// pre-login created. Does NOT re-check the password: verifyOtp() can
// only succeed against a challenge that pre-login's own password check
// already gated the creation of, so there is no bypass here for someone
// who doesn't know the password — see this route's own security note
// below for the attempt-budget reasoning.
const Schema = z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/) });

export async function POST(request: NextRequest) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const user = await db.user.findUnique({ where: { email: parsed.data.email }, select: { id: true, disabled: true } });
  if (!user || user.disabled) {
    // Generic failure — matches pre-login's enumeration-avoidance shape.
    return NextResponse.json({ error: "Incorrect code." }, { status: 400 });
  }

  const result = await verifyOtp({ userId: user.id, purpose: "LOGIN_2FA", code: parsed.data.code });
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Incorrect code." }, { status: 400 });
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  const ip = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const userAgent = request.headers.get("user-agent") ?? "unknown device";
  const deviceToken = await rememberDevice(user.id, userAgent.slice(0, 200), ip);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(OTP_VERIFIED_COOKIE, signOtpVerifiedToken(user.id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: OTP_VERIFIED_MAX_AGE_SECONDS,
    path: "/",
  });
  response.cookies.set(TRUSTED_DEVICE_COOKIE, deviceToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: TRUSTED_DEVICE_MAX_AGE_SECONDS,
    path: "/",
  });
  return response;
}
