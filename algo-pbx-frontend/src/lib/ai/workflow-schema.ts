// Conversation-workflow graph shape + validation. Single source of truth for
// BOTH the admin API (src/app/api/admin/ai/agents/[id]/workflow/*) and the
// canvas UI (src/components/ai-workflow/**) — neither reimplements these
// rules locally. Independently designed against Dograh's node-graph concept
// (Start Call / Agent / End Call / transitions-as-tools) — no code or schema
// copied; see LLM.md's workflow-builder plan for the full reasoning behind
// every structural decision below.
//
// Runtime counterpart: ai-voice-agent/pipeline/workflow.py mirrors this
// shape field-for-field and must not drift from it, same "frozen contract"
// discipline as src/lib/ai/types.ts's AiAgentConfigResponse.

import { z } from "zod";

export const AI_WORKFLOW_SCHEMA_VERSION = 1 as const;

export const NodeKindSchema = z.enum(["START_CALL", "AGENT", "END_CALL", "TRANSFER", "GLOBAL", "HTTP_TOOL"]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

// Initial-context fields the sidecar can populate before the first turn —
// deliberately a small, fixed allowlist (not "anything on the call"), so a
// template reference can be validated at publish time rather than only
// discovered as a runtime KeyError.
export const INITIAL_CONTEXT_FIELDS = ["caller_number", "called_extension", "agent_name", "now_local"] as const;

const IdentifierName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/i, "must start with a letter and contain only letters, digits, and underscores");

export const VariableSpecSchema = z.object({
  name: IdentifierName,
  type: z.enum(["string", "number", "boolean"]),
  // What the model should look for / extract - NOT the variable's value.
  prompt: z.string().min(1).max(500),
});
export type VariableSpec = z.infer<typeof VariableSpecSchema>;

// All optional/nullable - absent or null means "inherit the agent's own
// setting" (AiAgent.llmProviderId/llmModel/... or the new model-config
// columns). Mirrors ai-voice-agent/pipeline/base.py's ProviderLegConfig
// shape for the fields it actually varies per node.
export const ModelOverrideSchema = z
  .object({
    llmProviderId: z.string().nullable().optional(),
    llmModel: z.string().nullable().optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    maxTokens: z.number().int().min(16).max(8192).nullable().optional(),
    ttsProviderId: z.string().nullable().optional(),
    ttsModel: z.string().nullable().optional(),
    ttsVoice: z.string().nullable().optional(),
    ttsSpeed: z.number().min(0.5).max(2.0).nullable().optional(),
  })
  .strict();
export type ModelOverride = z.infer<typeof ModelOverrideSchema>;
export const EMPTY_MODEL_OVERRIDE: ModelOverride = {};

const HttpToolHeaderSchema = z.object({
  name: z.string().min(1).max(100),
  // May reference {{secrets.NAME}} - resolved server-side only, in
  // POST /api/internal/ai/http-tool; never sent to the sidecar or browser.
  valueTemplate: z.string().max(2000),
});

const HttpToolResponseMappingSchema = z.object({
  // A dot-path into the parsed JSON response body, e.g. "data.slots" or
  // "0.id" for an array index. Deliberately NOT a full JSONPath grammar -
  // this is a tool-result mapper, not a query language.
  jsonPath: z.string().min(1).max(200),
  intoVariable: IdentifierName,
});

const NodePositionSchema = z.object({ x: z.number(), y: z.number() });

const NodeBaseFields = {
  // Client-generated (nanoid or similar), stable across edits so edges and
  // React Flow's own node identity never have to be re-keyed on save.
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(60),
  position: NodePositionSchema,
  prompt: z.string().max(8000).default(""),
  allowInterruption: z.boolean().default(true),
  variables: z.array(VariableSpecSchema).max(10).default([]),
  modelOverride: ModelOverrideSchema.default(EMPTY_MODEL_OVERRIDE),
};

const StartCallNodeSchema = z.object({ kind: z.literal("START_CALL"), ...NodeBaseFields });
const AgentNodeSchema = z.object({ kind: z.literal("AGENT"), ...NodeBaseFields });
const EndCallNodeSchema = z.object({ kind: z.literal("END_CALL"), ...NodeBaseFields });
const GlobalNodeSchema = z.object({ kind: z.literal("GLOBAL"), ...NodeBaseFields });

const TransferNodeSchema = z.object({
  kind: z.literal("TRANSFER"),
  ...NodeBaseFields,
  transferTargetKind: z.enum(["NUMBER", "EXTENSION", "AGENT_DEFAULT"]).nullable().default(null),
  transferNumberE164: z.string().nullable().default(null),
  transferExtensionId: z.string().nullable().default(null),
});

