import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { verifyFirebasePhoneToken } from "@/lib/firebase/admin";
import { maybeCompleteProfile } from "@/lib/registration";

export const dynamic = "force-dynamic";

// POST /api/register/verify-phone — the PRIMARY phone-verification path
// (Firebase Phone Auth). The client has already completed
// signInWithPhoneNumber() + confirmationResult.confirm(code) in the
// browser (src/lib/firebase/client.ts) and holds a Firebase ID token —
// that token, not any client-asserted "verified: true" flag, is what
// this route trusts. See src/lib/firebase/admin.ts's header for the
// full reasoning.
//
// Two checks matter here, and both are load-bearing, not defensive
// filler:
//   1. verifyFirebasePhoneToken() throws on a forged/expired/invalid
//      token — a request that skips the real Firebase round-trip and
//      just POSTs a made-up token fails here, not silently.
//   2. The phone number Firebase attests to MUST match the number the
//      agent submitted via POST /api/register — otherwise an agent
//      could verify number A (perhaps one they don't actually use day
//      to day) and have it applied to profile B's contact number field.
const VerifySchema = z.object({
  idToken: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const parsed = VerifySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const user = await db.user.findUnique({ where: { id: guard.session.user.id }, select: { phoneE164: true } });
  if (!user?.phoneE164) {
    return NextResponse.json({ error: "Submit your contact number first (POST /api/register)." }, { status: 409 });
  }

  let verified: { phoneE164: string };
  try {
    verified = await verifyFirebasePhoneToken(parsed.data.idToken);
  } catch (err) {
    return NextResponse.json(
      { error: `Phone verification failed: ${err instanceof Error ? err.message : "invalid token"}` },
      { status: 401 }
    );
  }

  if (verified.phoneE164 !== user.phoneE164) {
    return NextResponse.json(
      { error: "The verified number does not match the number on your registration. Update your contact number and try again." },
      { status: 409 }
    );
  }

  await db.user.update({
    where: { id: guard.session.user.id },
    data: { phoneVerifiedAt: new Date(), phoneVerifiedByAdminId: null },
  });

  await db.auditLog.create({
    data: { action: "user.phone_verified", actorId: guard.session.user.id, targetId: guard.session.user.id, metadata: { channel: "firebase" } },
  });

  await maybeCompleteProfile(guard.session.user.id);

  return NextResponse.json({ ok: true });
}
