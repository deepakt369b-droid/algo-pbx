import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// DELETE /api/admin/ai/providers/[id] — hard delete. Unlike ApiKey (revoked,
// not deleted, for audit-trail reasons), a provider credential holds a live
// secret and the admin explicitly asked to remove it; keep it simple.
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const deleted = await db.aiProviderCredential.delete({ where: { id: params.id } }).catch(() => null);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
