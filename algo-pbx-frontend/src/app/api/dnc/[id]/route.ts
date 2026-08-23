import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// DELETE /api/dnc/[id] — staff-only removal. Unlike Phase D's planned
// recording retention (asymmetric hide vs. hard-delete), a DNC entry has no
// "soft remove" concept in the requirements — removing someone from the
// blocklist is a real, immediate, hard delete by design.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  await db.doNotCallEntry.delete({ where: { id: params.id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
