import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { InvalidPhotoError, photoStorageDir, processAgentPhoto, resolvePhotoPath } from "@/lib/agent-photo";

export const dynamic = "force-dynamic";

// POST /api/register/photo — multipart upload, one file field "photo".
// Validated and re-encoded by src/lib/agent-photo.ts (real image-format
// decode, not a trusted Content-Type header; EXIF stripped on write) —
// see that file's header for why. Replaces any previous photo for this
// user (old file removed) rather than accumulating orphans.
export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const form = await request.formData().catch(() => null);
  const file = form?.get("photo");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "No photo file provided (field name must be 'photo')." }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  let processed;
  try {
    processed = await processAgentPhoto(Buffer.from(arrayBuffer));
  } catch (err) {
    if (err instanceof InvalidPhotoError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const dir = path.resolve(photoStorageDir());
  const destPath = path.resolve(dir, processed.filename);
  await writeFile(destPath, processed.buffer);

  const previous = await db.user.findUnique({ where: { id: guard.session.user.id }, select: { photoPath: true } });
  await db.user.update({ where: { id: guard.session.user.id }, data: { photoPath: processed.filename } });

  if (previous?.photoPath && previous.photoPath !== processed.filename) {
    try {
      await unlink(resolvePhotoPath(previous.photoPath));
    } catch {
      // Best-effort cleanup of the replaced file — not worth failing the
      // request over, and the DB row (the thing that grants access) has
      // already moved on to the new file.
    }
  }

  return NextResponse.json({ ok: true, photoPath: processed.filename });
}
