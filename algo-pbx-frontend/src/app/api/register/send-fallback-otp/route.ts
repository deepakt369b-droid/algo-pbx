import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { sendOtp } from "@/lib/otp/service";

export const dynamic = "force-dynamic";

// POST /api/register/send-fallback-otp — sends via whichever channel
// OTP_CHANNEL is set to (src/lib/otp/service.ts's sendOtp() does the
// routing: OpenWA, Meta Cloud, or FIREBASE — which sendOtp() itself
// refuses, since that channel is handled client-side instead). Despite
// the route name (kept for compatibility with when this was written as
// a Firebase-only fallback), this is now the PRIMARY verification path
// whenever OTP_CHANNEL is OPENWA or META_CLOUD — src/app/register/page.tsx
// calls it immediately with no "fallback" framing in that case, and only
// as an in-page fallback after a Firebase error when OTP_CHANNEL is
// FIREBASE.
export async function POST() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const user = await db.user.findUnique({ where: { id: guard.session.user.id }, select: { phoneE164: true } });
  if (!user?.phoneE164) {
    return NextResponse.json({ error: "Submit your contact number first." }, { status: 409 });
  }

  const result = await sendOtp({ userId: guard.session.user.id, phoneE164: user.phoneE164, purpose: "PHONE_VERIFICATION" });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  await db.auditLog.create({
    data: { action: "user.phone_otp_sent", actorId: guard.session.user.id, targetId: guard.session.user.id, metadata: { channel: "whatsapp" } },
  });

  return NextResponse.json({ ok: true });
}
