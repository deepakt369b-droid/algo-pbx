import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// DELETE /api/admin/caller-routing/[id] — hard delete, no soft-remove
// concept, same as api/dnc/[id]/route.ts. `db` is tenant-scoped, so an id
// belonging to another tenant simply matches nothing.
export const DELETE = withApiErrorHandler(async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  await db.callerRoutingRule.delete({ where: { id: params.id } }).catch(() => null);
  return NextResponse.json({ ok: true });
});
