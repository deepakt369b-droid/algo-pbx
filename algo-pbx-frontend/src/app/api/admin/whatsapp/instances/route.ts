import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
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
  provider: z.enum(["OPENWA", "META_CLOUD"]).default("OPENWA"),
});

function errorMessage(err: unknown): string {
  if (err instanceof ProviderHttpError) return `OpenWA ${err.status}: ${err.body || err.message}`;
  return err instanceof Error ? err.message : "Unknown error";
}

export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const existingOnPort = await db.waInstance.findUnique({ where: { simPort: parsed.data.simPort } });
  if (existingOnPort) {
    return NextResponse.json({ error: `SIM port ${parsed.data.simPort} already has an instance.` }, { status: 409 });
  }

  let instance = await db.waInstance.create({
    data: {
      label: parsed.data.label,
      simPort: parsed.data.simPort,
      provider: parsed.data.provider,
      status: "PAIRING",
      pairedByAdminId: guard.session.user.id,
    },
  });

  await db.auditLog.create({
    data: {
      action: "wa_instance.pair",
      actorId: guard.session.user.id,
      targetId: instance.id,
      metadata: { label: instance.label, simPort: instance.simPort, provider: instance.provider },
    },
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
