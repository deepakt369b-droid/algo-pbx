import { NextRequest, NextResponse } from "next/server";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET /api/platform/tenants/[id]/geo-overview — read-only aggregate for the
// Geo tab's extension-allocation table and evidence log. Not part of the
// brief's two mandated write routes (geo-settings PATCH, per-extension geo
// PATCH); this exists purely so the tab has something to fetch, since
// SerialisedTenantDetail/types.ts is off-limits to extend for this wave
// (see geo-tab.tsx's header comment) and support-tab.tsx's own precedent —
// an owner-only tab doing its own small inline fetch — is the closer
// analog here than prop-drilling through the shared loader.
export const GET = withApiErrorHandler(async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const [extensions, events] = await Promise.all([
    db.extension.findMany({
      where: { tenantId: params.id },
      orderBy: { number: "asc" },
      select: {
        id: true,
        number: true,
        geoAllowedCountries: true,
        geoLockedAt: true,
        geoLockedReason: true,
        geoFailedAttempts: true,
      },
    }),
    db.geoLoginEvent.findMany({
      where: { tenantId: params.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        createdAt: true,
        ip: true,
        country: true,
        asn: true,
        asnOrg: true,
        outcome: true,
        counted: true,
        email: true,
        extension: { select: { number: true } },
      },
    }),
  ]);

  return NextResponse.json({
    extensions: extensions.map((e) => ({
      id: e.id,
      number: e.number,
      geoAllowedCountries: e.geoAllowedCountries,
      geoLockedAt: e.geoLockedAt ? e.geoLockedAt.toISOString() : null,
      geoLockedReason: e.geoLockedReason,
      geoFailedAttempts: e.geoFailedAttempts,
    })),
    events: events.map((ev) => ({
      id: ev.id,
      createdAt: ev.createdAt.toISOString(),
      ip: ev.ip,
      country: ev.country,
      asn: ev.asn,
      asnOrg: ev.asnOrg,
      outcome: ev.outcome,
      counted: ev.counted,
      email: ev.email,
      extensionNumber: ev.extension?.number ?? null,
    })),
  });
});
