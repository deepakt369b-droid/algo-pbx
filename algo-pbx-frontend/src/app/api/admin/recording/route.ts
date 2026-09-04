import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAdminSession, requireStaffSession } from "@/lib/auth-guard";
import type { TenantClient } from "@/lib/db-tenant";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// /api/admin/recording — the global call-recording kill switch and its
// mandatory "this call may be recorded" declaration toggle.
//
// Backing store: the "PbxRuntimeFlag" table (migration
// 20260901120000_add_pbx_runtime_flags), NOT "AppSetting" — AppSetting rows
// are AES-GCM encrypted and the Asterisk dialplan reads these two flags
// directly over ODBC (func_odbc.conf: RECORDING_ENABLED /
// RECORDING_ANNOUNCE_ENABLED), so they must be stored as a plain boolean.
// A write here takes effect on the next call with no Asterisk reload.
//
// Not a Prisma model (S2a owns schema.prisma this wave) — hence $queryRaw.

const RECORDING_KEY = "recording_enabled";
const ANNOUNCE_KEY = "recording_announcement_enabled";

type FlagRow = { key: string; enabled: boolean };

async function readFlags(db: TenantClient): Promise<{ recordingEnabled: boolean; announcementEnabled: boolean }> {
  const rows = await db.$queryRaw<FlagRow[]>`
    SELECT "key", "enabled" FROM "PbxRuntimeFlag" WHERE "key" IN (${RECORDING_KEY}, ${ANNOUNCE_KEY})
  `;
  const byKey = new Map(rows.map((r) => [r.key, r.enabled]));
  // Default true if a row is somehow missing — mirrors the dialplan's
  // fail-open stance: absent config must never mean "silently not recording"
  // or "recording without telling anyone".
  return {
    recordingEnabled: byKey.get(RECORDING_KEY) ?? true,
    announcementEnabled: byKey.get(ANNOUNCE_KEY) ?? true,
  };
}

async function writeFlag(db: TenantClient, key: string, enabled: boolean, actorId: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "PbxRuntimeFlag" ("key", "enabled", "updatedAt", "updatedById")
    VALUES (${key}, ${enabled}, CURRENT_TIMESTAMP, ${actorId})
    ON CONFLICT ("key")
    DO UPDATE SET "enabled" = EXCLUDED."enabled",
                 "updatedAt" = CURRENT_TIMESTAMP,
                 "updatedById" = EXCLUDED."updatedById"
  `;
}

// GET — staff (ADMIN or SUPERVISOR) may see the current state.
export const GET = withApiErrorHandler(async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  return NextResponse.json(await readFlags(guard.db));
});

const PostSchema = z
  .object({
    recordingEnabled: z.boolean().optional(),
    announcementEnabled: z.boolean().optional(),
  })
  .refine((v) => v.recordingEnabled !== undefined || v.announcementEnabled !== undefined, {
    message: "Provide recordingEnabled and/or announcementEnabled",
  });

// POST — ADMIN only (SUPERVISOR excluded): recording governance is an
// admin-level action, same bar as the settings route and the hard-delete route.
export const POST = withApiErrorHandler(async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const parsed = PostSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const current = await readFlags(db);
  const next = {
    recordingEnabled: parsed.data.recordingEnabled ?? current.recordingEnabled,
    announcementEnabled: parsed.data.announcementEnabled ?? current.announcementEnabled,
  };

  // Hard invariant: you may not record silently. If recording ends up on,
  // the declaration is forced on too — an explicit request to disable the
  // announcement while recording is on is rejected rather than quietly
  // ignored, so the UI never shows a state that can't exist.
  if (next.recordingEnabled && parsed.data.announcementEnabled === false) {
    return NextResponse.json(
      { error: "The recording declaration cannot be turned off while recording is on." },
      { status: 409 },
    );
  }
  if (next.recordingEnabled) next.announcementEnabled = true;

  const actorId = session.user.id;
  const changed: Record<string, boolean> = {};
  if (next.recordingEnabled !== current.recordingEnabled) {
    await writeFlag(db, RECORDING_KEY, next.recordingEnabled, actorId);
    changed.recordingEnabled = next.recordingEnabled;
  }
  if (next.announcementEnabled !== current.announcementEnabled) {
    await writeFlag(db, ANNOUNCE_KEY, next.announcementEnabled, actorId);
    changed.announcementEnabled = next.announcementEnabled;
  }

  if (Object.keys(changed).length > 0) {
    await db.auditLog.create({
      data: {
        action: "recording.toggle",
        actorId,
        targetId: RECORDING_KEY,
        metadata: changed as Prisma.InputJsonValue,
      } as unknown as Prisma.AuditLogUncheckedCreateInput,
    });
  }

  return NextResponse.json(next);
});
