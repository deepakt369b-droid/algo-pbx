import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// POST /api/invite — consumes a single-use invite token and sets the
// agent's password for the FIRST AND ONLY TIME. This is the entire
// self-service surface an agent ever gets over their own credentials —
// there is deliberately no equivalent route reachable after this one
// succeeds (User.passwordHash becomes non-null, and this route's own
// checks below refuse an already-consumed or expired token).
//
// No session required — this runs before the user has ever logged in.
// Rate-limited implicitly by the token itself being unguessable
// (32 random bytes) and single-use; a wrong-token guessing attack has no
// oracle to exploit since every response for an invalid/expired/consumed
// token is identical.
const ConsumeSchema = z.object({
  token: z.string().min(32),
  password: z.string().min(8).max(200),
});

export const POST = withApiErrorHandler(async function POST(request: NextRequest) {
  const parsed = ConsumeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const tokenHash = createHash("sha256").update(parsed.data.token).digest("hex");
  const invite = await db.invite.findUnique({ where: { tokenHash }, include: { user: true } });

  if (!invite || invite.consumedAt || invite.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: "This invite link is invalid or has expired. Ask an admin to issue a new one." }, { status: 410 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  await db.$transaction([
    db.user.update({ where: { id: invite.userId }, data: { passwordHash } }),
    db.invite.update({ where: { id: invite.id }, data: { consumedAt: new Date() } }),
    db.auditLog.create({
      data: { action: "invite.consume", actorId: invite.userId, targetId: invite.id, metadata: {} },
    }),
  ]);

  return NextResponse.json({ ok: true, email: invite.user.email });
});

// GET /api/invite?token=... — lets the invite page confirm the token is
// still valid (and show the account's email) before rendering the
// password form, without consuming it.
export const GET = withApiErrorHandler(async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Missing token" }, { status: 400 });

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const invite = await db.invite.findUnique({ where: { tokenHash }, include: { user: true } });

  if (!invite || invite.consumedAt || invite.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ valid: false }, { status: 410 });
  }

  return NextResponse.json({ valid: true, email: invite.user.email, name: invite.user.name });
});
