import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";
import { decryptSetting } from "@/lib/settings/crypto";
import { vpnConfigFilename } from "@/lib/connectivity/user-vpn-config";

export const dynamic = "force-dynamic";

// GET /api/admin/users/[id]/vpn/config - the one path that ever re-serves a
// stored VPN client config after its one-time POST disclosure. Deliberately
// separate from GET .../vpn (which never returns configEncrypted's
// plaintext) so a UI's "download again" action is a distinct, individually
// auditable request rather than something bundled into the metadata read.
// ADMIN-only (requireAdminSession()), and every download is written to the
// tenant AuditLog.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db, session } = guard;

  const profile = await db.userVpnProfile.findUnique({
    where: { userId: params.id },
    select: { id: true, transport: true, label: true, configEncrypted: true, revokedAt: true },
  });
  if (!profile || !profile.configEncrypted || profile.revokedAt) {
    return NextResponse.json({ error: "No downloadable config for this user." }, { status: 404 });
  }

  const config = decryptSetting(profile.configEncrypted);
  const filename = vpnConfigFilename(profile.transport, profile.label ?? params.id);

  await db.auditLog.create({
    data: {
      action: "user_vpn.config_download",
      actorId: session.user.id,
      targetId: params.id,
      metadata: { transport: profile.transport },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  return new NextResponse(config, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
