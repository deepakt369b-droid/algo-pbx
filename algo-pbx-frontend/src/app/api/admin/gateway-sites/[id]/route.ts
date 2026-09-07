import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAdminSession, requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const site = await db.gatewaySite.findUnique({ where: { id: params.id } });
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ site });
}

// Only the fields an operator edits after creation — `name` is NOT
// patchable here (it's the OpenVPN cert CN; renaming a site after its
// client cert has been issued would desync the two, see
// pbx_configs/openvpn/bridge-watch.sh's contract). Delete-and-recreate is
// the correct way to rename a site.
const PatchSchema = z
  .object({
    gatewayLanIp: z.string().min(1).max(64).optional(),
    tunnelIp: z.string().max(64).nullable().optional(),
    // WIREGUARD added (W2 — connectivity plan §3.2); `z.enum` here is a
    // second, deliberate re-check of the same `SiteTransport` values the
    // Prisma column itself enforces — a bad string is a 400 from this
    // route, not a 500 from a failed Prisma write.
    transport: z.enum(["TAILSCALE", "OPENVPN", "HEADSCALE", "WIREGUARD"]).optional(),
    // `status` and `lastHandshakeAt` are deliberately NOT patchable here —
    // they must only ever be written by the connectivity-check poller
    // (src/app/api/admin/gateway-sites/connectivity-check/route.ts, via
    // unsafeGlobalDb.gatewaySite.update directly, not this route) after an
    // actual transport probe. Letting an admin set these directly would let
    // a site "claim" to be UP with a fresh handshake without ever having
    // been probed as such — and for transports whose probe can return
    // UNKNOWN (TAILSCALE always; HEADSCALE with no API key configured),
    // the poller skips overwriting status on UNKNOWN, so a manually-set
    // UP would never self-correct and could look like a valid failover
    // candidate indefinitely. `lastReachableAt` has no such consequence
    // (nothing selects on it) and stays admin-patchable.
    headscaleNodeKey: z.string().max(200).nullable().optional(),
    lastReachableAt: z.string().datetime({ offset: true }).nullable().optional(),
    // W2 — priority (lower wins, W3's primary-selection input) and enabled
    // (owner/admin kill switch independent of connectivity status).
    priority: z.number().int().min(1).max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "No fields to update" });

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const existing = await db.gatewaySite.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const { lastReachableAt, ...rest } = parsed.data;
  const site = await db.gatewaySite.update({
    where: { id: params.id },
    data: {
      ...rest,
      ...(lastReachableAt !== undefined ? { lastReachableAt: lastReachableAt ? new Date(lastReachableAt) : null } : {}),
    },
  });

  await db.auditLog.create({
    data: { action: "site.updated", actorId: session.user.id, targetId: site.id, metadata: parsed.data } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  return NextResponse.json({ site });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const existing = await db.gatewaySite.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.gatewaySite.delete({ where: { id: params.id } });

  await db.auditLog.create({
    data: { action: "site.deleted", actorId: session.user.id, targetId: existing.id, metadata: { name: existing.name } } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  return NextResponse.json({ ok: true });
}
