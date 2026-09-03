import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminSession, requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/gateway-sites — CRUD root for the OpenVPN-primary/
// Headscale-fallback/Tailscale-legacy connectivity page (/admin/connectivity).
// GET is staff-readable (ADMIN|SUPERVISOR), matching every other admin
// diagnostics surface; POST (creating a site) is ADMIN-only, matching the
// rest of this codebase's "reads are staff-wide, config changes are
// admin-only" convention (e.g. /api/admin/users).
export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const sites = await db.gatewaySite.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json({ sites });
}

// `name` becomes the OpenVPN client cert's CN and the client-config-dir
// filename (see pbx_configs/openvpn/bridge-watch.sh) — this regex is the
// exact SAFE_NAME_RE that script enforces server-side; validating it here
// too is the first line of defense, not a replacement for the bridge's own
// re-check (the bridge deliberately never trusts an upstream caller alone).
const NameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Use only letters, digits, hyphens, and underscores (max 64 chars) — this becomes the OpenVPN certificate name.");

const CreateSchema = z.object({
  name: NameSchema,
  gatewayLanIp: z.string().min(1).max(64),
});

export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await db.gatewaySite.findUnique({ where: { name: parsed.data.name } });
  if (existing) {
    return NextResponse.json({ error: `A site named "${parsed.data.name}" already exists.` }, { status: 409 });
  }

  // New sites start on the legacy transport (TAILSCALE) and UNKNOWN status —
  // a site only moves to OPENVPN/HEADSCALE once the operator actually runs
  // the cutover (Node G), never optimistically at creation time.
  const site = await db.gatewaySite.create({
    data: { name: parsed.data.name, gatewayLanIp: parsed.data.gatewayLanIp, transport: "TAILSCALE", status: "UNKNOWN" },
  });

  await db.auditLog.create({
    data: { action: "site.created", actorId: guard.session.user.id, targetId: site.id, metadata: { name: site.name, gatewayLanIp: site.gatewayLanIp } },
  });

  return NextResponse.json({ site }, { status: 201 });
}
