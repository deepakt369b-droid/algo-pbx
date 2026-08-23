import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";
import { getProvider } from "@/lib/messaging/registry";

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
    include: { pairedByAdmin: { select: { name: true, email: true } } },
  });
  return NextResponse.json({ instances });
}

const CreateSchema = z.object({
  label: z.string().min(1).max(100),
  simPort: z.number().int().min(1).max(4),
  provider: z.enum(["OPENWA", "META_CLOUD"]).default("OPENWA"),
});

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

  const instance = await db.waInstance.create({
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

  // Kick off pairing immediately (best-effort — the admin page polls
  // status/QR afterward regardless of whether this synchronous call
  // succeeds, since OpenWA's own pairing flow is inherently async).
  const provider = getProvider(instance.provider as "OPENWA" | "META_CLOUD");
  const pairing = provider.startPairing ? await provider.startPairing(instance.id).catch(() => null) : null;

  return NextResponse.json({ instance, pairing }, { status: 201 });
}
