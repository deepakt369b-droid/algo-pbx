import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireApiKey } from "@/lib/api-key-auth";
import { checkSimpleRateLimit } from "@/lib/rate-limit";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// GET/POST /api/crm/contacts — list/search and upsert Contact rows, for an
// external CRM to keep its own contact list in sync with call-center
// activity. Bearer API-key auth (src/lib/api-key-auth.ts), not a browser
// session.
export async function GET(request: NextRequest) {
  const guard = await requireApiKey(request);
  if ("response" in guard) return guard.response;
  if (!checkSimpleRateLimit(`crm:${guard.apiKey.id}`, 120, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q");
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);

  const contacts = await db.contact.findMany({
    where: q
      ? { OR: [{ numberE164: { contains: q } }, { displayName: { contains: q, mode: "insensitive" } }] }
      : undefined,
    orderBy: { updatedAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ contacts });
}

const UpsertSchema = z.object({
  number: z.string().min(3),
  displayName: z.string().max(200).optional(),
});

export async function POST(request: NextRequest) {
  const guard = await requireApiKey(request);
  if ("response" in guard) return guard.response;
  if (!checkSimpleRateLimit(`crm:${guard.apiKey.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = UpsertSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });

  const numberE164 = normalizeToE164(parsed.data.number);
  if (!numberE164) return NextResponse.json({ error: "number is not a valid, parseable phone number" }, { status: 400 });

  const contact = await db.contact.upsert({
    where: { numberE164 },
    update: parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {},
    create: { numberE164, displayName: parsed.data.displayName },
  });

  return NextResponse.json({ contact });
}
