import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/agent/escalation-targets — active managers only, for the
// call-controls dropdown. Any signed-in user (not staff-only): this is
// the whole point of the feature, an agent mid-call needs this list.
export async function GET() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const targets = await db.escalationTarget.findMany({
    where: { active: true },
    select: { id: true, name: true, extension: true, phoneE164: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ targets });
}
