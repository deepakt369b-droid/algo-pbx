import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

const PatchRoomSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  memberUserIds: z.array(z.string()).max(200).optional(),
});

// PATCH — rename and/or edit membership. Previously there was no way to
// edit a room at all; the only "edit" was delete-and-recreate, which lost
// the room's id (and anything that might reference it in future).
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const existing = await db.room.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = PatchRoomSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }
  if (!parsed.data.name && !parsed.data.memberUserIds) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const name = parsed.data.name ? parsed.data.name.replace(/\s+/g, " ") : undefined;

  try {
    const room = await db.room.update({
      where: { id: params.id },
      data: { ...(name ? { name } : {}), ...(parsed.data.memberUserIds ? { memberUserIds: parsed.data.memberUserIds } : {}) },
    });
    return NextResponse.json({ room });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: `A room named "${name}" already exists.` }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const existing = await db.room.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.room.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
