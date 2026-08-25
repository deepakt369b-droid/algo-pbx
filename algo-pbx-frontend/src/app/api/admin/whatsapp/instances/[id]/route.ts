import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";
import { getProvider } from "@/lib/messaging/registry";
import { deleteSession, forceKillSession, startSession, stopSession } from "@/lib/messaging/openwa-client";
import { ProviderHttpError } from "@/lib/messaging/http";

export const dynamic = "force-dynamic";

// PATCH /api/admin/whatsapp/instances/[id] — refresh status, or logout /
// re-pair / force-kill / assign. Admin-only, no exceptions: this is the
// sole route capable of terminating an agent's WhatsApp session, matching
// the requirement that agents see a connected session with literally no
// logout control in their own UI, backed by a route that would refuse
// them even if one were forged client-side.
const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh") }),
  z.object({ action: z.literal("logout") }),
  z.object({ action: z.literal("repair") }),
  z.object({ action: z.literal("forceKill") }),
  z.object({ action: z.literal("assign"), userId: z.string().min(1) }),
  z.object({ action: z.literal("unassign") }),
]);

function errorMessage(err: unknown): string {
  if (err instanceof ProviderHttpError) return `${err.status}: ${err.body || err.message}`;
  return err instanceof Error ? err.message : "Unknown error";
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const instance = await db.waInstance.findUnique({ where: { id: params.id } });
  if (!instance) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });

  if (parsed.data.action === "assign") {
    const conflict = await db.waInstance.findUnique({ where: { assignedUserId: parsed.data.userId } });
    if (conflict && conflict.id !== instance.id) {
      return NextResponse.json({ error: "That agent already has a SIM port assigned." }, { status: 409 });
    }
    const updated = await db.waInstance.update({ where: { id: instance.id }, data: { assignedUserId: parsed.data.userId } });
    await db.auditLog.create({
      data: { action: "wa_instance.assign", actorId: guard.session.user.id, targetId: instance.id, metadata: { userId: parsed.data.userId } },
    });
    return NextResponse.json({ instance: updated });
  }

  if (parsed.data.action === "unassign") {
    const updated = await db.waInstance.update({ where: { id: instance.id }, data: { assignedUserId: null } });
    await db.auditLog.create({
      data: { action: "wa_instance.unassign", actorId: guard.session.user.id, targetId: instance.id, metadata: {} },
    });
    return NextResponse.json({ instance: updated });
  }

  const provider = getProvider(instance.provider as "OPENWA" | "META_CLOUD" | "DINSTAR_SMS");

  if (parsed.data.action === "logout") {
    if (!provider.logout) {
      return NextResponse.json({ error: "This provider does not support logout." }, { status: 400 });
    }
    try {
      await provider.logout(instance.openwaSessionId ?? instance.id);
    } catch (err) {
      const message = errorMessage(err);
      await db.waInstance.update({ where: { id: instance.id }, data: { lastError: message } }).catch(() => undefined);
      return NextResponse.json({ error: `Logout failed: ${message}` }, { status: 502 });
    }
    const updated = await db.waInstance.update({
      where: { id: instance.id },
      data: { status: "LOGGED_OUT", lastError: null, lastQrCode: null, lastQrAt: null, pairingCode: null, pairingCodeAt: null },
    });
    await db.auditLog.create({
      data: { action: "wa_instance.logout", actorId: guard.session.user.id, targetId: instance.id, metadata: {} },
    });
    return NextResponse.json({ instance: updated });
  }

  if (parsed.data.action === "forceKill") {
    if (instance.provider !== "OPENWA" || !instance.openwaSessionId) {
      return NextResponse.json({ error: "This provider does not support force-kill." }, { status: 400 });
    }
    try {
      await forceKillSession(instance.openwaSessionId);
    } catch (err) {
      return NextResponse.json({ error: `Force-kill failed: ${errorMessage(err)}` }, { status: 502 });
    }
    const updated = await db.waInstance.update({
      where: { id: instance.id },
      data: { status: "DISCONNECTED", lastError: "Force-killed by admin." },
    });
    await db.auditLog.create({
      data: { action: "wa_instance.force_kill", actorId: guard.session.user.id, targetId: instance.id, metadata: {} },
    });
    return NextResponse.json({ instance: updated });
  }

  if (parsed.data.action === "repair") {
    if (!provider.startPairing) {
      return NextResponse.json({ error: "This provider does not support pairing." }, { status: 400 });
    }
    try {
      if (instance.provider === "OPENWA" && instance.openwaSessionId) {
        await stopSession(instance.openwaSessionId).catch(() => undefined);
        await startSession(instance.openwaSessionId);
      }
      const pairing = await provider.startPairing(instance.openwaSessionId ?? instance.id);
      const updated = await db.waInstance.update({
        where: { id: instance.id },
        data: {
          status: pairing.status,
          lastError: null,
          lastQrCode: pairing.qrCode ?? null,
          lastQrAt: pairing.qrCode ? new Date() : null,
          pairingCode: null,
          pairingCodeAt: null,
        },
      });
      await db.auditLog.create({
        data: { action: "wa_instance.repair", actorId: guard.session.user.id, targetId: instance.id, metadata: {} },
      });
      return NextResponse.json({ instance: updated, pairing });
    } catch (err) {
      const message = errorMessage(err);
      const updated = await db.waInstance.update({ where: { id: instance.id }, data: { lastError: message } });
      return NextResponse.json({ instance: updated, error: `Re-pair failed: ${message}` }, { status: 502 });
    }
  }

  // refresh
  const status = await provider.getStatus(instance.openwaSessionId ?? instance.id);
  const updated = await db.waInstance.update({
    where: { id: instance.id },
    data: {
      status: status.status,
      phoneE164: status.phoneE164 ?? instance.phoneE164,
      lastConnectedAt: status.connected ? new Date() : instance.lastConnectedAt,
      lastStatusAt: new Date(),
    },
  });
  return NextResponse.json({ instance: updated, status });
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const instance = await db.waInstance.findUnique({ where: { id: params.id } });
  if (!instance) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const force = new URL(request.url).searchParams.get("force") === "1";

  if (instance.provider === "OPENWA" && instance.openwaSessionId) {
    try {
      await deleteSession(instance.openwaSessionId);
    } catch (err) {
      if (!force) {
        return NextResponse.json(
          { error: `Could not delete the OpenWA session: ${errorMessage(err)}. Retry, or force-remove to delete our record anyway.` },
          { status: 502 }
        );
      }
      // force=1: proceed with the local delete even though the sidecar
      // session may be left orphaned — logged so it's not silently lost.
      await db.auditLog.create({
        data: {
          action: "wa_instance.force_remove_orphan",
          actorId: guard.session.user.id,
          targetId: instance.id,
          metadata: { openwaSessionId: instance.openwaSessionId, error: errorMessage(err) },
        },
      });
    }
  }

  await db.waInstance.delete({ where: { id: instance.id } });
  await db.auditLog.create({
    data: { action: "wa_instance.remove", actorId: guard.session.user.id, targetId: instance.id, metadata: { label: instance.label, force } },
  });

  return NextResponse.json({ ok: true });
}
