import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";

export const dynamic = "force-dynamic";

// POST /api/platform/tenants/[id]/reinstate — the missing inverse of
// offboard (plan §1: "No path back from OFFBOARDED — unsuspend rejects it,
// offboard 409s. A mis-click is terminal.").
//
// ============================================================================
// OFFBOARDED -> SUSPENDED. NEVER STRAIGHT TO ACTIVE.
// ============================================================================
// Offboarding revoked the gateway certificate and (per its own manifest)
// left several manual steps undone — reload OpenVPN, block/unblock the
// subnet, re-verify the recording target. Setting the tenant straight back
// to ACTIVE would silently claim all of that is done when this route did
// none of it. Landing on SUSPENDED forces the owner through the existing,
// already-audited unsuspend flow (POST .../suspend?unsuspend) as a second,
// deliberate step, once the manual work below is actually finished.
// ============================================================================
//
// Typed-slug confirmation, same shape as offboard's — reinstating the wrong
// tenant by fat-fingering an id is exactly the kind of mistake a typed
// confirmation exists to catch.

const BodySchema = z.object({
  reason: z.string(),
  confirmSlug: z.string(),
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

  if (tenant.status !== "OFFBOARDED") {
    return NextResponse.json(
      { error: "Only an OFFBOARDED tenant can be reinstated." },
      { status: 409 }
    );
  }

  if (parsed.data.confirmSlug !== tenant.slug) {
    return NextResponse.json(
      { error: `confirmSlug does not match. Type "${tenant.slug}" exactly to confirm.` },
      { status: 400 }
    );
  }

  let reason: string;
  try {
    reason = requireReason(parsed.data.reason, "tenant.reinstate");
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // What reinstatement does NOT restore. Modelled on offboard's own
  // manifest — the same discipline: return exactly what happened, and let
  // the operator work the rest as an explicit checklist rather than assume
  // the flip of a status column undid everything offboarding did.
  const manifest = [
    {
      step: "status_suspended",
      automated: true,
      detail: "Tenant status set to SUSPENDED (not ACTIVE — see below).",
    },
    {
      step: "unsuspend_required",
      automated: false,
      detail:
        "Login stays blocked until an owner explicitly restores it via the Lifecycle tab's " +
        "'Restore login' action, once the steps below are confirmed done.",
    },
    {
      step: "certificate_reissue",
      automated: false,
      detail: tenant.gatewaySites.length
        ? `Certificates for ${tenant.gatewaySites.map((s) => s.name).join(", ")} were revoked at ` +
          "offboard time and must be re-issued on the OpenVPN host before any gateway can reconnect."
        : "No gateway site on record — nothing to re-issue.",
    },
    {
      step: "tunnel_reprovisioning",
      automated: false,
      detail:
        "The OpenVPN tunnel (ccd entry, firewall rule, subnet block) needs re-provisioning — " +
        "offboarding blocked the subnet at the firewall and this route does not undo that.",
    },
    {
      step: "recording_storage_reverification",
      automated: false,
      detail:
        "Any configured recording storage target needs a fresh connection test (Gateway tab) " +
        "before delivery is re-enabled — its credentials or reachability may have changed while offboarded.",
    },
  ];

  const updated = await db.$transaction(async (tx) => {
    const t = await tx.tenant.update({
      where: { id: tenant.id },
      data: { status: "SUSPENDED", offboardedAt: null, suspendedAt: new Date() },
    });

    await recordPlatformAudit(
      {
        action: "tenant.reinstate",
        platformUserId: guard.session.user.id,
        tenantId: tenant.id,
        reason,
        metadata: {
          previousStatus: "OFFBOARDED",
          newStatus: "SUSPENDED",
          manualStepsRemaining: manifest.filter((m) => !m.automated).map((m) => m.step),
        },
      },
      tx
    );

    return t;
  });

  return NextResponse.json({
    tenant: { id: updated.id, status: updated.status, suspendedAt: updated.suspendedAt },
    manifest,
  });
});
