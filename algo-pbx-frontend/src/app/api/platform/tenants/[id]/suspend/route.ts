import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";

export const dynamic = "force-dynamic";

// POST /api/platform/tenants/[id]/suspend — the manual UI-access suspension.
//
// SUSPENSION IS NOT A TELEPHONY ACTION. It blocks web login for the tenant's
// users (the tenant's own ADMIN keeps access to the billing-hold page so they
// can settle up). Asterisk keeps carrying their calls, inbound and outbound,
// exactly as before.
//
// This file imports no telephony module, and never will. The kill switch is
// ../dialplan-cut/route.ts, which is a deliberate, separate, typed-confirmation
// action — precisely so that "suspend" can never quietly become "stop their
// calls" through a well-meaning edit here.
//
// `?action=unsuspend` reverses it. Both directions need a reason and an audit
// row: restoring access is as consequential as removing it, and an audit trail
// with only half the story is a mystery, not evidence.

const BodySchema = z.object({
  reason: z.string(),
  unsuspend: z.boolean().optional(),
});

export const POST = withApiErrorHandler(async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const unsuspending = parsed.data.unsuspend === true;
  const action = unsuspending ? "tenant.unsuspend" : "tenant.suspend";

  let reason: string;
  try {
    reason = requireReason(parsed.data.reason, action);
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const tenant = await db.tenant.findUnique({
    where: { id: params.id },
    select: { id: true, slug: true, name: true, status: true, dialplanCutAt: true },
  });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  if (tenant.status === "OFFBOARDED") {
    return NextResponse.json(
      { error: "This tenant is offboarded. Suspension no longer applies." },
      { status: 409 }
    );
  }
  if (unsuspending && tenant.status !== "SUSPENDED") {
    return NextResponse.json({ error: "This tenant is not suspended." }, { status: 409 });
  }
  if (!unsuspending && tenant.status === "SUSPENDED") {
    return NextResponse.json({ error: "This tenant is already suspended." }, { status: 409 });
  }

  const userCount = await db.user.count({ where: { tenantId: tenant.id, disabled: false } });

  const updated = await db.$transaction(async (tx) => {
    const t = await tx.tenant.update({
      where: { id: tenant.id },
      data: unsuspending
        ? { status: "ACTIVE", suspendedAt: null }
        : { status: "SUSPENDED", suspendedAt: new Date() },
    });

    await recordPlatformAudit(
      {
        action,
        platformUserId: guard.session.user.id,
        tenantId: tenant.id,
        reason,
        metadata: {
          usersAffected: userCount,
          // Written on every row so the audit trail itself records the
          // separation, and so a later reader does not have to take our word
          // for it. `dialplanCutAt` is echoed to make it plain that this
          // action did not change it.
          telephonyAffected: false,
          dialplanCutAt: tenant.dialplanCutAt?.toISOString() ?? null,
        },
      },
      tx
    );

    return t;
  });

  return NextResponse.json({
    tenant: { id: updated.id, status: updated.status, suspendedAt: updated.suspendedAt },
    usersAffected: userCount,
    telephonyAffected: false,
  });
});
