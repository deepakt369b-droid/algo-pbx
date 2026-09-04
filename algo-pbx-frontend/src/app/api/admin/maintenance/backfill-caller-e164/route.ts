import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// POST /api/admin/maintenance/backfill-caller-e164 — one-time (but
// idempotent, safe to re-run) backfill for CallDetailRecord.callerNumberE164
// (P2, LLM.md §28/29). Admin-only, no cron secret path like
// maintenance/prune's — this is a single historical-data fix, not an
// ongoing job; every future CDR row gets callerNumberE164 written at
// ingest time by the CDR listener instead (a separate change, not this
// route). Only touches rows where the column is still NULL, so re-running
// after a partial failure or after more CDRs land is always safe.
export async function POST() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const rows = await db.callDetailRecord.findMany({
    where: { callerNumberE164: null },
    select: { id: true, callerNumber: true },
  });

  let updated = 0;
  let unparsed = 0;
  for (const row of rows) {
    const e164 = normalizeToE164(row.callerNumber);
    if (!e164) {
      unparsed++;
      continue;
    }
    await db.callDetailRecord.update({ where: { id: row.id }, data: { callerNumberE164: e164 } });
    updated++;
  }

  return NextResponse.json({ candidates: rows.length, updated, unparsed });
}