const HttpToolNodeSchema = z.object({
  kind: z.literal("HTTP_TOOL"),
  ...NodeBaseFields,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  urlTemplate: z.string().min(1).max(2000),
  headers: z.array(HttpToolHeaderSchema).max(20).default([]),
  bodyTemplate: z.string().max(8000).nullable().default(null),
  timeoutMs: z.number().int().min(500).max(10_000).default(5000),
  responseMapping: z.array(HttpToolResponseMappingSchema).max(20).default([]),
});

export const WorkflowNodeSchema = z.discriminatedUnion("kind", [
  StartCallNodeSchema,
  AgentNodeSchema,
  EndCallNodeSchema,
  TransferNodeSchema,
  GlobalNodeSchema,
  HttpToolNodeSchema,
]);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1).max(64),
  source: z.string().min(1),
  target: z.string().min(1),
  // The LLM-facing pathway description - this string IS the mechanism: the
  // sidecar turns it verbatim into a tool's `description` (see
  // pipeline/workflow.py's pathway_tools()), and the model decides which
  // edge to take by choosing which tool to call.
  condition: z.string().min(1).max(300),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

const TEMPLATE_REF_RE = /\{\{\s*([a-z_][a-z0-9_.]*)\s*\}\}/gi;

export interface WorkflowValidationIssue {
  path: string; // "" for a graph-level issue, otherwise a node/edge id
  message: string;
  severity: "error" | "warning";
}

function collectTemplateRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(TEMPLATE_REF_RE)) refs.push(match[1]);
  return refs;
}

/** Shared validation used by both the publish endpoint (strict - any error
 * blocks publish) and the canvas (rendered as inline issue markers,
 * including warnings, on every draft save). Kept as a plain function
 * returning an issue list - rather than a zod `.superRefine` throwing on
 * the first problem - because the UI needs ALL issues at once to annotate
 * every broken node/edge in a single pass, not just the first one found. */
