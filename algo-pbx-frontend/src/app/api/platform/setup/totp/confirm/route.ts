import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePlatformSetupSession } from "@/lib/platform-guard";
import { unsafeGlobalDb as db } from "@/lib/db";
import { verifyTotpCode } from "@/lib/platform-totp";

// Step 2 of /platform/setup. The secret itself was generated and persisted
// by platform/setup/page.tsx on first render of this step (idempotent —
// reused across reloads) — this route only ever verifies a code against
// whatever secret is already on the row, it never generates one.
const BodySchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

export async function POST(request: Request) {
  const guard = await requirePlatformSetupSession();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter the 6-digit code from your authenticator app." }, { status: 400 });
  }

  const user = await db.platformUser.findUnique({
    where: { id: guard.session.user.id },
    select: { totpSecret: true },
  });
  if (!user?.totpSecret || !verifyTotpCode(user.totpSecret, parsed.data.code)) {
    return NextResponse.json({ error: "Invalid code. Check your device's clock and try again." }, { status: 400 });
  }

  await db.platformUser.update({
    where: { id: guard.session.user.id },
    data: { totpConfirmedAt: new Date() },
  });
  await db.platformAuditLog.create({
    data: {
      action: "platform.user.totp_confirmed",
      platformUserId: guard.session.user.id,
      reason: "self-service setup",
    },
  });

  return NextResponse.json({ ok: true });
}
