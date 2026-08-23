import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  await db.room.delete({ where: { id: params.id } }).catch(() => undefined);
  return NextResponse.json({ ok: true });
}