export function validateWorkflowGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const nodeIds = new Set(nodes.map((n) => n.id));

  const startNodes = nodes.filter((n) => n.kind === "START_CALL");
  if (startNodes.length === 0) issues.push({ path: "", message: "The graph needs a Start Call node.", severity: "error" });
  if (startNodes.length > 1)
    issues.push({ path: "", message: "Only one Start Call node is allowed.", severity: "error" });

  const globalNodes = nodes.filter((n) => n.kind === "GLOBAL");
  if (globalNodes.length > 1) issues.push({ path: "", message: "Only one Global node is allowed.", severity: "error" });

  const outgoingBySource = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      issues.push({ path: edge.id, message: `Edge source "${edge.source}" does not exist.`, severity: "error" });
      continue;
    }
    if (!nodeIds.has(edge.target)) {
      issues.push({ path: edge.id, message: `Edge target "${edge.target}" does not exist.`, severity: "error" });
      continue;
    }
    if (edge.source === edge.target) {
      issues.push({ path: edge.id, message: "A node cannot connect to itself.", severity: "error" });
      continue;
    }
    const list = outgoingBySource.get(edge.source) ?? [];
    list.push(edge);
    outgoingBySource.set(edge.source, list);
  }

  for (const node of nodes) {
    const outgoing = outgoingBySource.get(node.id) ?? [];

    if (node.kind === "GLOBAL" && outgoing.length > 0) {
      issues.push({ path: node.id, message: "The Global node cannot have outgoing edges.", severity: "error" });
    }
    if ((node.kind === "END_CALL" || node.kind === "TRANSFER") && outgoing.length > 0) {
      issues.push({ path: node.id, message: `A ${node.kind} node is terminal and cannot have outgoing edges.`, severity: "error" });
    }
    if (node.kind === "AGENT") {
      if (!node.prompt.trim()) {
        issues.push({ path: node.id, message: "Agent node needs a prompt.", severity: "error" });
      }
      if (outgoing.length === 0) {
        issues.push({ path: node.id, message: "Agent node has no outgoing edges - the call would dead-end here.", severity: "error" });
      }
    }
    if (node.kind === "HTTP_TOOL" && outgoing.length === 0) {
      issues.push({ path: node.id, message: "HTTP tool node has no outgoing edges - the call would dead-end here.", severity: "error" });
    }

    const conditionCounts = new Map<string, number>();
    for (const edge of outgoing) conditionCounts.set(edge.condition, (conditionCounts.get(edge.condition) ?? 0) + 1);
    for (const [condition, count] of conditionCounts) {
      if (count > 1) {
        issues.push({
          path: node.id,
          message: `Two outgoing edges share the condition "${condition}" - the AI cannot tell them apart.`,
          severity: "error",
        });
      }
    }
  }

  // Reachability from Start Call - unreachable nodes are a warning (dead
  // weight in the graph, not necessarily wrong yet mid-edit) while "no
  // terminal reachable at all" is a hard error.
  if (startNodes.length === 1) {
    const reachable = new Set<string>([startNodes[0].id]);
    const queue = [startNodes[0].id];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      for (const edge of outgoingBySource.get(current) ?? []) {
        if (!reachable.has(edge.target)) {
          reachable.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    for (const node of nodes) {
      if (node.kind === "GLOBAL") continue; // not part of the traversal graph by design
      if (!reachable.has(node.id)) {
        issues.push({ path: node.id, message: "This node is unreachable from Start Call.", severity: "warning" });
      }
    }
    const hasReachableTerminal = nodes.some(
      (n) => (n.kind === "END_CALL" || n.kind === "TRANSFER") && reachable.has(n.id),
    );
    if (!hasReachableTerminal) {
      issues.push({ path: "", message: "No End Call or Transfer node is reachable - the call could never end.", severity: "error" });
    }
  }

  // Template references: {{gathered_context.X}} must resolve to a variable
  // declared on a node, {{initial_context.X}} must be in the fixed allowlist.
  const declaredVariables = new Set(nodes.flatMap((n) => n.variables.map((v) => v.name)));
  for (const node of nodes) {
    for (const ref of collectTemplateRefs(node.prompt)) {
      const [scope, ...rest] = ref.split(".");
      const field = rest.join(".");
      if (scope === "gathered_context") {
        if (!declaredVariables.has(field)) {
          issues.push({ path: node.id, message: `{{gathered_context.${field}}} is not declared as a variable on any node.`, severity: "error" });
        }
      } else if (scope === "initial_context") {
        if (!(INITIAL_CONTEXT_FIELDS as readonly string[]).includes(field)) {
          issues.push({ path: node.id, message: `{{initial_context.${field}}} is not a recognized field.`, severity: "error" });
        }
      } else {
        issues.push({ path: node.id, message: `{{${ref}}} must start with "gathered_context." or "initial_context.".`, severity: "error" });
      }
    }
  }

  return issues;
}

export const AiWorkflowGraphSchema = z.object({
  schemaVersion: z.literal(AI_WORKFLOW_SCHEMA_VERSION),
  nodes: z.array(WorkflowNodeSchema).min(1).max(60),
  edges: z.array(WorkflowEdgeSchema).max(200),
});
export type AiWorkflowGraph = z.infer<typeof AiWorkflowGraphSchema>;

export interface ParsedWorkflow {
  graph: AiWorkflowGraph | null;
  /** zod structural errors (wrong types, missing fields) plus
   * validateWorkflowGraph()'s semantic issues, merged into one list so a
   * caller doesn't have to reconcile two different shapes of error. */
  issues: WorkflowValidationIssue[];
}

/** Lenient parse for draft saves - stores regardless of validity so an
 * in-progress canvas edit is never lost, but still reports every issue for
 * inline display. */
export function parseWorkflowDraft(input: unknown): ParsedWorkflow {
  const result = AiWorkflowGraphSchema.safeParse(input);
  if (!result.success) {
    return {
      graph: null,
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, severity: "error" })),
    };
  }
  const semanticIssues = validateWorkflowGraph(result.data.nodes, result.data.edges);
  return { graph: result.data, issues: semanticIssues };
}

/** Strict parse for publish - throws-shaped via the returned issues list;
 * callers must treat ANY "error"-severity issue as a publish blocker.
 * Also enforces the one cross-cutting rule that isn't about graph shape:
 * WORKFLOW mode is incompatible with Gemini Live realtime, because Gemini's
 * `setup` message is send-once-at-connection with no mid-session
 * instruction swap (see ai-voice-agent/pipeline/providers/gemini.py's
 * GeminiRealtime class docstring) - a node transition would have no way to
 * actually move the live call to the new node's instructions. */
export function parseWorkflowForPublish(
  input: unknown,
  opts: { pipelineMode: "REALTIME" | "CASCADE"; realtimeProvider?: string | null },
): ParsedWorkflow {
  const parsed = parseWorkflowDraft(input);
  if (opts.pipelineMode === "REALTIME" && opts.realtimeProvider === "gemini") {
    parsed.issues.push({
      path: "",
      message:
        "Gemini Live cannot change instructions mid-call, so it cannot run a workflow. Use CASCADE mode or OpenAI Realtime instead.",
      severity: "error",
    });
  }
  return parsed;
}

export function hasBlockingIssues(issues: WorkflowValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
