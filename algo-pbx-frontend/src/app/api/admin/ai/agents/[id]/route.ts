import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAdminSession } from "@/lib/auth-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { unsafeGlobalDb } from "@/lib/db";
import { normalizeToE164 } from "@/lib/phone-normalize";
import { planHasFeature } from "@/lib/platform/plan-catalog";

// Same lookup as ../route.ts's own tenantPlan() — duplicated rather than
// shared across the two files, matching this codebase's existing preference
// for a small inlined helper over a new shared module for a two-line query
// (see e.g. seat-guard.ts vs admin/layout.tsx, which both go through
// unsafeGlobalDb for this same lookup independently).
async function tenantPlan(tenantId: string): Promise<string> {
  const tenant = await unsafeGlobalDb.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  return tenant?.plan ?? "standard";
}

export const dynamic = "force-dynamic";

// GET/PATCH /api/admin/ai/agents/[id] — the AI agent editor's read/write
// route (new for W7, see ../route.ts's header for why this exists at all).
// `db` is the tenant-scoped client from requireAdminSession(), so a
// `findUnique({ where: { id } })` here can never return another tenant's
// AiAgent row even if an admin guesses/leaks an id.
const AGENT_DETAIL_SELECT = {
  id: true,
  name: true,
  language: true,
  greeting: true,
  systemPrompt: true,
  pipelineMode: true,
  realtimeProviderId: true,
  realtimeModel: true,
  sttProviderId: true,
  sttModel: true,
  llmProviderId: true,
  llmModel: true,
  ttsProviderId: true,
  ttsModel: true,
  ttsVoice: true,
  tools: true,
  allowedDestinations: true,
  callHoursStart: true,
  callHoursEnd: true,
  outboundEnabled: true,
  dinstarPort: true,
  escalationEnabled: true,
  handoffTargetKind: true,
  handoffNumberE164: true,
  handoffExtensionId: true,
  handoffExtension: { select: { id: true, number: true } },
  promptMode: true,
  llmTemperature: true,
  llmMaxTokens: true,
  ttsSpeed: true,
  sttLanguage: true,
  allowInterruption: true,
  vadEnergyThreshold: true,
  vadSilenceFrames: true,
  bargeInThreshold: true,
  bargeInConsecutiveFrames: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
  extension: { select: { id: true, number: true } },
} as const;

export const GET = withApiErrorHandler(async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const agent = await db.aiAgent.findUnique({ where: { id: params.id }, select: AGENT_DETAIL_SELECT });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ agent });
});

