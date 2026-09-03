import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminSession, requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

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
    transport: z.enum(["TAILSCALE", "OPENVPN", "HEADSCALE"]).optional(),
    status: z.enum(["UNKNOWN", "UP", "DEGRADED", "DOWN"]).optional(),
    headscaleNodeKey: z.string().max(200).nullable().optional(),
    lastHandshakeAt: z.string().datetime({ offset: true }).nullable().optional(),
    lastReachableAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "No fields to update" });

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const existing = await db.gatewaySite.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const { lastHandshakeAt, lastReachableAt, ...rest } = parsed.data;
  const site = await db.gatewaySite.update({
    where: { id: params.id },
    data: {
      ...rest,
      ...(lastHandshakeAt !== undefined ? { lastHandshakeAt: lastHandshakeAt ? new Date(lastHandshakeAt) : null } : {}),
      ...(lastReachableAt !== undefined ? { lastReachableAt: lastReachableAt ? new Date(lastReachableAt) : null } : {}),
    },
  });

  await db.auditLog.create({
    data: { action: "site.updated", actorId: guard.session.user.id, targetId: site.id, metadata: parsed.data },
  });

  return NextResponse.json({ site });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const existing = await db.gatewaySite.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.gatewaySite.delete({ where: { id: params.id } });

  await db.auditLog.create({
    data: { action: "site.deleted", actorId: guard.session.user.id, targetId: existing.id, metadata: { name: existing.name } },
  });

  return NextResponse.json({ ok: true });
}
