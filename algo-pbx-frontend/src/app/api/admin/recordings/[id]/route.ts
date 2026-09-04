import { unlink } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// DELETE /api/admin/recordings/[id] — ADMIN only (not SUPERVISOR), a
// SEPARATE route from POST /api/recordings/[id]/hide specifically so an
// agent-facing "hide" and a real, permanent, file-deleting hard-delete can
// never be confused or accidentally merged into one code path. This is the
// one place in the whole recording-retention feature that actually removes
// data — everything else (agent hide, staff viewing) is non-destructive.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const recording = await db.recording.findUnique({ where: { id: params.id } });
  if (!recording) {
    return NextResponse.json({ error: "Recording not found" }, { status: 404 });
  }

  // Audit log written BEFORE the delete, so the audit trail survives even
  // if the DB delete or file unlink below fails partway through.
  await db.auditLog.create({
    data: {
      action: "recording.hard_delete",
      actorId: session.user.id,
      targetId: recording.id,
      metadata: { filePath: recording.filePath, cdrId: recording.cdrId },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  await db.recording.delete({ where: { id: params.id } });

  const dir = path.resolve(process.env.RECORDINGS_DIR || "/recordings");
  const filePath = path.resolve(dir, recording.filePath);
  if (filePath.startsWith(dir + path.sep)) {
    // Best-effort — the DB row (the thing that actually grants access) is
    // already gone, so a failed unlink is not a reason to fail this
    // request or leave the DB row in place. It WAS, however, previously a
    // silent failure with no trace anywhere: the ./recordings mount used
    // to be read-only in docker-compose.yml (fixed alongside this), so
    // every hard-delete unlink here failed with EROFS and nothing ever
    // recorded that the audio file was orphaned on disk — a
    // compliance-sensitive artifact quietly piling up forever with no way
    // to find it again. Now audit-logged on failure so an admin can
    // actually locate and clean these up.
    await unlink(filePath).catch(async (err) => {
      await db.auditLog.create({
        data: {
          action: "recording.hard_delete.unlink_failed",
          actorId: session.user.id,
          targetId: recording.id,
          metadata: { filePath: recording.filePath, error: err instanceof Error ? err.message : String(err) },
        } as unknown as Prisma.AuditLogUncheckedCreateInput,
      });
    });
  }

  return NextResponse.json({ ok: true });
}