// Every field optional — the editor autosaves/saves section-by-section
// (prompt, legs, compliance) rather than requiring one giant valid form.
// providerId fields are AiProviderCredential ids (validated to belong to
// this tenant below), not raw provider-kind strings — same "store a
// credential id, resolve+decrypt server-side" shape as AiAgentConfigResponse
// in contracts.md.
const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  language: z.string().min(1).max(20).optional(),
  greeting: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  pipelineMode: z.enum(["REALTIME", "CASCADE"]).optional(),
  realtimeProviderId: z.string().nullable().optional(),
  realtimeModel: z.string().nullable().optional(),
  sttProviderId: z.string().nullable().optional(),
  sttModel: z.string().nullable().optional(),
  llmProviderId: z.string().nullable().optional(),
  llmModel: z.string().nullable().optional(),
  ttsProviderId: z.string().nullable().optional(),
  ttsModel: z.string().nullable().optional(),
  ttsVoice: z.string().nullable().optional(),
  tools: z.unknown().optional(),
  allowedDestinations: z.array(z.string()).optional(),
  callHoursStart: z.number().int().min(0).max(23).nullable().optional(),
  callHoursEnd: z.number().int().min(0).max(23).nullable().optional(),
  // Ships false; the editor lets an admin flip it on, but this route is
  // the only guardrail against a compromised/careless client silently
  // turning on GSM-gateway automated outbound dialing (contracts.md
  // "Compliance / geo (W8)") — no extra confirmation step here beyond
  // what the editor UI itself asks for, same trust model as every other
  // admin toggle in this codebase.
  outboundEnabled: z.boolean().optional(),
  enabled: z.boolean().optional(),
  // Follow-up to §34 (LLM.md, 2026-09-14): which Dinstar GSM port (1-4,
  // matching WaInstance.simPort's numbering) this agent answers inbound
  // calls on. null = unassign (internal-dial-only). The DB's
  // @@unique([tenantId, dinstarPort]) is the real enforcement; a P2002 here
  // is caught below and turned into a clear 409.
  dinstarPort: z.number().int().min(1).max(4).nullable().optional(),
  // AI -> human escalation (LLM.md §34.2, 2026-09-14). Ships
  // escalationEnabled=false at the DB level; this route is the same kind of
  // guardrail as outboundEnabled above — no extra confirmation step beyond
  // what the editor UI asks for. handoffTargetKind selects which of
  // handoffNumberE164/handoffExtensionId is authoritative; the other is left
  // as whatever it was (the editor is expected to clear the unused one, but
  // this route does not enforce mutual exclusivity — agent-config/route.ts's
  // handoffExtensionHint resolution only ever reads the field matching the
  // current handoffTargetKind, so a stale value in the other field is inert).
  escalationEnabled: z.boolean().optional(),
  handoffTargetKind: z.enum(["NUMBER", "EXTENSION"]).nullable().optional(),
  handoffNumberE164: z.string().nullable().optional(),
  handoffExtensionId: z.string().nullable().optional(),
  // Conversation-workflow builder (2026-09-15). Switching to WORKFLOW here
  // only changes which prompt path the sidecar takes IF a published
  // AiWorkflow version also exists (see agent-config/route.ts) — flipping
  // this alone, with no workflow ever built, is equivalent to staying on
  // SIMPLE. The workflow graph itself is edited through its own dedicated
  // route (workflow/route.ts), not here.
  promptMode: z.enum(["SIMPLE", "WORKFLOW"]).optional(),
  // Model configuration (2026-09-15). null = "use the provider's own
  // default" — see AiAgent's migration comment for why every field here is
  // nullable rather than defaulted to a specific number.
  llmTemperature: z.number().min(0).max(2).nullable().optional(),
  llmMaxTokens: z.number().int().min(16).max(8192).nullable().optional(),
  ttsSpeed: z.number().min(0.5).max(2.0).nullable().optional(),
  sttLanguage: z.string().max(20).nullable().optional(),
  allowInterruption: z.boolean().optional(),
  vadEnergyThreshold: z.number().min(0).max(1).nullable().optional(),
  vadSilenceFrames: z.number().int().min(1).max(200).nullable().optional(),
  bargeInThreshold: z.number().min(0).max(1).nullable().optional(),
  bargeInConsecutiveFrames: z.number().int().min(1).max(50).nullable().optional(),
});

const CREDENTIAL_ID_FIELDS = ["realtimeProviderId", "sttProviderId", "llmProviderId", "ttsProviderId"] as const;

