import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";

export const dynamic = "force-dynamic";

// PATCH /api/platform/tenants/[id]/geo-settings — the tenant-level geo-lock
// dials (plan §3.3): off/monitor/enforce, the tenant's default country
// (advisory only — see Tenant.geoDefaultCountry's own schema comment),
// whether a datacenter/VPN ASN match counts as a strike on its own, and the
// strike threshold before an extension locks. Owner-only: this is a
// security control, not a support-plane setting.
//
// Deliberately does NOT touch any Extension row — geoAllowedCountries is
// set per-extension via ../extensions/[extensionId]/geo/route.ts, and this
// route has no business writing it (guardrail mirrored on the tenant-admin
// side by /api/extensions/[number] rejecting the same field outright).

const BodySchema = z.object({
  geoLockMode: z.enum(["off", "monitor", "enforce"]).nullable(),
  geoDefaultCountry: z.string().length(2).nullable(),
  geoBlockVpn: z.boolean(),
  geoFailureThreshold: z.number().int().positive().max(1000).nullable(),
  reason: z.string(),
});

// GET — read-only, so the geo tab (a tab-specific client fetch; see
// geo-tab.tsx's own comment on why this isn't prop-drilled through
// loadTenantDetail()/SerialisedTenantDetail) has something to hydrate its
// form from without re-deriving the tenant-detail payload.
export const GET = withApiErrorHandler(async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const tenant = await db.tenant.findUnique({
    where: { id: params.id },
    select: { geoLockMode: true, geoDefaultCountry: true, geoBlockVpn: true, geoFailureThreshold: true },
  });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  return NextResponse.json({
    settings: {
      geoLockMode: tenant.geoLockMode ?? "off",
      geoDefaultCountry: tenant.geoDefaultCountry,
      geoBlockVpn: tenant.geoBlockVpn,
      geoFailureThreshold: tenant.geoFailureThreshold ?? 6,
    },
  });
});

export const PATCH = withApiErrorHandler(async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const body = parsed.data;

  let reason: string;
  try {
    reason = requireReason(body.reason, "tenant.geo_settings_update");
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const tenant = await db.tenant.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      geoLockMode: true,
      geoDefaultCountry: true,
      geoBlockVpn: true,
      geoFailureThreshold: true,
    },
  });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const before = {
    geoLockMode: tenant.geoLockMode,
    geoDefaultCountry: tenant.geoDefaultCountry,
    geoBlockVpn: tenant.geoBlockVpn,
    geoFailureThreshold: tenant.geoFailureThreshold,
  };

  const updated = await db.$transaction(async (tx) => {
    const t = await tx.tenant.update({
      where: { id: tenant.id },
      data: {
        // "off" is stored as null (schema: "null = off (default)").
        geoLockMode: body.geoLockMode === "off" ? null : body.geoLockMode,
        geoDefaultCountry: body.geoDefaultCountry,
        geoBlockVpn: body.geoBlockVpn,
        geoFailureThreshold: body.geoFailureThreshold,
      },
    });
    await recordPlatformAudit(
      {
        action: "tenant.geo_settings_update",
        platformUserId: guard.session.user.id,
        tenantId: tenant.id,
        reason,
        metadata: {
          before,
          after: {
            geoLockMode: t.geoLockMode,
            geoDefaultCountry: t.geoDefaultCountry,
            geoBlockVpn: t.geoBlockVpn,
            geoFailureThreshold: t.geoFailureThreshold,
          },
        },
      },
      tx
    );
    return t;
  });

  return NextResponse.json({
    tenant: {
      id: updated.id,
      geoLockMode: updated.geoLockMode,
      geoDefaultCountry: updated.geoDefaultCountry,
      geoBlockVpn: updated.geoBlockVpn,
      geoFailureThreshold: updated.geoFailureThreshold,
    },
  });
});
