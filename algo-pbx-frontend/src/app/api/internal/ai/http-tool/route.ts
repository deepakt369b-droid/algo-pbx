import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withApiErrorHandler } from "@/lib/api-handler";
import { isAuthorizedInternalAiRequest } from "@/app/api/internal/ai/_auth";
import { unsafeGlobalDb } from "@/lib/db";
import { tenantDb } from "@/lib/db-tenant";
import { decryptSetting } from "@/lib/settings/crypto";
import { assertPublicHttpUrl } from "@/lib/ai/providers/_fetch";
import { AiWorkflowGraphSchema, type WorkflowNode } from "@/lib/ai/workflow-schema";

export const dynamic = "force-dynamic";

// POST /api/internal/ai/http-tool — the ONLY place an HTTP_TOOL workflow
// node's actual outbound request happens. The sidecar (ai-voice-agent/
// http_tool_client.py) runs with `network_mode: host` and must never be
// handed a tenant-authored URL to fetch directly — that would be a
// materially worse SSRF position than the one already fixed for provider
// baseUrls in §34 (src/lib/ai/providers/_fetch.ts's assertPublicHttpUrl,
// reused here unchanged). This route re-reads the node from the tenant's
// PUBLISHED workflow version — it NEVER trusts a URL/headers/body the
// sidecar might send, only `{agentId, nodeId, gatheredContext}} — resolves
// `{{secrets.NAME}}` from AiWorkflowSecret server-side, and enforces the
// same public-host guard before dispatching.
const RequestSchema = z.object({
  agentId: z.string().min(1),
  nodeId: z.string().min(1),
  gatheredContext: z.record(z.unknown()).default({}),
});

const TEMPLATE_REF_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

// Deliberately supports only `gathered_context.X` and `secrets.X` — NOT
// `initial_context.X` (caller_number/etc): the sidecar's http_tool_client
// only sends agentId/nodeId/gatheredContext today, so caller-identity
// template refs would silently render empty here. Stated limitation, not
// hidden — see http_tool_client.py's own docstring on why gatheredContext
// specifically is what gets threaded through.
function renderTemplate(template: string, gatheredContext: Record<string, unknown>, secrets: Record<string, string>): string {
  return template.replace(TEMPLATE_REF_RE, (_match, ref: string) => {
    const dot = ref.indexOf(".");
    const scope = dot === -1 ? ref : ref.slice(0, dot);
    const field = dot === -1 ? "" : ref.slice(dot + 1);
    if (scope === "gathered_context") {
      const value = gatheredContext[field];
      return value === undefined || value === null ? "" : String(value);
    }
    if (scope === "secrets") {
      return secrets[field] ?? "";
    }
    return "";
  });
}

function getByPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (Array.isArray(acc)) {
      const index = Number(key);
      return Number.isInteger(index) ? acc[index] : undefined;
    }
    if (typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  if (!isAuthorizedInternalAiRequest(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const parsed = RequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  const { agentId, nodeId, gatheredContext } = parsed.data;

  // Unscoped lookup, same reasoning as sessions.ts's recordAiSession(): the
  // sidecar's request carries only agentId, not a tenantId — resolve the
  // owning tenant once here, then every actual data access below goes
  // through tenantDb(tenantId).
  const agent = await unsafeGlobalDb.aiAgent.findUnique({
    where: { id: agentId },
    select: { tenantId: true, workflow: { select: { publishedVersion: { select: { graph: true } } } } },
  });
  if (!agent || !agent.workflow?.publishedVersion) {
    return NextResponse.json({ ok: false, error: "no_published_workflow" }, { status: 404 });
  }

  const graphParse = AiWorkflowGraphSchema.safeParse(agent.workflow.publishedVersion.graph);
  if (!graphParse.success) {
    // Should be unreachable — publish only ever stores a strict-parsed
    // graph — but fail closed rather than trust a malformed stored blob.
    return NextResponse.json({ ok: false, error: "graph_unreadable" }, { status: 500 });
  }
  const isHttpToolNode = (n: WorkflowNode): n is Extract<WorkflowNode, { kind: "HTTP_TOOL" }> =>
    n.kind === "HTTP_TOOL" && n.id === nodeId;
  const node = (graphParse.data.nodes as WorkflowNode[]).find(isHttpToolNode);
  if (!node) {
    return NextResponse.json({ ok: false, error: "node_not_found" }, { status: 404 });
  }

  const db = tenantDb(agent.tenantId);
  const secretRows = await db.aiWorkflowSecret.findMany({ select: { key: true, valueCipher: true } });
  const secrets: Record<string, string> = {};
  for (const row of secretRows) secrets[row.key] = decryptSetting(row.valueCipher);

  const url = renderTemplate(node.urlTemplate, gatheredContext, secrets);
  try {
    assertPublicHttpUrl(url, "http-tool");
  } catch (err) {
    const message = err instanceof Error ? err.message : "blocked URL";
    console.error(`[ai/http-tool] blocked request for node ${nodeId}: ${message}`);
    return NextResponse.json({ ok: false, error: "blocked_url" }, { status: 400 });
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const header of node.headers) headers[header.name] = renderTemplate(header.valueTemplate, gatheredContext, secrets);
  const body = node.method !== "GET" && node.bodyTemplate ? renderTemplate(node.bodyTemplate, gatheredContext, secrets) : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), node.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { method: node.method, headers, body, signal: controller.signal });
  } catch (err) {
    console.error(`[ai/http-tool] request failed for node ${nodeId}`, err);
    return NextResponse.json({ ok: false, error: "request_failed" });
  } finally {
    clearTimeout(timer);
  }

  let responseJson: unknown = null;
  try {
    responseJson = await response.json();
  } catch {
    // Non-JSON response body — responseMapping simply extracts nothing below.
  }

  if (!response.ok) {
    return NextResponse.json({ ok: false, error: `http_${response.status}` });
  }

  const extracted: Record<string, unknown> = {};
  for (const mapping of node.responseMapping) {
    extracted[mapping.intoVariable] = getByPath(responseJson, mapping.jsonPath) ?? null;
  }

  return NextResponse.json({ ok: true, extracted });
});
