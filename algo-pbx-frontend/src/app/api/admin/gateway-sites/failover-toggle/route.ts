import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";
import { unsafeGlobalDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// PATCH /api/admin/gateway-sites/failover-toggle — the per-tenant kill
// switch for W3's automatic-failover supervisor (connectivity plan §3.2).
// `Tenant` is deliberately NOT on TENANT_SCOPED_MODELS (it's the tenancy
// boundary itself, not tenant-owned data — see scope-rules.ts's own list),
// so this writes via `unsafeGlobalDb` — but ONLY to the caller's own tenant
// (session.user.tenantId, never a value taken from the request body), which
// is not a cross-tenant write. Ships defaulting to `false` everywhere
// (schema default) per the plan's H2 human gate: nothing re-points itself
// until an operator explicitly flips this per tenant, after the probes have
// agreed with reality for a few days.
const BodySchema = z.object({ enabled: z.boolean() });

export async function PATCH(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const tenant = await unsafeGlobalDb.tenant.update({
    where: { id: session.user.tenantId },
    data: { failoverEnabled: parsed.data.enabled },
    select: { id: true, failoverEnabled: true },
  });

  // `db` is `tenantDb(session.user.tenantId)` — AuditLog IS tenant-scoped,
  // so this call is automatically confined to the caller's own tenant, same
  // pattern as every other write in this route family (see
  // gateway-sites/route.ts's site.created/site.updated audit rows).
  await db.auditLog.create({
    data: {
      action: "tenant.failover_toggle",
      actorId: session.user.id,
      targetId: tenant.id,
      metadata: { failoverEnabled: tenant.failoverEnabled },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  return NextResponse.json({ tenant });
}
