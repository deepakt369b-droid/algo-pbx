import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/crm/companies — the staff company directory. GET
// also serves the Combobox on the contact form (?q= search), so it stays
// cheap: id/name/domain + contact & deal counts only.
export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const q = new URL(request.url).searchParams.get("q")?.trim() || "";
  const companies = await db.company.findMany({
    where: q
      ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { domain: { contains: q, mode: "insensitive" } }] }
      : {},
    orderBy: { name: "asc" },
    take: 200,
    include: { _count: { select: { contacts: true, deals: true } } },
  });
  return NextResponse.json({
    companies: companies.map((c) => ({
      id: c.id,
      name: c.name,
      domain: c.domain,
      phone: c.phone,
      address: c.address,
      contactCount: c._count.contacts,
      dealCount: c._count.deals,
    })),
  });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  domain: z.string().max(200).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
});

export async function POST(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }
  const company = await db.company.create({
    data: {
      name: parsed.data.name,
      domain: parsed.data.domain ?? null,
      phone: parsed.data.phone ?? null,
      address: parsed.data.address ?? null,
      ownerId: guard.session.user.id,
    },
  });
  return NextResponse.json({ company }, { status: 201 });
}
