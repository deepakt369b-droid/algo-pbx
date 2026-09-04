import { NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/admin/escalation-attempts — the persistent log requested
// alongside the WhatsApp ping: every escalation attempt, who made it, to
// whom, and how it went. requireStaffSession (not admin-only) since
// reviewing this is a supervisor-level visibility need, matching
// /admin/sign-ins and /admin/reports's own access tier — managing the
// target LIST itself stays ADMIN-only (see escalation-targets/route.ts).
export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const attempts = await db.escalationAttempt.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { agent: { select: { name: true, email: true } } },
  });
  return NextResponse.json({ attempts });
}
