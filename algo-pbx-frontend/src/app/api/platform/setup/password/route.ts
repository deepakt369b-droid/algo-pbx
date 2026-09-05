import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requirePlatformSetupSession } from "@/lib/platform-guard";
import { unsafeGlobalDb as db } from "@/lib/db";

// Step 1 of /platform/setup. Guarded by requirePlatformSetupSession (NOT
// requirePlatformSession) precisely because this route's whole job is to
// clear the state that guard would otherwise reject.
const BodySchema = z.object({
  // Stricter than the tenant plane's 8-char minimum (auth.ts) — this is the
  // highest-privilege account in the system.
  password: z.string().min(12),
});

export async function POST(request: Request) {
  const guard = await requirePlatformSetupSession();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Password must be at least 12 characters." }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  await db.platformUser.update({
    where: { id: guard.session.user.id },
    data: { passwordHash, mustChangePassword: false },
  });
  await db.platformAuditLog.create({
    data: {
      action: "platform.user.password_change",
      platformUserId: guard.session.user.id,
      reason: "self-service setup",
    },
  });

  return NextResponse.json({ ok: true });
}