export const PATCH = withApiErrorHandler(async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db, session } = guard;

  // Fixed 2026-09-15 (workflow-builder plan): this route was the ONE AI
  // admin write path with no plan gate at all — POST (create) and every
  // providers route already checked planHasFeature, but a tenant that lost
  // (or never had) the aiAgents feature could still PATCH an existing
  // AiAgent row indefinitely. An agent can only exist via POST, which IS
  // gated, so this was reachable only after a downgrade locked the agent
  // (billing/route.ts sets enabled:false) — but PATCH itself never checked,
  // so a locked agent's config remained fully editable past the downgrade.
  const plan = await tenantPlan(session.user.tenantId);
  if (!planHasFeature(plan, "aiAgents")) {
    return NextResponse.json({ error: "AI agents are not included on this plan." }, { status: 403 });
  }

  const existing = await db.aiAgent.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = UpdateAgentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", issues: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  // ⚠️ Cross-tenant mitigation, not a real fix (post-verification finding,
  // 2026-09-14): pbx_configs' [from-dinstar]/AI_INBOUND_EXTENSION() has no
  // per-DID/per-tenant routing — it is a SHARED Asterisk instance that
  // resolves ONE globally-enabled AI-kind Extension for every tenant's
  // inbound calls (see func_odbc.conf's own header). Until real per-DID
  // routing ships, enabling a second tenant's AiAgent while another
  // tenant's is already enabled would silently route that tenant's callers
  // to a DIFFERENT tenant's AI agent — a real cross-tenant leak, not just a
  // UX limitation. This is a stopgap app-layer guard, checked with
  // unsafeGlobalDb (deliberately unscoped — the whole point is to see
  // OTHER tenants' rows) rather than a proper fix.
  if (data.enabled === true) {
    const otherEnabled = await unsafeGlobalDb.aiAgent.findFirst({
      where: { enabled: true, id: { not: params.id }, tenantId: { not: (await db.aiAgent.findUnique({ where: { id: params.id }, select: { tenantId: true } }))?.tenantId } },
      select: { id: true },
    });
    if (otherEnabled) {
      return NextResponse.json(
        {
          error:
            "Another tenant already has an AI agent enabled on this Asterisk instance. Per-DID AI routing isn't built yet, so only one tenant may run AI agents at a time — disable the other tenant's agent first.",
        },
        { status: 409 }
      );
    }
  }

  // Any credential id supplied must be a real AiProviderCredential
  // belonging to this tenant — `db` is already tenant-scoped, so a
  // `findUnique` for a cross-tenant id simply returns null here, same as
  // a typo'd id would.
  for (const field of CREDENTIAL_ID_FIELDS) {
    const value = data[field];
    if (value) {
      const credential = await db.aiProviderCredential.findUnique({ where: { id: value }, select: { id: true } });
      if (!credential) {
        return NextResponse.json({ error: `${field}: no such provider credential for this tenant.` }, { status: 400 });
      }
    }
  }

  // handoffNumberE164: normalize + validate rather than trust the client's
  // formatting — same normalizeToE164() the DNC importer and the outbound
  // compliance check already use as the single source of truth for "is this
  // a real phone number" in this codebase.
  if (data.handoffNumberE164) {
    const normalized = normalizeToE164(data.handoffNumberE164);
    if (!normalized) {
      return NextResponse.json({ error: "handoffNumberE164: not a valid phone number." }, { status: 400 });
    }
    data.handoffNumberE164 = normalized;
  }

  // handoffExtensionId must resolve to a same-tenant, HUMAN-kind Extension —
  // `db` is tenant-scoped so a cross-tenant id already returns null here,
  // same as CREDENTIAL_ID_FIELDS above; agentType is checked explicitly
  // since an AI-kind extension has no PJSIP registration to ring at all
  // (see Extension.agentType's schema comment).
  if (data.handoffExtensionId) {
    const target = await db.extension.findUnique({
      where: { id: data.handoffExtensionId },
      select: { id: true, agentType: true },
    });
    if (!target || target.agentType !== "HUMAN") {
      return NextResponse.json(
        { error: "handoffExtensionId: no such human extension for this tenant." },
        { status: 400 }
      );
    }
  }

  let agent;
  try {
    agent = await db.aiAgent.update({
      where: { id: params.id },
      data: data as unknown as Prisma.AiAgentUncheckedUpdateInput,
      select: AGENT_DETAIL_SELECT,
    });
  } catch (err) {
    // Follow-up to §34 (LLM.md, 2026-09-14): P2002 on
    // AiAgent_tenantId_dinstarPort_key means another agent on this tenant
    // already holds the requested GSM port — a clear 409, not a raw Prisma
    // constraint error (same pattern as the create route / this repo's
    // existing admin/contacts P2002 handling).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && data.dinstarPort) {
      return NextResponse.json(
        { error: `GSM port ${data.dinstarPort} is already assigned to another AI agent — unassign it there first.` },
        { status: 409 }
      );
    }
    throw err;
  }

  return NextResponse.json({ agent });
});
