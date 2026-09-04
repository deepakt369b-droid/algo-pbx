import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  extension: z.string().regex(/^\d{3,6}$/).nullable().optional(),
  phoneE164: z.string().regex(/^\+\d{6,15}$/).nullable().optional(),
  active: z.boolean().optional(),
});

// PATCH /api/admin/escalation-targets/[id] — edit or deactivate a manager
// (soft toggle via `active`, mirroring User.disabled's pattern) rather
// than only a hard delete, since a manager going on leave shouldn't lose
// their escalation history.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const target = await db.escalationTarget.update({ where: { id: params.id }, data: parsed.data }).catch(() => null);
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ target });
}

// DELETE /api/admin/escalation-targets/[id] — real hard delete, same as
// DELETE /api/dnc/[id]: a manager entry has no compliance-retention
// requirement forcing a soft-remove concept. EscalationAttempt rows keep
// their history regardless (no cascade delete on the target FK).
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  await db.escalationTarget.delete({ where: { id: params.id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
