import { notFound } from "next/navigation";
import { requirePlatformSetupSession } from "@/lib/platform-guard";
import { unsafeGlobalDb as db } from "@/lib/db";
import { GeoLocksList, type GeoLockRow } from "@/components/platform/geo-locks-list";

export const dynamic = "force-dynamic";

// Cross-tenant geo-lock queue (plan §3.3 / node W6). Owner-only: this is
// where an extension's access gets restored, and the plan reserves that
// decision for PLATFORM_OWNER alone — same tier as tenant provisioning,
// billing overrides and dialplan cuts.
//
// Two disjoint sources feed one list, per the brief:
//   - every ExtensionUnlockRequest the tenant admin has actually filed
//     ("status: PENDING"), and
//   - every extension that is CURRENTLY locked but has no such request —
//     so a lock nobody has asked about yet is never invisible here, even
//     though nothing built by this wave lets the platform initiate contact
//     about it beyond this page existing.
// A locked extension that also has a pending request appears exactly once,
// as the request row (never duplicated as a silent one too).
export default async function GeoLocksPage() {
  const guard = await requirePlatformSetupSession();
  if ("response" in guard) notFound();

  if (guard.session.user.role !== "PLATFORM_OWNER") {
    return (
      <div className="mx-auto max-w-2xl">
        <p className="text-[13px] text-secondary">
          Only a platform owner can review or act on geo-lock requests.
        </p>
      </div>
    );
  }

  const [pendingRequests, lockedExtensions] = await Promise.all([
    db.extensionUnlockRequest.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      include: {
        tenant: { select: { id: true, slug: true, name: true } },
        extension: {
          select: {
            id: true,
            number: true,
            geoLockedAt: true,
            geoLockedReason: true,
            geoLastFailureAt: true,
            geoLastFailureCountry: true,
            geoLastFailureIp: true,
            geoLastFailureAsn: true,
          },
        },
      },
    }),
    db.extension.findMany({
      where: { geoLockedAt: { not: null }, unlockRequests: { none: { status: "PENDING" } } },
      orderBy: { geoLockedAt: "asc" },
      select: {
        id: true,
        number: true,
        geoLockedAt: true,
        geoLockedReason: true,
        geoLastFailureAt: true,
        geoLastFailureCountry: true,
        geoLastFailureIp: true,
        geoLastFailureAsn: true,
        tenant: { select: { id: true, slug: true, name: true } },
      },
    }),
  ]);

  // requestedByUserId is a plain string, not a relation (ExtensionUnlockRequest
  // deliberately has no FK here — see the model's own comment), so the
  // requester's name/email is a separate lookup rather than an `include`.
  const requesters = await db.user.findMany({
    where: { id: { in: pendingRequests.map((r) => r.requestedByUserId) } },
    select: { id: true, name: true, email: true },
  });
  const requesterById = new Map(requesters.map((u) => [u.id, u]));

  const rows: GeoLockRow[] = [
    ...pendingRequests.map((r) => ({
      kind: "request" as const,
      id: r.id,
      tenant: r.tenant,
      extensionId: r.extension.id,
      extensionNumber: r.extension.number,
      lockedAt: r.extension.geoLockedAt ? r.extension.geoLockedAt.toISOString() : null,
      lockedReason: r.extension.geoLockedReason,
      lastFailureAt: r.extension.geoLastFailureAt ? r.extension.geoLastFailureAt.toISOString() : null,
      lastFailureCountry: r.extension.geoLastFailureCountry,
      lastFailureIp: r.extension.geoLastFailureIp,
      lastFailureAsn: r.extension.geoLastFailureAsn,
      requestedAt: r.createdAt.toISOString(),
      requestedByName: requesterById.get(r.requestedByUserId)?.name ?? "(deleted user)",
      requestedByEmail: requesterById.get(r.requestedByUserId)?.email ?? "",
      requestedReason: r.requestedReason,
    })),
    ...lockedExtensions.map((e) => ({
      kind: "silent" as const,
      id: e.id,
      tenant: e.tenant,
      extensionId: e.id,
      extensionNumber: e.number,
      lockedAt: e.geoLockedAt ? e.geoLockedAt.toISOString() : null,
      lockedReason: e.geoLockedReason,
      lastFailureAt: e.geoLastFailureAt ? e.geoLastFailureAt.toISOString() : null,
      lastFailureCountry: e.geoLastFailureCountry,
      lastFailureIp: e.geoLastFailureIp,
      lastFailureAsn: e.geoLastFailureAsn,
      requestedAt: null,
      requestedByName: null,
      requestedByEmail: null,
      requestedReason: null,
    })),
  ];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-primary">Geo locks</h1>
        <p className="text-[13px] text-secondary">
          Every pending unlock request across all tenants, plus every extension currently locked out
          by the geo-lock guard that no one has asked about yet.
        </p>
      </header>

      <GeoLocksList rows={rows} />
    </div>
  );
}
