import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { CountryCode } from "libphonenumber-js";
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
// No cursor pagination convention exists elsewhere in this codebase (GET
// /api/crm/contacts, GET /api/cdr, GET /api/messaging/conversations all use
// a flat `limit`/`take` with no cursor or offset) — `q`+`owner`+`tag`+`limit`
// here matches that precedent rather than introducing a new one.
export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q");
  const owner = searchParams.get("owner"); // "" = filter to unassigned
  const tag = searchParams.get("tag");
  const limit = Math.min(Number(searchParams.get("limit") ?? 100) || 100, 500);

  const where: Prisma.ContactWhereInput = {};
  const clauses: Prisma.ContactWhereInput[] = [];
  if (q) {
    clauses.push({
      OR: [
        { numberE164: { contains: q } },
        { displayName: { contains: q, mode: "insensitive" } },
        { company: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  if (owner !== null) clauses.push({ ownerId: owner || null });
  if (tag) clauses.push({ tags: { has: tag } });
  if (clauses.length) where.AND = clauses;

  const contacts = await db.contact.findMany({
    where: clauses.length ? where : undefined,
    include: {
      owner: { select: { id: true, name: true, extension: { select: { number: true } } } },
      companyRel: { select: { id: true, name: true } },
      _count: { select: { deals: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });

  return NextResponse.json({
    contacts: contacts.map((c) => ({ ...c, dealCount: c._count.deals })),
  });
}

// tags arrives as a plain string[] from the UI's comma-chip input, already
// split/trimmed client-side — validated here rather than re-parsed.
const CreateContactSchema = z.object({
  number: z.string().min(3),
  country: z.string().length(2).optional(), // ISO-2, e.g. "IN"/"AE" — see phone-normalize.ts's defaultCountry param
  displayName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
  company: z.string().trim().max(200).optional(),
  companyId: z.string().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  ownerId: z.string().optional(),
  initialNote: z.string().trim().max(5000).optional(),
});

function humanizeZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "Invalid request.";
  const path = first.path.length ? `${first.path.join(".")}: ` : "";
  return `${path}${first.message}`;
}

export async function POST(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const parsed = CreateContactSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: humanizeZodError(parsed.error) }, { status: 400 });
  }

  const country = (parsed.data.country as CountryCode | undefined) ?? undefined;
  const numberE164 = normalizeToE164(parsed.data.number, country);
  if (!numberE164) {
    return NextResponse.json({ error: `"${parsed.data.number}" doesn't look like a valid phone number.` }, { status: 400 });
  }

  // The @@unique([tenantId, numberE164]) constraint is the authoritative
  // check (a concurrent request could still race past this lookup) — this
  // is just what turns that into a message pointing at the existing
  // contact instead of a raw 500 or a duplicate row, per #4's requirement.
  // The catch below covers the race the lookup misses. findFirst, not
  // findUnique — numberE164 alone is no longer a unique key by itself (it's
  // tenant-composite now), but within one tenant's scoped client it's
  // effectively unique.
  const existing = await db.contact.findFirst({ where: { numberE164 } });
  if (existing) {
    return NextResponse.json(
      { error: "A contact with this number already exists.", existingContact: existing },
      { status: 409 }
    );
  }

  try {
    const contact = await db.$transaction(async (tx) => {
      // No `tenantId` in either literal below — force-injected at runtime
      // by the TenantClient extension (see src/lib/crm/activity.ts's
      // comment on the same pattern).
      const created = await tx.contact.create({
        data: {
          numberE164,
          displayName: parsed.data.displayName,
          email: parsed.data.email || undefined,
          company: parsed.data.company || undefined,
          companyId: parsed.data.companyId || undefined,
          tags: parsed.data.tags ?? [],
          ownerId: parsed.data.ownerId || undefined,
        } as unknown as Prisma.ContactUncheckedCreateInput,
      });
      if (parsed.data.initialNote) {
        await tx.contactNote.create({
          data: { contactId: created.id, authorId: guard.session.user.id, body: parsed.data.initialNote } as unknown as Prisma.ContactNoteUncheckedCreateInput,
        });
      }
      return created;
    });
    return NextResponse.json({ contact }, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "A contact with this number already exists." }, { status: 409 });
    }
    throw err;
  }
}
