// Shared contracts for the premium "Hybrid AI + Human" plan (LLM.md
// decision, 2026-09-14). This file is the frozen interface between the
// nodes that build this feature in parallel — see
// .agents/hybrid-ai/contracts.md for the full task-graph writeup. Workers
// import from here; nobody redefines these shapes locally. A change to
// this file is a contract change and goes back through the coordinator.

// --- Provider adapters (W3, consumed by W6/W7) -----------------------------

export type AiProviderKind =
  | "openai"
  | "anthropic"
  | "gemini"
  | "groq"
  | "deepgram"
  | "elevenlabs"
  | "cartesia"
  | "sarvam"
  | "assemblyai"
  | "azure"
  | "ultravox"
  | "openai_compatible" // OpenRouter, Together, Azure OpenAI, Sarvam-M — generic adapter
  | "retell" // platform provider, routed via SIP — media stays with the vendor
  | "vapi"; // platform provider, routed via SIP — media stays with the vendor

export type AiModelCapability = "stt" | "llm" | "tts" | "realtime" | "voice";

export interface AiModelInfo {
  id: string;
  label?: string;
  capabilities: AiModelCapability[];
}

export interface AiProviderAdapter {
  provider: AiProviderKind;
  /** Live providers hit the vendor's list-models endpoint; static ones return a fixed catalog. */
  supportsLiveModelList: boolean;
  listModels(input: { apiKey: string; region?: string | null; baseUrl?: string | null }): Promise<AiModelInfo[]>;
}

// --- Internal APIs the sidecar (W4) calls, served by W6 --------------------

/** GET /api/internal/ai/agent-config?ext=<extension number>&tenant=<tenantId>
 *  Auth: shared-secret header `x-internal-secret`, checked against
 *  process.env.AI_SIDECAR_SHARED_SECRET. Never exposed to the browser. */
export interface AiAgentConfigResponse {
  agentId: string;
  extensionNumber: string;
  language: string;
  greeting: string; // always includes the automated-call disclosure — enforced server-side, not sidecar-side
  systemPrompt: string;
  pipelineMode: "REALTIME" | "CASCADE";
  // "SIMPLE" (default) means `workflow` below is omitted/null and the
  // sidecar drives the call purely off `systemPrompt`, exactly as before
  // this field existed. "WORKFLOW" with `workflow` present means the node
  // graph in `workflow.graph` drives the call instead — see
  // ai-voice-agent/pipeline/workflow.py. A WORKFLOW agent with no
  // *published* version also resolves to SIMPLE server-side (this route
  // never emits an unpublished draft) — publishing is explicit, so a
  // half-built graph can never reach a live call.
  promptMode: "SIMPLE" | "WORKFLOW";
  workflow?: AiWorkflowRuntime | null;
  realtime?: { provider: AiProviderKind; model: string; apiKey: string; region?: string | null; baseUrl?: string | null };
  stt?: { provider: AiProviderKind; model: string; apiKey: string; region?: string | null; language?: string | null };
  llm?: {
    provider: AiProviderKind;
    model: string;
    apiKey: string;
    baseUrl?: string | null;
    temperature?: number | null;
    maxTokens?: number | null;
  };
  tts?: {
    provider: AiProviderKind;
    model: string;
    voice?: string | null;
    apiKey: string;
    region?: string | null;
    baseUrl?: string | null;
    speed?: number | null;
  };
  tools: unknown | null;
  outboundEnabled: boolean; // ships false; sidecar must refuse to originate calls when false
  handoffExtensionHint?: string | null; // e.g. the tenant's support_queue, for "transfer to a human"
  // Interruption / VAD tunables. Every field null means "use the sidecar's
  // own hardcoded defaults" — unchanged behavior for every agent that
  // predates these columns (see AiAgent's migration comment).
  vad?: {
    allowInterruption: boolean;
    energyThreshold?: number | null;
    endOfUtteranceSilentFrames?: number | null;
    bargeInThreshold?: number | null;
    bargeInConsecutiveFrames?: number | null;
  };
}

/** One resolved leg's credential + model, used inside a workflow node's
 * `resolved` block below — same shape as the top-level `llm`/`tts` legs
 * above, factored out because a node's model override resolves to exactly
 * one of these per capability it overrides. */
export interface AiResolvedLeg {
  provider: AiProviderKind;
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  region?: string | null;
  voice?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  speed?: number | null;
}

/** The published workflow graph, with every node's `modelOverride` already
 * resolved to real credentials server-side (agent-config/route.ts dedupes
 * this by credential id across the whole graph before responding) — the
 * sidecar stays completely credential-ignorant, exactly like the top-level
 * legs above. `graph` is `AiWorkflowGraph` from workflow-schema.ts (kept as
 * `unknown` here to avoid a frontend-lib→sidecar-adjacent circular import;
 * the sidecar's own `pipeline/workflow.py` parses it against the same shape
 * independently, per the "frozen contract, mirrored not shared" convention
 * this file already uses). */
export interface AiWorkflowRuntime {
  version: number;
  graph: unknown;
  resolvedByNodeId: Record<string, { llm?: AiResolvedLeg | null; tts?: AiResolvedLeg | null }>;
}

/** POST /api/internal/ai/sessions — sidecar reports what happened on a call. */
export interface AiSessionReportRequest {
  agentId: string;
  cdrUniqueId: string;
  transcript: Array<{ role: "agent" | "caller"; text: string; at: string }>;
  summary?: string;
  latencyMsP50?: number;
  latencyMsP95?: number;
  costTokensInput?: number;
  costTokensOutput?: number;
  outcome: "completed" | "handed_off" | "dropped" | "error";
  handoffExtensionId?: string | null;
  // Workflow-builder debuggability (2026-09-15) — absent/undefined for a
  // SIMPLE-mode call, exactly as before these fields existed. See
  // AiCallSession's schema comment for why this is the only record of
  // which nodes a workflow call visited.
  gatheredContext?: Record<string, unknown> | null;
  nodePath?: string[] | null;
}

// --- Compliance (W8), called from W6's agent-config route -------------------

export interface AiComplianceCheckInput {
  tenantId: string;
  agentId: string;
  destinationE164: string;
  nowUtc: Date;
  destinationLocalUtcOffsetMinutes: number;
}

export interface AiComplianceDecision {
  allowed: boolean;
  reason?: string; // e.g. "destination not in allowedDestinations", "outside callHours", "DNC listed"
}

// --- Seats (W1), consumed by W7's UI seat meter -----------------------------

export interface SeatUsage {
  seatsTotal: number;
  seatsUsed: number; // HUMAN + AI extensions
  seatsAvailable: number;
}
