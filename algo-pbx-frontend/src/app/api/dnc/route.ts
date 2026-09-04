import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireStaffSession } from "@/lib/auth-guard";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// GET /api/dnc — staff-only listing of the compliance blocklist.
export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

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
  const { session, db } = guard;

  const body = await req.json();
  const parsed = CreateDncEntrySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const numberE164 = normalizeToE164(parsed.data.number);
  if (!numberE164) {
    return NextResponse.json({ error: `"${parsed.data.number}" doesn't look like a valid phone number.` }, { status: 400 });
  }

  // DoNotCallEntry.numberE164 was globally @unique; it's tenant-composite
  // now (`@@unique([tenantId, numberE164])`, plan §1), hence the compound
  // key. `tenantId` is included in `create` to satisfy the generated
  // CreateInput type — the TenantClient extension force-overrides it at
  // runtime to the caller's own tenant regardless (see
  // crm/activity.ts's comment on the same pattern), so passing the real
  // value here is redundant but harmless, not load-bearing.
  const entry = await db.doNotCallEntry.upsert({
    where: { tenantId_numberE164: { tenantId: session.user.tenantId, numberE164 } },
    create: {
      tenantId: session.user.tenantId,
      numberE164,
      reason: parsed.data.reason,
      source: "manual",
      addedById: session.user.id,
    },
    update: { reason: parsed.data.reason },
  });

  return NextResponse.json({ entry }, { status: 201 });
}
