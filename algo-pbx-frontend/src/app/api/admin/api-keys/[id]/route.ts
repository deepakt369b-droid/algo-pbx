import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// DELETE /api/admin/api-keys/[id] — revoke, not delete. Soft revocation
// (revokedAt timestamp) so an audit trail of what a key touched survives
// it being turned off — same reasoning as the ApiKey model's own comment
// in schema.prisma.
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const key = await db.apiKey.update({
    where: { id: params.id },
    data: { revokedAt: new Date() },
  }).catch(() => null);

  if (!key) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.auditLog.create({
    data: { action: "api_key.revoke", actorId: guard.session.user.id, targetId: key.id, metadata: {} },
  });

  return NextResponse.json({ ok: true });
}
