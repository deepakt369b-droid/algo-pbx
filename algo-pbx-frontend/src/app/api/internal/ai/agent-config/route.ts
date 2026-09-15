import { NextRequest, NextResponse } from "next/server";
import { tenantDb } from "@/lib/db-tenant";
import { decryptSetting } from "@/lib/settings/crypto";
import { withApiErrorHandler } from "@/lib/api-handler";
import { isAuthorizedInternalAiRequest } from "@/app/api/internal/ai/_auth";
import type { AiAgentConfigResponse, AiProviderKind, AiResolvedLeg, AiWorkflowRuntime } from "@/lib/ai/types";
import { AiWorkflowGraphSchema, type WorkflowNode } from "@/lib/ai/workflow-schema";
import { sttLanguageTag } from "@/lib/ai/languages";

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
          // Only the PUBLISHED version is ever read here — a draft can
          // never reach a live call (see AiWorkflow's schema comment).
          workflow: { include: { publishedVersion: true } },
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
  // so the sidecar never sees AiProviderCredential.apiKeyCipher. A single
  // per-request cache means a workflow graph referencing the same
  // credential from many nodes' modelOverride only ever decrypts it once —
  // a 20-node graph must not issue 20 findUnique calls for what is very
  // often the agent's own default credential repeated on every node.
  const credentialCache = new Map<string, Awaited<ReturnType<typeof resolveCredentialUncached>> | null>();
  async function resolveCredentialUncached(credentialId: string) {
    const credential = await db.aiProviderCredential.findUnique({ where: { id: credentialId } });
    if (!credential) return null;
    return {
      provider: credential.provider as AiProviderKind,
      apiKey: decryptSetting(credential.apiKeyCipher),
      region: credential.region ?? null,
      baseUrl: credential.baseUrl ?? null,
    };
  }
  async function resolveCredential(credentialId: string | null) {
    if (!credentialId) return null;
    if (!credentialCache.has(credentialId)) {
      credentialCache.set(credentialId, await resolveCredentialUncached(credentialId));
    }
    return credentialCache.get(credentialId) ?? null;
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
    // A WORKFLOW agent with no published version resolves to SIMPLE here —
    // never emit `promptMode: "WORKFLOW"` without a `workflow` block, or the
    // sidecar would have nothing to interpret.
    promptMode: agent.promptMode === "WORKFLOW" && agent.workflow?.publishedVersion ? "WORKFLOW" : "SIMPLE",
    tools: agent.tools ?? null,
    outboundEnabled: agent.outboundEnabled,
    vad: {
      allowInterruption: agent.allowInterruption,
      energyThreshold: agent.vadEnergyThreshold ?? null,
      endOfUtteranceSilentFrames: agent.vadSilenceFrames ?? null,
      bargeInThreshold: agent.bargeInThreshold ?? null,
      bargeInConsecutiveFrames: agent.bargeInConsecutiveFrames ?? null,
    },
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
      baseUrl: realtimeCred.baseUrl,
    };
  }
  if (sttCred && agent.sttModel) {
    response.stt = {
      provider: sttCred.provider,
      model: agent.sttModel,
      apiKey: sttCred.apiKey,
      region: sttCred.region,
      // Explicit AiAgent.sttLanguage always wins (an admin override); else
      // derive a provider-correct tag from the agent's own `language` field
      // via languages.ts — this is the whole reason that module exists,
      // rather than making the Python sidecar guess a provider's tag
      // format from a bare BCP-47-ish string.
      language: agent.sttLanguage ?? sttLanguageTag(agent.language),
    };
  }
  if (llmCred && agent.llmModel) {
    response.llm = {
      provider: llmCred.provider,
      model: agent.llmModel,
      apiKey: llmCred.apiKey,
      baseUrl: llmCred.baseUrl,
      temperature: agent.llmTemperature ?? null,
      maxTokens: agent.llmMaxTokens ?? null,
    };
  }
  if (ttsCred && agent.ttsModel) {
    response.tts = {
      provider: ttsCred.provider,
      model: agent.ttsModel,
      voice: agent.ttsVoice ?? null,
      apiKey: ttsCred.apiKey,
      region: ttsCred.region,
      baseUrl: ttsCred.baseUrl,
      speed: agent.ttsSpeed ?? null,
    };
  }

  if (response.promptMode === "WORKFLOW" && agent.workflow?.publishedVersion) {
    response.workflow = await resolveWorkflowRuntime(agent.workflow.publishedVersion, resolveCredential, agent);
  }

  return NextResponse.json(response);
});

/** Parses the published graph and resolves every node's `modelOverride` to
 * real credentials, using the shared (deduped) `resolveCredential` cache -
 * the sidecar never sees a credential id, only the already-decrypted
 * result, same as every top-level leg above. A node with no override for a
 * given capability gets no entry for it in `resolvedByNodeId[nodeId]`; the
 * sidecar falls back to the agent's own top-level `llm`/`tts` leg in that
 * case (see pipeline/workflow.py's per-node provider resolution). */
async function resolveWorkflowRuntime(
  publishedVersion: { version: number; graph: unknown },
  resolveCredential: (id: string | null) => Promise<{
    provider: AiProviderKind;
    apiKey: string;
    region: string | null;
    baseUrl: string | null;
  } | null>,
  agent: { ttsVoice: string | null },
): Promise<AiWorkflowRuntime | null> {
  const parsed = AiWorkflowGraphSchema.safeParse(publishedVersion.graph);
  if (!parsed.success) {
    // A published version should always parse (publish requires a strict
    // parse) - if it doesn't, something wrote to this row outside the
    // publish endpoint. Fail closed to SIMPLE-equivalent behavior (no
    // workflow) rather than sending the sidecar a graph it can't trust.
    return null;
  }

  const resolvedByNodeId: AiWorkflowRuntime["resolvedByNodeId"] = {};
  for (const node of parsed.data.nodes as WorkflowNode[]) {
    const override = node.modelOverride;
    if (!override) continue;
    const entry: { llm?: AiResolvedLeg | null; tts?: AiResolvedLeg | null } = {};

    if (override.llmProviderId) {
      const cred = await resolveCredential(override.llmProviderId);
      if (cred && override.llmModel) {
        entry.llm = {
          provider: cred.provider,
          model: override.llmModel,
          apiKey: cred.apiKey,
          baseUrl: cred.baseUrl,
          temperature: override.temperature ?? null,
          maxTokens: override.maxTokens ?? null,
        };
      }
    }
    if (override.ttsProviderId) {
      const cred = await resolveCredential(override.ttsProviderId);
      if (cred && override.ttsModel) {
        entry.tts = {
          provider: cred.provider,
          model: override.ttsModel,
          apiKey: cred.apiKey,
          region: cred.region,
          baseUrl: cred.baseUrl,
          voice: override.ttsVoice ?? agent.ttsVoice ?? null,
          speed: override.ttsSpeed ?? null,
        };
      }
    }
    if (entry.llm || entry.tts) resolvedByNodeId[node.id] = entry;
  }

  return { version: publishedVersion.version, graph: parsed.data, resolvedByNodeId };
}
