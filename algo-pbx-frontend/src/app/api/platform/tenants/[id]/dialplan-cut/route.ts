import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";

export const dynamic = "force-dynamic";

// ============================================================================
// THE TELEPHONY KILL SWITCH.
// ============================================================================
// This is the ONE action in the entire console that stops a customer's calls.
// It is deliberately isolated in its own route so that every path to it is
// visible in one file, and so no billing, suspension, cron, retention or
// offboarding code can reach it by accident.
//
// The plan's rule, which this file implements:
//
//   "Cutting a tenant's dialplan is therefore a separate, manual, owner-only
//    action, with its own confirmation and its own mandatory audit reason,
//    completely outside the automatic ladder. No cron job, no lapse of
//    paidUntil, and no billingStatus transition may trigger it."
//
// Four guards, all server-side:
//   1. PLATFORM_OWNER only.
//   2. Mandatory reason.
//   3. `confirmSlug` in the body must equal the tenant's slug EXACTLY. A
//      button click alone can never do this — the operator has to have read
//      which tenant they are looking at. This is the guard against cutting
//      the wrong customer off, which is the realistic failure here.
//   4. `acknowledgeOutage: true`, an explicit statement that the caller knows
//      this causes a customer-visible outage rather than a billing nudge.
//
// If you are here to add an automatic caller — stop. That is the thing this
// file exists to prevent.
// ============================================================================

const BodySchema = z.object({
  reason: z.string(),
  confirmSlug: z.string(),
  acknowledgeOutage: z.literal(true),
  restore: z.boolean().optional(),
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
      {
        error:
          "A reason, the exact tenant slug as confirmSlug, and acknowledgeOutage: true are all required.",
      },
      { status: 400 }
    );
  }
  const restoring = parsed.data.restore === true;
  const action = restoring ? "tenant.dialplan_restore" : "tenant.dialplan_cut";

  const tenant = await db.tenant.findUnique({
    where: { id: params.id },
    select: { id: true, slug: true, name: true, dialplanCutAt: true, tunnelSubnetIndex: true },
  });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  // Typed confirmation. Compared exactly — no trimming, no case folding: the
  // whole value of this guard is that the operator reproduced the identifier
  // deliberately.
  if (parsed.data.confirmSlug !== tenant.slug) {
    return NextResponse.json(
      { error: `confirmSlug does not match. Type "${tenant.slug}" exactly to confirm.` },
      { status: 400 }
    );
  }

  let reason: string;
  try {
    reason = requireReason(parsed.data.reason, action);
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  if (!restoring && tenant.dialplanCutAt) {
    return NextResponse.json({ error: "This tenant's dialplan is already cut." }, { status: 409 });
  }
  if (restoring && !tenant.dialplanCutAt) {
    return NextResponse.json({ error: "This tenant's dialplan is not cut." }, { status: 409 });
  }

  const updated = await db.$transaction(async (tx) => {
    const t = await tx.tenant.update({
      where: { id: tenant.id },
      data: { dialplanCutAt: restoring ? null : new Date() },
    });

    await recordPlatformAudit(
      {
        action,
        platformUserId: guard.session.user.id,
        tenantId: tenant.id,
        reason,
        metadata: {
          // The only audit rows in this system where this is true. That makes
          // "which actions ever stopped a customer's calls" a single indexed
          // query, which is exactly the question asked after an incident.
          telephonyAffected: true,
          customerVisibleOutage: !restoring,
          confirmedSlug: parsed.data.confirmSlug,
          tunnelSubnetIndex: tenant.tunnelSubnetIndex,
          // Recorded explicitly so the trail shows this was a human decision,
          // never a consequence of billing state.
          initiatedBy: "manual_owner_action",
        },
      },
      tx
    );

    return t;
  });

  // NOTE — the database flag is set, but Asterisk is NOT reconfigured here.
  // Per-tenant dialplan contexts (from-agent-t<n> / from-dinstar-t<n>) do not
  // exist yet: telephony namespacing is wave 6 and needs a live Asterisk to
  // verify safely. Until then there is no per-tenant dialplan to cut, and
  // pretending otherwise — by returning success as though calls had stopped —
  // would be the most dangerous possible lie for this particular action. The
  // response says so, and the UI surfaces it as a dependency notice.
  return NextResponse.json({
    tenant: { id: updated.id, dialplanCutAt: updated.dialplanCutAt },
    telephonyAffected: true,
    enforced: false,
    note: restoring
      ? "Flag cleared. Asterisk was not reconfigured: per-tenant dialplan contexts do not exist yet (telephony namespacing is wave 6)."
      : "Flag set and audited, but calls are NOT actually stopped yet: per-tenant dialplan contexts do not exist until telephony namespacing (wave 6) ships. To stop this tenant's calls today, an operator must act on the shared dialplan directly.",
  });
});
