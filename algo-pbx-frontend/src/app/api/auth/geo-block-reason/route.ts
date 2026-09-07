import { NextRequest, NextResponse } from "next/server";
import { GEO_BLOCK_COOKIE, verifyGeoBlockCookie } from "@/lib/geo/geo-block-cookie";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET /api/auth/geo-block-reason — the "companion small route" the geo
// enforcement chain needs (plan §3.3, node W5) because NextAuth's
// Credentials `authorize()` (src/auth.ts) can only return null or throw;
// it cannot hand the calling page a message directly, and the message
// itself is HMAC-signed with AUTH_SECRET (src/lib/geo/geo-block-cookie.ts)
// — a server-only value the client cannot verify on its own even though
// the cookie's raw bytes are technically visible to it.
//
// Mirrors the two-phase 2FA flow's OWN cookie discipline (see
// src/lib/two-factor.ts's OTP_VERIFIED_COOKIE): httpOnly, short-lived,
// read/verified server-side only. Investigated first, per this task's
// brief, whether the existing OTP flow gives login-form.tsx a reason via a
// cookie the client reads directly — it does not: pre-login/verify
// (api/auth-2fa/*) are ordinary JSON API routes that never touch
// authorize() at all, so there was no existing "authorize() -> cookie ->
// client" mechanism to replicate verbatim. This route is the smallest
// analog: authorize() sets the signed cookie (the one thing it CAN do),
// and this one-shot route is what turns it back into a message the already
//-client-side login-form.tsx (finishSignIn(), on a signIn() error) can
// display, exactly the way pre-login/verify already return JSON errors for
// every other rejection reason.
//
// Single use: the payload is DELETED after being read once, same "flash
// message" shape as the sign/verify pair it's modeled on — a stale geo
// block reason must not linger and be replayed against a LATER, unrelated
// signIn() attempt from the same browser.
export const GET = withApiErrorHandler(async (request: NextRequest) => {
  const token = request.cookies.get(GEO_BLOCK_COOKIE)?.value;
  const payload = verifyGeoBlockCookie(token);

  const response = NextResponse.json(payload ? { blocked: true, ...payload } : { blocked: false });
  if (token) {
    response.cookies.set(GEO_BLOCK_COOKIE, "", { maxAge: 0, path: "/" });
  }
  return response;
});
