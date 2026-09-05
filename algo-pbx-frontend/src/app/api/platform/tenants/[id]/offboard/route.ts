import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";
import { subnetCidr } from "@/lib/platform/subnet";

export const dynamic = "force-dynamic";

// POST /api/platform/tenants/[id]/offboard — end the relationship.
//
// The plan's sequence: revoke cert -> regenerate CRL -> reload openvpn ->
// block the subnet at the firewall -> status OFFBOARDED -> offer data export
// -> apply retention -> honour a customer-requested deletion (PDPL) -> audit.
//
// ============================================================================
// DATA IS NEVER DELETED HERE. UNCONDITIONALLY.
// ============================================================================
// "Data is never auto-deleted; deletion happens only on explicit customer
// request or at the end of the stated retention period." This route contains
// no delete of tenant content, and must never grow one. Offboarding is a
// revocation of ACCESS, not a destruction of RECORDS — and deleting a
// customer's call recordings the moment they leave would destroy the evidence
// both sides may need in precisely the disputes that follow an offboarding.
// ============================================================================
//
// Honesty about what is actually automated: of the eight steps above, this
// route performs the database ones. The PKI and firewall steps require host
// access this container does not have (revocation runs through
// bridge-watch.sh's file-drop contract, and reloading OpenVPN is deliberately
// left to a human — the script does not do it either). Rather than silently
// skipping them, the response returns a per-step manifest of what ran and
// what the operator must still do, and the UI renders it as a checklist.

const BodySchema = z.object({
  reason: z.string(),
  confirmSlug: z.string(),
  // Set true only when the customer has actually asked for deletion. Even
  // then this route does not delete — it records the request so the retention
  // process can honour it deliberately, with its own evidence trail.
  customerRequestedDeletion: z.boolean().optional(),
});

export const POST = withApiErrorHandler(async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A reason and the exact tenant slug as confirmSlug are required." },
      { status: 400 }
    );
  }

  const tenant = await db.tenant.findUnique({
    where: { id: params.id },
    include: { gatewaySites: { select: { id: true, name: true } } },
  });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (tenant.status === "OFFBOARDED") {
    return NextResponse.json({ error: "This tenant is already offboarded." }, { status: 409 });
  }

  if (parsed.data.confirmSlug !== tenant.slug) {
    return NextResponse.json(
      { error: `confirmSlug does not match. Type "${tenant.slug}" exactly to confirm.` },
      { status: 400 }
    );
  }

  let reason: string;
  try {
    reason = requireReason(parsed.data.reason, "tenant.offboard");
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const [userCount, recordingCount, cdrCount] = await Promise.all([
    db.user.count({ where: { tenantId: tenant.id, disabled: false } }),
    db.recording.count({ where: { tenantId: tenant.id } }),
    db.callDetailRecord.count({ where: { tenantId: tenant.id } }),
  ]);

  const subnet = tenant.tunnelSubnetIndex !== null ? subnetCidr(tenant.tunnelSubnetIndex) : null;

  // What this route did, and what a human still has to do. Returned to the
  // caller and rendered as a checklist — an offboard that silently skipped
  // certificate revocation would leave a revoked customer holding a working
  // key to our VPN.
  const manifest = [
    { step: "status_offboarded", automated: true, detail: "Tenant status set to OFFBOARDED." },
    {
      step: "ui_access_revoked",
      automated: true,
      detail: `Login ends for ${userCount} user(s) on their next request.`,
    },
    {
      step: "revoke_certificate",
      automated: false,
      detail: tenant.gatewaySites.length
        ? `Revoke ${tenant.gatewaySites.map((s) => s.name).join(", ")} on the OpenVPN host (bridge-watch.sh handle_revoke).`
        : "No gateway site — nothing to revoke.",
    },
    {
      step: "regenerate_crl",
      automated: false,
      detail: "Regenerate the CRL after revocation. Requires the CA passphrase.",
    },
    {
      step: "reload_openvpn",
      automated: false,
      detail:
        "Reload algo-openvpn-server so the new CRL takes effect. bridge-watch.sh deliberately does not do this itself — until it runs, the revoked certificate still connects.",
    },
    {
      step: "block_subnet",
      automated: false,
      detail: subnet ? `Block ${subnet} at the host firewall.` : "No subnet allocated.",
    },
    {
      step: "offer_data_export",
      automated: false,
      detail: `Offer export of ${recordingCount} recording(s) and ${cdrCount} call record(s) before any retention action. Offboarding without export is a PDPL problem.`,
    },
    {
      step: "deletion",
      automated: false,
      detail: parsed.data.customerRequestedDeletion
        ? "Customer HAS requested deletion (PDPL). Honour it through the retention process — this route deleted nothing."
        : "No customer deletion request recorded. Data is retained under the stated retention policy. Nothing was deleted.",
    },
  ];

  const updated = await db.$transaction(async (tx) => {
    const t = await tx.tenant.update({
      where: { id: tenant.id },
      data: { status: "OFFBOARDED", offboardedAt: new Date() },
    });

    // Any live support grant into a tenant we have just offboarded should
    // not outlive the relationship.
    await tx.supportGrant.updateMany({
      where: { tenantId: tenant.id, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });

    await recordPlatformAudit(
      {
        action: "tenant.offboard",
        platformUserId: guard.session.user.id,
        tenantId: tenant.id,
        reason,
        metadata: {
          usersAffected: userCount,
          recordingsRetained: recordingCount,
          callRecordsRetained: cdrCount,
          customerRequestedDeletion: parsed.data.customerRequestedDeletion === true,
          // Stated in the audit row itself, so the record proves the rule was
          // followed rather than merely documented.
          dataDeleted: false,
          subnet,
          manualStepsRemaining: manifest.filter((m) => !m.automated).map((m) => m.step),
        },
      },
      tx
    );

    return t;
  });

  return NextResponse.json({
    tenant: { id: updated.id, status: updated.status, offboardedAt: updated.offboardedAt },
    manifest,
    dataDeleted: false,
  });
});
