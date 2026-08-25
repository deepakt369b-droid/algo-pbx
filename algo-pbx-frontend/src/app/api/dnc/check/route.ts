import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// GET /api/dnc/check?number=... — the app-layer half of the two-layer DNC
// enforcement described in prisma/schema.prisma's DoNotCallEntry comment.
// Any signed-in user (not staff-only) — an agent needs this before dialing,
// see src/contexts/sip-context.tsx's makeCall(). This is advisory/UX only:
// the dialplan-level func_odbc check (pbx_configs/func_odbc.conf) is what
// actually prevents the call from a compliance standpoint, since a hardware
// phone or a compromised client could skip this endpoint entirely.
export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const number = req.nextUrl.searchParams.get("number");
  if (!number) {
    return NextResponse.json({ error: "Missing ?number=" }, { status: 400 });
  }

  const numberE164 = normalizeToE164(number);
  if (!numberE164) {
    // Not a parseable number at all — not our job to say whether it's
    // blocked, just that dialing it wouldn't reach anyone's DNC entry.
    return NextResponse.json({ blocked: false });
  }

  const entry = await db.doNotCallEntry.findUnique({ where: { numberE164 } });
  return NextResponse.json({ blocked: entry !== null, numberE164 });
}
