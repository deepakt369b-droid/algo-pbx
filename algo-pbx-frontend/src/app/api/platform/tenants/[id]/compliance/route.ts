import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit } from "@/lib/platform/audit";
import { evaluateCompliance } from "@/lib/platform/compliance";

export const dynamic = "force-dynamic";

// PATCH /api/platform/tenants/[id]/compliance — record that a compliance
// artefact has been filed (or un-record it, if it was ticked in error).
//
// No mandatory reason here, unlike the destructive actions. This is
// bookkeeping — recording that a document exists — not a change to what a
// customer can do, and demanding a justification paragraph for "the AUP came
// back signed" is the kind of friction that leads to the checklist simply not
// being maintained. It is still owner-only and still audited: the timestamps
// are compliance evidence, so who set them and when has to be recoverable.

const ITEM_FIELDS = {
  typeApproval: "complianceTypeApprovalFiledAt",
  carrierLetter: "complianceEtisalatLetterAt",
  aupSigned: "complianceAupSignedAt",
  pdplTermsSigned: "compliancePdplTermsSignedAt",
  recordingDisclosure: "complianceRecordingDisclosureAt",
} as const;

const BodySchema = z.object({
  item: z.enum(["typeApproval", "carrierLetter", "aupSigned", "pdplTermsSigned", "recordingDisclosure"]),
  filed: z.boolean(),
  notes: z.string().max(2000).optional(),
});

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
  const { item, filed, notes } = parsed.data;

  const tenant = await db.tenant.findUnique({ where: { id: params.id }, select: { id: true, slug: true } });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const field = ITEM_FIELDS[item];

  const updated = await db.$transaction(async (tx) => {
    const t = await tx.tenant.update({
      where: { id: tenant.id },
      data: {
        [field]: filed ? new Date() : null,
        ...(notes !== undefined ? { complianceNotes: notes } : {}),
      },
    });

    await recordPlatformAudit(
      {
        action: "tenant.compliance_update",
        platformUserId: guard.session.user.id,
        tenantId: tenant.id,
        metadata: { item, field, filed },
      },
      tx
    );

    return t;
  });

  return NextResponse.json({ compliance: evaluateCompliance(updated) });
});
