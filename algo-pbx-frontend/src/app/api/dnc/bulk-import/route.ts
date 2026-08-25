import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// POST /api/dnc/bulk-import — one number per line (CSV's first column also
// works fine, since anything after the first comma on a line is ignored).
// Reports per-line success/failure rather than failing the whole batch on
// one bad row — a compliance import with 900 good numbers and 3 typos
// should still import the 900.
// text length was previously uncapped — a staff-authenticated caller (any
// SUPERVISOR/ADMIN, or an admin session compromised via XSS) could submit
// an arbitrarily large body, and the handler below performs one sequential
// upsert per line with no limit either. 2MB / ~100k lines is generous for
// any real DNC list while making a pathological submission a bounded,
// not-quite-instant cost instead of an unbounded one.
const MAX_BULK_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_BULK_LINES = 100_000;

const BulkImportSchema = z.object({
  text: z.string().min(1).max(MAX_BULK_TEXT_BYTES),
  reason: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const body = await req.json();
  const parsed = BulkImportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const lines = parsed.data.text
    .split(/\r?\n/)
    .map((line) => line.split(",")[0].trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_BULK_LINES);

  const results = { imported: 0, skipped: [] as string[] };

  for (const line of lines) {
    const numberE164 = normalizeToE164(line);
    if (!numberE164) {
      results.skipped.push(line);
      continue;
    }
    await db.doNotCallEntry.upsert({
      where: { numberE164 },
      create: {
        numberE164,
        reason: parsed.data.reason,
        source: "bulk_import",
        addedById: guard.session.user.id,
      },
      update: {},
    });
    results.imported++;
  }

  return NextResponse.json(results, { status: 201 });
}
