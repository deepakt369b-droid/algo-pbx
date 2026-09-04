import { NextRequest, NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/admin/sign-ins — every sign-in event, written by
// src/auth.ts's authorize() as an AuditLog row (action: "auth.signin").
// Polled every 5s by /admin/sign-ins, same pattern as
// src/components/wallboard.tsx — this codebase has no websocket/SSE
// transport, so a fast poll is the "notification" mechanism throughout,
// not just here.
export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 100), 500);

  const events = await db.auditLog.findMany({
    where: { action: "auth.signin" },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { actor: { select: { id: true, name: true, email: true, role: true } } },
  });

  const admin = await db.user.findUnique({ where: { id: guard.session.user.id }, select: { signInFeedSeenAt: true } });

  return NextResponse.json({
    events: events.map((e) => ({
      id: e.id,
      createdAt: e.createdAt,
      user: e.actor,
      metadata: e.metadata,
    })),
    lastSeenAt: admin?.signInFeedSeenAt ?? null,
  });
}

// POST /api/admin/sign-ins/mark-seen equivalent — kept on the same route
// as a lightweight action rather than a separate endpoint, since there's
// nothing else this small resource needs.
export async function POST() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  await db.user.update({ where: { id: guard.session.user.id }, data: { signInFeedSeenAt: new Date() } });
  return NextResponse.json({ ok: true });
}
