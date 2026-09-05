import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { tenantDb } from "@/lib/db-tenant";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { pushVpnConfig } from "@/lib/dinstar/vpn-push";
import { ensureSystemActorId } from "@/lib/support-grant";
import { recordPlatformAudit } from "@/lib/platform/audit";

export const dynamic = "force-dynamic";

// POST /api/platform/tenants/[id]/gateway/push-vpn — the owner-console
// counterpart of the admin push route.
//
// Deliberately a separate route rather than the console calling the admin
// endpoint: that one is guarded by requireAdminSession() and would reject a
// platform session outright — the two planes have separate cookies by design.
// The actual push logic is NOT duplicated; both routes call the same
// pushVpnConfig(), so the read-back verification behaviour cannot drift.
//
// Two details worth knowing:
//   - pushVpnConfig() writes a TENANT-side AuditLog row and needs an actorId
//     that is a real User. A PlatformUser is not one, so this reuses the same
//     per-tenant system actor support-grant.ts established, and additionally
//     writes a PlatformAuditLog row naming the actual operator.
//   - A non-2xx is returned when read-back fails even though the upload was
//     accepted. This device has been observed accepting a config POST without
//     applying it, so reporting "success, but unverified" would be reporting
//     a failure as a success.

const BodySchema = z.object({ siteId: z.string().min(1) });

const CLIENTS_DIR = process.env.OPENVPN_CLIENTS_DIR || "/app/openvpn-clients";
const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const POST = withApiErrorHandler(async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "siteId is required" }, { status: 400 });
  }

  const site = await db.gatewaySite.findUnique({ where: { id: parsed.data.siteId } });
  if (!site || site.tenantId !== params.id) {
    return NextResponse.json({ error: "Gateway site not found for this tenant" }, { status: 404 });
  }

  // Re-validated here as well as at creation — this value becomes a
  // filesystem path and a multipart filename, and this route should not be a
  // single point of trust for that guarantee.
  if (!SAFE_NAME_RE.test(site.name)) {
    return NextResponse.json(
      { error: `Site name "${site.name}" is not safe to use as a filename.` },
      { status: 400 }
    );
  }

  const ovpnPath = path.join(CLIENTS_DIR, `${site.name}.ovpn`);
  let ovpnFile: Buffer;
  try {
    ovpnFile = await readFile(ovpnPath);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: `No generated .ovpn found for "${site.name}". The certificate has to be signed by hand first — see the provisioning wizard's certificate step.`,
      },
      { status: 400 }
    );
  }

  const scoped = tenantDb(site.tenantId);
  const actorId = await ensureSystemActorId(db, site.tenantId);

  const result = await pushVpnConfig(
    scoped,
    site.id,
    site.gatewayLanIp,
    ovpnFile,
    `${site.name}.ovpn`,
    actorId
  );

  await recordPlatformAudit({
    action: "gateway.push_vpn_config",
    platformUserId: guard.session.user.id,
    tenantId: site.tenantId,
    metadata: { siteName: site.name, host: site.gatewayLanIp, ...result },
  });

  // 502 on an unverified push: the upload may have been accepted, but the
  // device did not confirm the config is live, and an operator must not read
  // that as done.
  return NextResponse.json(
    { ok: result.verifiedByReadback, ...result },
    { status: result.verifiedByReadback ? 200 : 502 }
  );
});
