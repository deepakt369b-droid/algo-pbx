import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { verifyOtp } from "@/lib/otp/service";
import { maybeCompleteProfile } from "@/lib/registration";

export const dynamic = "force-dynamic";

const Schema = z.object({ code: z.string().regex(/^\d{6}$/, "Code must be 6 digits") });

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const result = await verifyOtp({ userId: guard.session.user.id, purpose: "PHONE_VERIFICATION", code: parsed.data.code });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  await db.user.update({
    where: { id: guard.session.user.id },
    data: { phoneVerifiedAt: new Date(), phoneVerifiedByAdminId: null },
  });

  await db.auditLog.create({
    data: { action: "user.phone_verified", actorId: guard.session.user.id, targetId: guard.session.user.id, metadata: { channel: "whatsapp" } },
  });

  await maybeCompleteProfile(guard.session.user.id);

  return NextResponse.json({ ok: true });
}
