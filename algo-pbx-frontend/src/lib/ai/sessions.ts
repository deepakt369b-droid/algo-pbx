import type { Prisma } from "@prisma/client";
import { unsafeGlobalDb } from "@/lib/db";
import { tenantDb } from "@/lib/db-tenant";
import { recordActivity } from "@/lib/crm/activity";
import type { AiSessionReportRequest } from "@/lib/ai/types";

// Extracted out of the POST /api/internal/ai/sessions route (per
// .agents/hybrid-ai/contracts.md, W6) so the "write AiCallSession + CRM
// Activity" logic is unit-testable without going through the HTTP layer.
//
// Tenant resolution: the sidecar's report body carries only `agentId`, not a
// tenantId — the same shape of problem POST /api/cdr and the OpenWA webhook
// solve the same way (see those files' header comments): one deliberately
// unscoped lookup (`unsafeGlobalDb`) to find the owning AiAgent's tenantId,
// then every actual write goes through `tenantDb(tenantId)`.
//
// Recording linkage: per the contract, "don't error if none exists yet (the
// CDR listener may not have caught up — this is explicitly expected)". This
// function never creates a CallDetailRecord or Recording itself; it only
// best-effort looks up the CDR (by cdrUniqueId) to find a Contact to hang
// the Activity off of. recordActivity() itself already no-ops when there's
// no contactId/dealId to attach to, so a not-yet-arrived CDR silently means
// "no Activity row for now" rather than an error.
export async function recordAiSession(input: AiSessionReportRequest): Promise<void> {
  const agent = await unsafeGlobalDb.aiAgent.findUnique({
    where: { id: input.agentId },
    select: { tenantId: true, name: true },
  });
  if (!agent) {
    throw new Error(`recordAiSession: no AiAgent found for id ${input.agentId}`);
  }

  const db = tenantDb(agent.tenantId);

  // No `tenantId` in this literal — TenantClient force-injects it at
  // create-time regardless of what's passed (see crm/activity.ts /
  // api/cdr/route.ts's identical comment on this pattern).
  const sessionData = {
    aiAgentId: input.agentId,
    cdrUniqueId: input.cdrUniqueId,
    transcript: input.transcript as unknown as Prisma.InputJsonValue,
    summary: input.summary ?? null,
    latencyMsP50: input.latencyMsP50 ?? null,
    latencyMsP95: input.latencyMsP95 ?? null,
    costTokensInput: input.costTokensInput ?? null,
    costTokensOutput: input.costTokensOutput ?? null,
    outcome: input.outcome,
    handoffExtensionId: input.handoffExtensionId ?? null,
  } as unknown as Prisma.AiCallSessionUncheckedCreateInput;

  await db.aiCallSession.create({ data: sessionData });

  // Best-effort: find the contact this call belongs to via the CDR's
  // caller-number, so the AI call shows up on the unified CRM timeline the
  // same way a human-agent call does. Never throws past this point — a
  // missing/late CDR or unmatched contact just means no Activity yet.
  try {
    const cdr = await db.callDetailRecord.findUnique({
      where: { uniqueId: input.cdrUniqueId },
      select: { id: true, callerNumberE164: true, durationSec: true, startedAt: true },
    });
    if (cdr?.callerNumberE164) {
      const contact = await db.contact.findUnique({
        where: { tenantId_numberE164: { tenantId: agent.tenantId, numberE164: cdr.callerNumberE164 } },
        select: { id: true },
      });
      if (contact) {
        const outcomeLabel = input.outcome.replace(/_/g, " ");
        await recordActivity(
          {
            type: "CALL",
            summary: input.summary
              ? `AI agent (${agent.name}) — ${outcomeLabel}: ${input.summary}`.slice(0, 500)
              : `AI agent (${agent.name}) — ${outcomeLabel}`,
            refId: input.cdrUniqueId,
            occurredAt: cdr.startedAt,
            contactId: contact.id,
          },
          db,
        );
      }
    }
  } catch (err) {
    // Same defensive posture as crm/activity.ts's own recordActivity: a
    // timeline-row failure must never surface as a failure of the session
    // report itself.
    console.error("[ai/sessions] best-effort Activity write failed", err);
  }
}
