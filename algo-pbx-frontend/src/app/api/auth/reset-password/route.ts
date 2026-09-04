import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
// Pre-session — same unscoped-by-email lookup pattern as src/auth.ts's
// authorize(). tenantId for the AuditLog write below is taken off the
// resolved `user` row, matching two-factor.ts's resolveTenantId() pattern.
import { unsafeGlobalDb } from "@/lib/db";
import { verifyOtp } from "@/lib/otp/service";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

const Schema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  newPassword: z.string().min(8).max(200),
});

// One uniform error for every failure mode (no such account, wrong code,
// expired, attempts exhausted) — never distinguish which, same
// enumeration-avoidance discipline as forgot-password/route.ts.
const GENERIC_ERROR = "That code is invalid or has expired. Request a new one.";

// POST /api/auth/reset-password { email, code, newPassword } — step 2.
// Sets the new password AND stamps passwordChangedAt, which
// src/auth.ts's jwt callback checks on every request to kill every other
// outstanding session immediately (see that field's schema comment) —
// exactly the point of a reset after a suspected compromise, not just a
// convenience for a forgotten password.
export const POST = withApiErrorHandler(async (request: NextRequest) => {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const user = await unsafeGlobalDb.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || user.disabled) {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 400 });
  }

  const verify = await verifyOtp({ userId: user.id, purpose: "PASSWORD_RESET", code: parsed.data.code });
  if (!verify.ok) {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  const now = new Date();
  await unsafeGlobalDb.$transaction([
    unsafeGlobalDb.user.update({ where: { id: user.id }, data: { passwordHash, passwordPlain: parsed.data.newPassword, passwordChangedAt: now } }),
    unsafeGlobalDb.auditLog.create({
      data: { action: "user.password_reset_self_service", actorId: user.id, targetId: user.id, tenantId: user.tenantId, metadata: {} },
    }),
  ]);

  return NextResponse.json({ ok: true });
});
