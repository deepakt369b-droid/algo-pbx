import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

const PatchStatusSchema = z.object({
  status: z.enum(["AVAILABLE", "BUSY", "BREAK", "OFFLINE"]),
});

// PATCH /api/extensions/1001 { status: "BUSY" } — agent status persistence.
// Authorization: an AGENT may only patch their own extension (the one on
// their session); ADMIN/SUPERVISOR may patch any extension (e.g. forcing a
// stuck agent to OFFLINE). This is a stricter check than requireStaffSession
// allows for, hence requireSession() + a manual role/ownership check here
// instead.
export async function PATCH(req: NextRequest, { params }: { params: { number: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const isOwnExtension = session.user.extension === params.number;
  const isStaff = session.user.role === "ADMIN" || session.user.role === "SUPERVISOR";
  if (!isOwnExtension && !isStaff) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const parsed = PatchStatusSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const extension = await db.extension.findUnique({ where: { number: params.number } });
  if (!extension) {
    return NextResponse.json({ error: "Extension not found" }, { status: 404 });
  }

  const updated = await db.extension.update({
    where: { number: params.number },
    data: { status: parsed.data.status, lastSeenAt: new Date() },
  });

  return NextResponse.json({ extension: updated });
}
