import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const company = await db.company.findUnique({
    where: { id: params.id },
    include: {
      owner: { select: { id: true, name: true } },
      contacts: {
        select: { id: true, displayName: true, numberE164: true, email: true },
        orderBy: { updatedAt: "desc" },
      },
      deals: {
        include: {
          stage: { select: { id: true, name: true, isWon: true, isLost: true } },
          owner: { select: { id: true, name: true } },
        },
        orderBy: { updatedAt: "desc" },
      },
    },
  });
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    company: {
      ...company,
      deals: company.deals.map((d) => ({ ...d, value: Number(d.value) })),
    },
  });
}

const PatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  domain: z.string().max(200).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;
  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }
  const company = await db.company.update({ where: { id: params.id }, data: parsed.data });
  return NextResponse.json({ company });
}

// FK is onDelete: SetNull for contacts and Deal.company — deleting a
// company detaches its rows rather than cascading them away.
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;
  await db.company.delete({ where: { id: params.id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
