import { NextRequest, NextResponse } from "next/server";
import { tenantDb } from "@/lib/db-tenant";
import { decryptSetting } from "@/lib/settings/crypto";
import { withApiErrorHandler } from "@/lib/api-handler";
import { isAuthorizedInternalAiRequest } from "@/app/api/internal/ai/_auth";
import type { AiAgentConfigResponse, AiProviderKind } from "@/lib/ai/types";

export const dynamic = "force-dynamic";

// GET /api/internal/ai/agent-config?ext=<extension number>&tenant=<tenantId>
//
// Called by the sidecar (W4) instead of its upstream YAML personas. Machine-
// to-machine only — see ../_auth.ts. Per
// .agents/hybrid-ai/contracts.md: "inbound answer is always allowed unless
// AiAgent.enabled === false" — this route never calls W8's checkOutbound();
// that gate is for actual outbound dial attempts, not config fetch.
export const GET = withApiErrorHandler(async function GET(req: NextRequest) {
  if (!isAuthorizedInternalAiRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const extNumber = searchParams.get("ext");
  const tenantId = searchParams.get("tenant");
  if (!extNumber || !tenantId) {
    return NextResponse.json({ error: "ext and tenant query params are required" }, { status: 400 });
  }

  const db = tenantDb(tenantId);

  const extension = await db.extension.findUnique({
    where: { tenantId_number: { tenantId, number: extNumber } },
    select: {
      id: true,
      number: true,
      agentType: true,
      aiAgent: {
        include: {
          // Only needed to resolve handoffExtensionHint below when the
          // target is an internal extension rather than an external number
          // — see the escalation-hint block after `response` is built.
          handoffExtension: { select: { number: true } },
        },
      },
    },
  });

  // Not an AI extension (HUMAN, or no such extension at all) — same 404
  // either way, so this endpoint never distinguishes "wrong number" from
  // "not an AI extension" to an unauthenticated-past-the-shared-secret
  // caller.
  if (!extension || extension.agentType !== "AI" || !extension.aiAgent) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const agent = extension.aiAgent;
  if (!agent.enabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Each configured leg stores a *credential id* (an AiProviderCredential
  // row, per-tenant), not a raw provider name — resolved and decrypted here
  // so the sidecar never sees AiProviderCredential.apiKeyCipher.
  async function resolveCredential(credentialId: string | null) {
    if (!credentialId) return null;
    const credential = await db.aiProviderCredential.findUnique({ where: { id: credentialId } });
    if (!credential) return null;
    return {
      provider: credential.provider as AiProviderKind,
      apiKey: decryptSetting(credential.apiKeyCipher),
      region: credential.region ?? null,
      baseUrl: credential.baseUrl ?? null,
    };
  }

  const [realtimeCred, sttCred, llmCred, ttsCred] = await Promise.all([
    resolveCredential(agent.realtimeProviderId),
    resolveCredential(agent.sttProviderId),
    resolveCredential(agent.llmProviderId),
    resolveCredential(agent.ttsProviderId),
  ]);

  const response: AiAgentConfigResponse = {
    agentId: agent.id,
    extensionNumber: extension.number,
    language: agent.language,
    // The disclosure greeting itself is enforced where AiAgent.greeting is
    // authored (compliance/geo work, W8/W7) — this route passes through
    // whatever is stored, it does not compose or validate the disclosure
    // text.
    greeting: agent.greeting,
    systemPrompt: agent.systemPrompt,
    pipelineMode: agent.pipelineMode === "REALTIME" ? "REALTIME" : "CASCADE",
    tools: agent.tools ?? null,
    outboundEnabled: agent.outboundEnabled,
    // Non-null tells the sidecar escalation is available AND gives it the
    // dial target in one field (see config_client.py's handoff_extension_hint
    // and pipeline/runner.py, which only advertises the request_human_handoff
    // tool when this is set — an agent with escalationEnabled=false, or one
    // that's enabled but never had a target picked in the admin UI, must get
    // null here, not a stale/empty string). "NUMBER" targets are dialed out
    // over the GSM trunk from the AI's own extension per the owner's
    // requirement (see LLM.md §34.2); "EXTENSION" targets resolve to the
    // linked human extension's number, same shape the sidecar already
    // expects for either case (it just dials whatever string it's given).
    handoffExtensionHint:
      agent.escalationEnabled
        ? agent.handoffTargetKind === "NUMBER"
          ? agent.handoffNumberE164 ?? null
          : agent.handoffTargetKind === "EXTENSION"
            ? agent.handoffExtension?.number ?? null
            : null
        : null,
  };

  if (realtimeCred && agent.realtimeModel) {
    response.realtime = {
      provider: realtimeCred.provider,
      model: agent.realtimeModel,
      apiKey: realtimeCred.apiKey,
      region: realtimeCred.region,
    };
  }
  if (sttCred && agent.sttModel) {
    response.stt = {
      provider: sttCred.provider,
      model: agent.sttModel,
      apiKey: sttCred.apiKey,
      region: sttCred.region,
    };
  }
  if (llmCred && agent.llmModel) {
    response.llm = {
      provider: llmCred.provider,
      model: agent.llmModel,
      apiKey: llmCred.apiKey,
      baseUrl: llmCred.baseUrl,
    };
  }
  if (ttsCred && agent.ttsModel) {
    response.tts = {
      provider: ttsCred.provider,
      model: agent.ttsModel,
      voice: agent.ttsVoice ?? null,
      apiKey: ttsCred.apiKey,
      region: ttsCred.region,
    };
  }

  return NextResponse.json(response);
});
