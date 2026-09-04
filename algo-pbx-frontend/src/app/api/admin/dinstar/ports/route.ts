import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";
import { assertProbeableHost } from "@/lib/dinstar-discovery";
import { applyStandardPortConfig } from "@/lib/dinstar/port-config";
import { getSetting, setSetting } from "@/lib/settings/service";

export const dynamic = "force-dynamic";

// POST /api/admin/dinstar/ports — "Apply standard SIM config", the
// concrete answer to "insert a SIM and it just works" without touching
// the Dinstar's own web UI. Writes a known-good hotline (matching
// pbx_configs/extensions.conf's [from-dinstar] `s` handler) to every port
// with real modem hardware on this UC2000-VE unit (0-3 — see
// port-config.ts's own comment).
//
// WRITE-ONLY, deliberately: see src/lib/dinstar/device-client.ts's header
// for why this device's real port values cannot be read back server-side.
// Success here means "the gateway accepted the write and redirected to
// its own success page" — not a verified read-back. The existing
// /admin/dinstar wizard's port list (parsePorts/probeDinstarCredentials,
// a DIFFERENT API surface) still shows live SIM presence; this route does
// not attempt to duplicate that.
const ApplySchema = z.object({
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  // "s" also works (extensions.conf defines that extension literally);
  // "100" is the value already live on this deployment and is numeric,
  // which prior sessions found more reliably accepted by the firmware's
  // own field validation.
  hotline: z.string().regex(/^[A-Za-z0-9]{1,20}$/).default("100"),
});

export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const parsed = ApplySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const rawHost = await getSetting("DINSTAR_LAN_IP");
  if (!rawHost) {
    return NextResponse.json({ error: "No Dinstar gateway address configured. Run the /admin/dinstar setup wizard first." }, { status: 409 });
  }
  let host: string;
  try {
    host = assertProbeableHost(rawHost);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid stored gateway address." }, { status: 500 });
  }

  // Credentials: explicit request body wins (first-time setup, or a
  // deliberate change); otherwise fall back to the stored web-UI
  // credential — deliberately DINSTAR_WEBUI_* here, NOT
  // DINSTAR_SMS_USERNAME/PASSWORD, which authenticate a different API on
  // this device entirely (see settings/schema.ts's comment on why these
  // are kept separate).
  const username = parsed.data.username ?? (await getSetting("DINSTAR_WEBUI_USERNAME"));
  const password = parsed.data.password ?? (await getSetting("DINSTAR_WEBUI_PASSWORD"));
  if (!username || !password) {
    return NextResponse.json({ error: "No gateway web UI credentials configured. Provide username/password once to store them." }, { status: 409 });
  }

  const result = await applyStandardPortConfig(host, username, password, parsed.data.hotline);

  if (result.ok && parsed.data.username && parsed.data.password) {
    // Only persist credentials AFTER a successful login+write — never
    // store an unverified guess, same principle the existing
    // /admin/dinstar apply route already follows for its own credentials.
    await setSetting("DINSTAR_WEBUI_USERNAME", parsed.data.username, session.user.id);
    await setSetting("DINSTAR_WEBUI_PASSWORD", parsed.data.password, session.user.id);
  }

  await db.auditLog.create({
    data: {
      action: "dinstar.ports_configured",
      actorId: session.user.id,
      targetId: host,
      metadata: { hotline: parsed.data.hotline, ok: result.ok, ports: result.ports, error: result.error },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Could not apply the configuration." }, { status: 502 });
  }

  return NextResponse.json({ ok: true, ports: result.ports });
}
