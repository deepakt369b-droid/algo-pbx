import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";

export const dynamic = "force-dynamic";

// PATCH /api/platform/tenants/[id]/billing — the four manual billing actions.
//
// ============================================================================
// WHAT THIS ROUTE MAY NOT DO
// ============================================================================
// It may not touch telephony. Not the dialplan, not PJSIP, not AMI, not the
// gateway. The approved plan is unambiguous: the enforcement ladder governs
// UI login and nothing else, and cutting a tenant's calls is a separate,
// manual, owner-only action living in ../dialplan-cut/route.ts.
//
// That is not a comment asking for restraint — it is why this file imports no
// telephony module at all, and why `evaluateBillingAccess` (the thing that
// reads these fields) returns a type with no telephony field to act on. A
// change here that stops a tenant's calls would not be an enforcement lever;
// it would be an outage their customers blame them for, on day 8 of an
// invoice they may well be disputing.
// ============================================================================
//
// Owner-only. A PLATFORM_SUPPORT operator can see billing state (it is on the
// tenant detail page) but cannot change what a customer owes.

const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("mark_paid"),
    // The period the payment covers. Required rather than "now + 30 days":
    // manual invoicing means the real period is whatever the invoice said,
    // and guessing it here silently creates a billing dispute later.
    paidUntil: z.string().datetime(),
    reason: z.string(),
  }),
  z.object({
    action: z.literal("extend"),
    days: z.number().int().positive().max(3650),
    reason: z.string(),
  }),
  z.object({
    action: z.literal("change_plan"),
    plan: z.string().min(1).max(64),
    seats: z.number().int().positive().max(10_000),
    reason: z.string(),
  }),
  z.object({
    action: z.literal("comp"),
    // A comped tenant has no paid-until date to lapse, so the ladder never
    // fires for them — which is exactly what "comped" should mean.
    reason: z.string(),
  }),
]);

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

  const tenant = await db.tenant.findUnique({
    where: { id: params.id },
    select: { id: true, slug: true, plan: true, seats: true, paidUntil: true, billingStatus: true },
  });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  let reason: string;
  try {
    // Enforced HERE, at the API layer, not merely in the form — a reason that
    // only the UI requires is a reason an operator can skip with curl, and
    // the audit row is the whole point.
    reason = requireReason(body.reason, `billing.${body.action}`);
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const before = {
    plan: tenant.plan,
    seats: tenant.seats,
    paidUntil: tenant.paidUntil?.toISOString() ?? null,
    billingStatus: tenant.billingStatus,
  };

  const data: {
    plan?: string;
    seats?: number;
    paidUntil?: Date | null;
    billingStatus?: "TRIAL" | "ACTIVE" | "PAST_DUE" | "SUSPENDED";
  } = {};

  switch (body.action) {
    case "mark_paid":
      data.paidUntil = new Date(body.paidUntil);
      data.billingStatus = "ACTIVE";
      break;
    case "extend": {
      // Extend from whichever is later: today, or the existing paidUntil.
      // Extending from a date already in the past would silently grant fewer
      // days than the operator asked for.
      const from =
        tenant.paidUntil && tenant.paidUntil.getTime() > Date.now() ? tenant.paidUntil : new Date();
      data.paidUntil = new Date(from.getTime() + body.days * 24 * 60 * 60 * 1000);
      data.billingStatus = "ACTIVE";
      break;
    }
    case "change_plan":
      data.plan = body.plan;
      data.seats = body.seats;
      break;
    case "comp":
      // Null paidUntil is the ladder's documented "nothing to enforce" state.
      data.paidUntil = null;
      data.billingStatus = "ACTIVE";
      break;
  }

  const updated = await db.$transaction(async (tx) => {
    const t = await tx.tenant.update({ where: { id: tenant.id }, data });
    // Same transaction as the change: a billing override with no audit row is
    // worse than no override at all.
    await recordPlatformAudit(
      {
        action: `billing.${body.action}` as
          | "billing.mark_paid"
          | "billing.extend"
          | "billing.change_plan"
          | "billing.comp",
        platformUserId: guard.session.user.id,
        tenantId: tenant.id,
        reason,
        metadata: {
          before,
          after: {
            plan: t.plan,
            seats: t.seats,
            paidUntil: t.paidUntil?.toISOString() ?? null,
            billingStatus: t.billingStatus,
          },
          // Recorded on every billing row so the audit trail itself carries
          // the guarantee, not just our documentation of it.
          telephonyAffected: false,
        },
      },
      tx
    );
    return t;
  });

  return NextResponse.json({
    tenant: {
      id: updated.id,
      plan: updated.plan,
      seats: updated.seats,
      paidUntil: updated.paidUntil,
      billingStatus: updated.billingStatus,
    },
  });
});
