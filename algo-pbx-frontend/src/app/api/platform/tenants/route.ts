import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformSession, requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { validateTenantSlug } from "@/lib/tenant/slug";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";
import { completeStep, emptyProvisioningState } from "@/lib/platform/provisioning-machine";

export const dynamic = "force-dynamic";

// GET /api/platform/tenants — list, any live platform session. Read-only
// listing metadata only (id/slug/name/status/billingStatus/plan/seats),
// never tenant call content — no support grant required, per plan §3's
// distinction (see platform-guard.ts's comment on requirePlatformSession
// vs. the grant mechanism).
//
// POST now exists (see below), but it deliberately does NOT run the whole
// pipeline: it creates the Tenant and hands off to the step machine, whose
// certificate step is a human gate. Automated signing stays impossible until
// CA signing flow v2 ships, and this route does not route around that.
export const GET = withApiErrorHandler(async function GET() {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const tenants = await db.tenant.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      plan: true,
      seats: true,
      billingStatus: true,
      paidUntil: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ tenants });
});

const CreateSchema = z.object({
  slug: z.string().min(1).max(63),
  name: z.string().min(1).max(200),
  plan: z.string().min(1).max(64).default("standard"),
  seats: z.number().int().positive().max(10_000).default(5),
  reason: z.string(),
});

// POST /api/platform/tenants — create a tenant and start its provisioning run.
//
// Creates the row and marks the first two pipeline steps complete (validating
// the slug and creating the tenant is literally what this handler does), then
// stops. Everything after that is driven one step at a time through
// ../provisioning/advance, so the persisted state always matches reality and
// the certificate step can be the human gate it has to be.
//
// The tenant is created even with an empty compliance checklist. That is
// deliberate: onboarding paperwork legitimately lags a technical setup, and
// refusing to record the customer would push the record-keeping into an inbox
// where nobody can see it. The gap follows the tenant as a visible warning
// instead.
export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { slug, name, plan, seats } = parsed.data;

  let reason: string;
  try {
    reason = requireReason(parsed.data.reason, "tenant.provision");
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // Format first — the reserved-word list and the DNS/SAFE_NAME_RE charset
  // are the same check provisioning's step 1 describes.
  const validation = validateTenantSlug(slug);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const existing = await db.tenant.findUnique({ where: { slug }, select: { id: true } });
  if (existing) {
    return NextResponse.json({ error: `The slug "${slug}" is already taken.` }, { status: 409 });
  }

  // Steps 1 and 2 are done by this handler itself.
  const state = completeStep(completeStep(emptyProvisioningState(), "validate_slug"), "create_tenant");

  const tenant = await db.$transaction(async (tx) => {
    const t = await tx.tenant.create({
      data: {
        slug,
        name,
        plan,
        seats,
        status: "TRIAL",
        billingStatus: "TRIAL",
        provisioningState: state as object,
      },
      select: { id: true, slug: true, name: true, plan: true, seats: true, status: true },
    });

    await recordPlatformAudit(
      {
        action: "tenant.provision",
        platformUserId: guard.session.user.id,
        tenantId: t.id,
        reason,
        metadata: { slug, name, plan, seats, stepsCompleted: state.completed },
      },
      tx
    );

    return t;
  });

  return NextResponse.json({ tenant, state }, { status: 201 });
});
