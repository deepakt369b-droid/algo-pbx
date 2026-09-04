import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";
import { setSetting } from "@/lib/settings/service";
import { probeDinstarCredentials, assertProbeableHost } from "@/lib/dinstar-discovery";
import { provisionDinstarConfig } from "@/lib/dinstar-provision";
import { DinstarApplySchema } from "@/lib/dinstar-apply-schema";

export const dynamic = "force-dynamic";

// POST /api/admin/dinstar/apply — the wizard's final step. Re-probes
// (never trust stale client state for a credential/auth-style decision),
// persists the settings, and optionally writes + reloads the Asterisk
// trunk config. Every step's own result is returned so the wizard can
// show exactly what succeeded and what needs a manual follow-up, rather
// than one boolean "done".
export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const parsed = DinstarApplySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  const { username, password, writeAsteriskConfig, sipPort } = parsed.data;

  let host: string;
  try {
    host = assertProbeableHost(parsed.data.host);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid host" }, { status: 400 });
  }

  const probe = await probeDinstarCredentials(host, username, password);
  if (!probe.authenticated || !probe.authStyle) {
    return NextResponse.json({ error: probe.error ?? "Could not authenticate against the gateway.", probe }, { status: 400 });
  }

  await setSetting("DINSTAR_LAN_IP", host, session.user.id);
  await setSetting("DINSTAR_SMS_USERNAME", username, session.user.id);
  await setSetting("DINSTAR_SMS_PASSWORD", password, session.user.id);
  await setSetting("DINSTAR_AUTH_STYLE", probe.authStyle, session.user.id);
  await setSetting("DINSTAR_SIP_PORT", sipPort, session.user.id);

  await db.auditLog.create({
    data: {
      action: "dinstar.settings_applied",
      actorId: session.user.id,
      targetId: host,
      metadata: { host, authStyle: probe.authStyle, ports: probe.ports.length },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  let asterisk: { attempted: boolean; written?: boolean; reloaded?: boolean; verified?: boolean; error?: string } = { attempted: false };
  if (writeAsteriskConfig) {
    const result = await provisionDinstarConfig(host);
    asterisk = { attempted: true, ...result };
    await db.auditLog.create({
      data: {
        action: "dinstar.asterisk_provisioned",
        actorId: session.user.id,
        targetId: host,
        metadata: { ...result },
      } as unknown as Prisma.AuditLogUncheckedCreateInput,
    });
  }

  return NextResponse.json({ probe, asterisk });
}
