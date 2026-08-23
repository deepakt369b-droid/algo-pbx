import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";
import { getProvider } from "@/lib/messaging/registry";

export const dynamic = "force-dynamic";

// PATCH /api/admin/whatsapp/instances/[id] — refresh status, or logout /
// re-pair. Admin-only, no exceptions: this is the sole route capable of
// terminating an agent's WhatsApp session, matching the requirement that
// agents see a connected session with literally no logout control in
// their own UI, backed by a route that would refuse them even if one were
// forged client-side.
const ActionSchema = z.object({
  action: z.enum(["refresh", "logout", "repair"]),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const instance = await db.waInstance.findUnique({ where: { id: params.id } });
  if (!instance) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const provider = getProvider(instance.provider as "OPENWA" | "META_CLOUD" | "DINSTAR_SMS");

  if (parsed.data.action === "logout") {
    if (!provider.logout) {
      return NextResponse.json({ error: "This provider does not support logout." }, { status: 400 });
    }
    await provider.logout(instance.id);
    const updated = await db.waInstance.update({
      where: { id: instance.id },
      data: { status: "LOGGED_OUT" },
    });
    await db.auditLog.create({
      data: { action: "wa_instance.logout", actorId: guard.session.user.id, targetId: instance.id, metadata: {} },
    });
    return NextResponse.json({ instance: updated });
  }

  if (parsed.data.action === "repair") {
    if (!provider.startPairing) {
      return NextResponse.json({ error: "This provider does not support pairing." }, { status: 400 });
    }
    const pairing = await provider.startPairing(instance.id);
    const updated = await db.waInstance.update({
      where: { id: instance.id },
      data: { status: pairing.status },
    });
    await db.auditLog.create({
      data: { action: "wa_instance.repair", actorId: guard.session.user.id, targetId: instance.id, metadata: {} },
    });
    return NextResponse.json({ instance: updated, pairing });
  }

  // refresh
  const status = await provider.getStatus(instance.id);
  const updated = await db.waInstance.update({
    where: { id: instance.id },
    data: {
      status: status.status,
      phoneE164: status.phoneE164 ?? instance.phoneE164,
      lastConnectedAt: status.connected ? new Date() : instance.lastConnectedAt,
    },
  });
  return NextResponse.json({ instance: updated, status });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const instance = await db.waInstance.findUnique({ where: { id: params.id } });
  if (!instance) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const provider = getProvider(instance.provider as "OPENWA" | "META_CLOUD" | "DINSTAR_SMS");
  if (provider.logout) await provider.logout(instance.id).catch(() => undefined);

  await db.waInstance.delete({ where: { id: instance.id } });
  await db.auditLog.create({
    data: { action: "wa_instance.remove", actorId: guard.session.user.id, targetId: instance.id, metadata: { label: instance.label } },
  });

  return NextResponse.json({ ok: true });
}
