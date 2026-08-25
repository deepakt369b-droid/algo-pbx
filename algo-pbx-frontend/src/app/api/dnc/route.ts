import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// GET /api/dnc — staff-only listing of the compliance blocklist.
export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const entries = await db.doNotCallEntry.findMany({
    select: {
      id: true,
      numberE164: true,
      reason: true,
      source: true,
      createdAt: true,
      addedBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ entries });
}

// POST /api/dnc — add a single number. The number is normalized here
// (src/lib/phone-normalize.ts) before storage, so lookups (GET /api/dnc/check)
// and the dialplan's cruder match both key off the same canonical form as
// far as the app side is concerned — see that route's file-header comment
// for why the dialplan side can't fully share this normalization.
const CreateDncEntrySchema = z.object({
  number: z.string().min(3),
  reason: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const body = await req.json();
  const parsed = CreateDncEntrySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const numberE164 = normalizeToE164(parsed.data.number);
  if (!numberE164) {
    return NextResponse.json({ error: `"${parsed.data.number}" doesn't look like a valid phone number.` }, { status: 400 });
  }

  const entry = await db.doNotCallEntry.upsert({
    where: { numberE164 },
    create: {
      numberE164,
      reason: parsed.data.reason,
      source: "manual",
      addedById: guard.session.user.id,
    },
    update: { reason: parsed.data.reason },
  });

  return NextResponse.json({ entry }, { status: 201 });
}
