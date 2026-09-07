import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";

export const dynamic = "force-dynamic";

// PATCH /api/platform/tenants/[id] — the tenant identity edit that never
// existed before this route (plan §1: "no PATCH/PUT /api/platform/tenants/[id]
// exists. Tenant.name is displayed everywhere, editable nowhere").
//
// Deliberately narrow. Only `name`, `complianceNotes`, `billingRef` and
// `billingProvider` may move through here:
//   - `slug` is immutable by design — it is the OpenVPN certificate CN root
//     AND the workspace hostname (<slug>.algopbx.com). Renaming it here would
//     silently desync the two from the moment this route shipped.
//   - `tunnelSubnetIndex` is allocated once at provisioning and never reused,
//     even after offboarding (see the schema's own comment on that field) —
//     editing it from a form is how two tenants end up sharing a subnet.
// Both are REJECTED with a 400 if present in the body, not merely ignored —
// silently dropping a field an operator explicitly sent would look like a
// bug rather than a boundary.

const BodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    complianceNotes: z.string().max(2000).nullable().optional(),
    billingRef: z.string().max(200).nullable().optional(),
    billingProvider: z.string().max(100).nullable().optional(),
    reason: z.string(),
    // Accepted only so the immutable-field check below can name them in its
    // error rather than have zod's own "unrecognized key" reject them with
    // no explanation of WHY they're refused.
    slug: z.unknown().optional(),
    tunnelSubnetIndex: z.unknown().optional(),
  })
  .strict();

const IMMUTABLE_FIELDS = ["slug", "tunnelSubnetIndex"] as const;

export const PATCH = withApiErrorHandler(async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const raw = await req.json().catch(() => null);
  if (raw && typeof raw === "object") {
    const present = IMMUTABLE_FIELDS.filter((f) => f in (raw as Record<string, unknown>));
    if (present.length > 0) {
      return NextResponse.json(
        {
          error:
            `${present.join(", ")} may not be changed here. slug is the OpenVPN certificate CN root ` +
            `and the workspace hostname; tunnelSubnetIndex is allocated once at provisioning and never ` +
            `reused. Both are immutable after creation.`,
        },
        { status: 400 }
      );
    }
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const body = parsed.data;

  let reason: string;
  try {
    reason = requireReason(body.reason, "tenant.update");
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
      name: true,
      complianceNotes: true,
      billingRef: true,
      billingProvider: true,
    },
  });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const data: {
    name?: string;
    complianceNotes?: string | null;
    billingRef?: string | null;
    billingProvider?: string | null;
  } = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.complianceNotes !== undefined) data.complianceNotes = body.complianceNotes;
  if (body.billingRef !== undefined) data.billingRef = body.billingRef;
  if (body.billingProvider !== undefined) data.billingProvider = body.billingProvider;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No editable fields were supplied." }, { status: 400 });
  }

  const before = {
    name: tenant.name,
    complianceNotes: tenant.complianceNotes,
    billingRef: tenant.billingRef,
    billingProvider: tenant.billingProvider,
  };

  const updated = await db.$transaction(async (tx) => {
    const t = await tx.tenant.update({ where: { id: tenant.id }, data });

    await recordPlatformAudit(
      {
        action: "tenant.update",
        platformUserId: guard.session.user.id,
        tenantId: tenant.id,
        reason,
        metadata: {
          before,
          after: {
            name: t.name,
            complianceNotes: t.complianceNotes,
            billingRef: t.billingRef,
            billingProvider: t.billingProvider,
          },
          fieldsChanged: Object.keys(data),
        },
      },
      tx
    );

    return t;
  });

  return NextResponse.json({
    tenant: {
      id: updated.id,
      name: updated.name,
      complianceNotes: updated.complianceNotes,
      billingRef: updated.billingRef,
      billingProvider: updated.billingProvider,
    },
  });
});
