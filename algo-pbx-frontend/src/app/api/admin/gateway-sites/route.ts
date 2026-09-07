import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAdminSession, requireStaffSession } from "@/lib/auth-guard";
import { gatewayTunnelIp } from "@/lib/platform/subnet";
import { unsafeGlobalDb } from "@/lib/db";

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
  const { session, db } = guard;

  const sites = await db.gatewaySite.findMany({ orderBy: { name: "asc" } });

  // `Tenant` isn't a TENANT_SCOPED_MODELS entry, so this reads it directly —
  // scoped to the CALLER's OWN tenant only (session.user.tenantId, never a
  // request-supplied value), the same read pattern the POST handler below
  // already uses for `tunnelSubnetIndex`. Surfaced here so the connectivity
  // page can render the per-tenant failover toggle without a second route.
  const tenant = await unsafeGlobalDb.tenant.findUnique({
    where: { id: session.user.tenantId },
    select: { failoverEnabled: true },
  });

  return NextResponse.json({ sites, failoverEnabled: tenant?.failoverEnabled ?? false });
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
  // Optional — defaults to TAILSCALE for backward compat with the
  // existing wizard (add-site-wizard.tsx doesn't send this field at all
  // today), matching the pre-W2 hardcoded behavior exactly for any
  // caller that doesn't opt in.
  transport: z.enum(["TAILSCALE", "OPENVPN", "HEADSCALE", "WIREGUARD"]).optional(),
});

export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await db.gatewaySite.findUnique({ where: { name: parsed.data.name } });
  if (existing) {
    return NextResponse.json({ error: `A site named "${parsed.data.name}" already exists.` }, { status: 409 });
  }

  // Prefills `tunnelIp` from the tenant's own pooled-subnet allocation
  // (src/lib/platform/subnet.ts's `gatewayTunnelIp()`, the ".10" address
  // convention already documented there) when the tenant has a
  // `tunnelSubnetIndex` — most tenants provisioned since the pooled-stack
  // migration do. Left null, exactly as before, for a tenant with no
  // subnet index (e.g. the pre-pooling legacy tenant), so the operator
  // still sets it by hand via PATCH.
  // `Tenant` itself is deliberately NOT on TENANT_SCOPED_MODELS (it's the
  // tenancy boundary, not tenant-owned data — see scope-rules.ts's own
  // list) — a tenant-scoped `db.tenant.*` call throws "not on the
  // tenant-scoped model list". This is a plain by-id lookup of the
  // CALLER's OWN tenant (session.user.tenantId, never a value taken from
  // the request), so reading it via unsafeGlobalDb here is safe and not a
  // cross-tenant read.
  const tenant = await unsafeGlobalDb.tenant.findUnique({ where: { id: session.user.tenantId }, select: { tunnelSubnetIndex: true } });
  const tunnelIp = tenant?.tunnelSubnetIndex != null ? gatewayTunnelIp(tenant.tunnelSubnetIndex) : null;

  // New sites start UNKNOWN status regardless of transport — a site only
  // moves to a monitored UP/DOWN/DEGRADED state once the connectivity
  // poller actually checks it, never optimistically at creation time.
  // Transport defaults to TAILSCALE (legacy, unmonitored) unless the
  // caller explicitly asks for something else.
  const site = await db.gatewaySite.create({
    data: {
      name: parsed.data.name,
      gatewayLanIp: parsed.data.gatewayLanIp,
      transport: parsed.data.transport ?? "TAILSCALE",
      status: "UNKNOWN",
      tunnelIp,
    } as unknown as Prisma.GatewaySiteUncheckedCreateInput,
  });

  await db.auditLog.create({
    data: {
      action: "site.created",
      actorId: session.user.id,
      targetId: site.id,
      metadata: { name: site.name, gatewayLanIp: site.gatewayLanIp, transport: site.transport, tunnelIp: site.tunnelIp },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  return NextResponse.json({ site }, { status: 201 });
}
