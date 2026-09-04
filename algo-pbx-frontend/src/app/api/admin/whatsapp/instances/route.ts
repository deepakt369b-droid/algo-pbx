import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";
import { createSession, registerSessionWebhook, sessionNameFor, startSession } from "@/lib/messaging/openwa-client";
import { getSetting } from "@/lib/settings/service";
import { ProviderHttpError } from "@/lib/messaging/http";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/whatsapp/instances — admin-only WhatsApp
// provisioning. Pairing, re-pairing, and (in the [id] route) logout are
// exclusively reachable here (requireAdminSession) — there is no
// agent-facing route anywhere that can trigger any of these, per the hard
// product requirement that only an admin may log an agent's WhatsApp
// session out.
export async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const instances = await db.waInstance.findMany({
    orderBy: { simPort: "asc" },
    include: {
      pairedByAdmin: { select: { name: true, email: true } },
      assignedUser: { select: { id: true, name: true, email: true } },
    },
  });
  return NextResponse.json({ instances });
}

const CreateSchema = z.object({
  label: z.string().min(1).max(100),
  simPort: z.number().int().min(1).max(4),
  // NONE = "calls-only" — reserve this port for an agent with no
  // messaging identity attached at all (see the schema comment on
  // MessageProviderKind.NONE for why this needs to be a distinct kind
  // rather than reusing META_CLOUD as a workaround).
  provider: z.enum(["OPENWA", "META_CLOUD", "NONE"]).default("OPENWA"),
});

function errorMessage(err: unknown): string {
  if (err instanceof ProviderHttpError) return `OpenWA ${err.status}: ${err.body || err.message}`;
  return err instanceof Error ? err.message : "Unknown error";
}

export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  // findFirst, not findUnique — simPort alone is no longer a unique key by
  // itself (it's `@@unique([tenantId, simPort])` now, plan §1); within this
  // tenant's own scoped client it's effectively unique.
  const existingOnPort = await db.waInstance.findFirst({ where: { simPort: parsed.data.simPort } });
  if (existingOnPort) {
    return NextResponse.json({ error: `SIM port ${parsed.data.simPort} already has an instance.` }, { status: 409 });
  }

  // No `tenantId` in either literal below — force-injected at runtime by
  // the TenantClient extension (see src/lib/crm/activity.ts's comment on
  // the same pattern).
  let instance = await db.waInstance.create({
    data: {
      label: parsed.data.label,
      simPort: parsed.data.simPort,
      provider: parsed.data.provider,
      // A calls-only port never pairs — "PAIRING" forever would be a
      // permanently misleading status for something that was never going
      // to connect at all.
      status: parsed.data.provider === "NONE" ? "DISCONNECTED" : "PAIRING",
      pairedByAdminId: guard.session.user.id,
    } as unknown as Prisma.WaInstanceUncheckedCreateInput,
  });

  await db.auditLog.create({
    data: {
      action: "wa_instance.pair",
      actorId: guard.session.user.id,
      targetId: instance.id,
      metadata: { label: instance.label, simPort: instance.simPort, provider: instance.provider },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  // OpenWA needs a real session created (and started) before the admin UI
  // has anything to poll a QR/pairing-code from. META_CLOUD has no
  // equivalent lifecycle — provider.startPairing is optional precisely
  // for that case (see MessageProvider's contract), so this whole block
  // only runs for OPENWA.
  if (parsed.data.provider === "OPENWA") {
    const sessionName = sessionNameFor(instance);
    try {
      const session = await createSession({ name: sessionName });
      instance = await db.waInstance.update({
        where: { id: instance.id },
        data: { sessionName, openwaSessionId: session.id },
      });

      const [webhookUrl, webhookSecret] = await Promise.all([
        getSetting("OPENWA_WEBHOOK_URL"),
        getSetting("OPENWA_WEBHOOK_SECRET"),
      ]);
      if (webhookUrl) {
        await registerSessionWebhook(session.id, { url: webhookUrl, secret: webhookSecret || undefined });
        instance = await db.waInstance.update({ where: { id: instance.id }, data: { webhookRegisteredAt: new Date() } });
      }

      await startSession(session.id);
    } catch (err) {
      const message = errorMessage(err);
      instance = await db.waInstance.update({
        where: { id: instance.id },
        data: { status: "DISCONNECTED", lastError: message },
      });
      return NextResponse.json(
        { instance, error: `Could not start WhatsApp pairing: ${message}` },
        { status: 502 }
      );
    }
  }

  return NextResponse.json({ instance }, { status: 201 });
}
