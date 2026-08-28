import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/contacts — session-authenticated Contacts directory
// for the admin UI (src/app/admin/contacts/page.tsx). Distinct from
// GET/POST /api/crm/contacts, which is bearer-API-key auth for an external
// CRM syncing its own list (see that route's header comment) — this one is
// for a signed-in browser session and follows this codebase's other
// /admin/* routes (e.g. GET /api/dnc, GET /api/cdr) in gating on
// requireStaffSession (ADMIN or SUPERVISOR). That matches the actual
// reachability of this page anyway: middleware.ts redirects any AGENT
// session away from every /admin/* route before it ever loads, so an
// AGENT-accessible API here would be unreachable from its own page regardless.
//
// No pagination convention exists elsewhere in this codebase (GET
// /api/crm/contacts, GET /api/cdr, GET /api/messaging/conversations all use
// a flat `limit`/`take` with no cursor or offset) — `q`+`limit` here matches
// that precedent rather than introducing a new one.
export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q");
  const limit = Math.min(Number(searchParams.get("limit") ?? 100) || 100, 500);

  const contacts = await db.contact.findMany({
    where: q
      ? { OR: [{ numberE164: { contains: q } }, { displayName: { contains: q, mode: "insensitive" } }] }
      : undefined,
    orderBy: { updatedAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ contacts });
}

const CreateContactSchema = z.object({
  number: z.string().min(3),
  displayName: z.string().max(200).optional(),
});

export async function POST(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const parsed = CreateContactSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const numberE164 = normalizeToE164(parsed.data.number);
  if (!numberE164) {
    return NextResponse.json({ error: `"${parsed.data.number}" doesn't look like a valid phone number.` }, { status: 400 });
  }

  const existing = await db.contact.findUnique({ where: { numberE164 } });
  if (existing) {
    return NextResponse.json({ error: "A contact with this number already exists." }, { status: 409 });
  }

  const contact = await db.contact.create({
    data: { numberE164, displayName: parsed.data.displayName },
  });

  return NextResponse.json({ contact }, { status: 201 });
}
