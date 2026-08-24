import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession, requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

const PatchSchema = z.union([
  z.object({ status: z.enum(["AVAILABLE", "BUSY", "BREAK", "OFFLINE"]) }),
  // Staff-only: attaches an existing orphan Extension (created via POST
  // /api/extensions with no user field) to a User. Without this there was
  // no way to link the two after creation — only the nested create inside
  // POST /api/admin/users ever set Extension.userId.
  z.object({ userId: z.string().min(1).nullable() }),
]);

// PATCH /api/extensions/1001 { status } — agent status persistence, OR
// { userId } — admin/supervisor linking. Authorization differs per shape:
// an AGENT may only patch their OWN extension's status; only staff may
// link/unlink a userId, and only staff may force another extension's
// status (e.g. a stuck agent to OFFLINE).
export async function PATCH(req: NextRequest, { params }: { params: { number: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const body = await req.json();
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const extension = await db.extension.findUnique({ where: { number: params.number } });
  if (!extension) {
    return NextResponse.json({ error: "Extension not found" }, { status: 404 });
  }

  if ("userId" in parsed.data) {
    const staffGuard = await requireStaffSession();
    if ("response" in staffGuard) return staffGuard.response;

    if (parsed.data.userId) {
      const user = await db.user.findUnique({ where: { id: parsed.data.userId } });
      if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
      const conflict = await db.extension.findUnique({ where: { userId: parsed.data.userId } });
      if (conflict && conflict.number !== extension.number) {
        return NextResponse.json({ error: `${user.name} already has extension ${conflict.number}.` }, { status: 409 });
      }
    }

    const updated = await db.extension.update({
      where: { number: params.number },
      data: { userId: parsed.data.userId },
    });
    return NextResponse.json({ extension: updated });
  }

  const isOwnExtension = session.user.extension === params.number;
  const isStaff = session.user.role === "ADMIN" || session.user.role === "SUPERVISOR";
  if (!isOwnExtension && !isStaff) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const updated = await db.extension.update({
    where: { number: params.number },
    data: { status: parsed.data.status, lastSeenAt: new Date() },
  });

  return NextResponse.json({ extension: updated });
}
