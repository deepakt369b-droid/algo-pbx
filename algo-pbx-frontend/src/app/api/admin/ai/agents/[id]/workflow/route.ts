import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { unsafeGlobalDb } from "@/lib/db";
import { planHasFeature } from "@/lib/platform/plan-catalog";
import { AI_WORKFLOW_SCHEMA_VERSION, parseWorkflowDraft } from "@/lib/ai/workflow-schema";

export const dynamic = "force-dynamic";

// GET/PUT /api/admin/ai/agents/[id]/workflow — the canvas's own read/write
// route, separate from the agent editor's PATCH ../route.ts (that route
// owns the flat AiAgent columns; this one owns the AiWorkflow's draftGraph
// blob). Split into its own route rather than folded into the agent PATCH
// because the two have very different write shapes: the editor PATCHes a
// handful of scalar fields per save, the canvas PUTs an entire graph blob
// on every autosave — mixing them would force every agent-editor save to
// also validate/round-trip a potentially-large graph it never touched.
async function tenantPlan(tenantId: string): Promise<string> {
  const tenant = await unsafeGlobalDb.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  return tenant?.plan ?? "standard";
}

const EMPTY_GRAPH = { schemaVersion: AI_WORKFLOW_SCHEMA_VERSION, nodes: [], edges: [] };

export const GET = withApiErrorHandler(async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db, session } = guard;

  const plan = await tenantPlan(session.user.tenantId);
  if (!planHasFeature(plan, "aiAgents")) {
    return NextResponse.json({ error: "AI agents are not included on this plan." }, { status: 403 });
  }

  const agent = await db.aiAgent.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workflow = await db.aiWorkflow.findUnique({
    where: { agentId: params.id },
    include: {
      publishedVersion: { select: { id: true, version: true, publishedAt: true } },
      versions: { select: { id: true, version: true, publishedAt: true }, orderBy: { version: "desc" } },
    },
  });

  // No AiWorkflow row yet is the common case (every agent that has never
  // opened the canvas, including every agent that predates this feature) —
  // hand back an empty starter graph rather than 404ing, so the UI can
  // create the row on first save instead of needing a separate
  // "initialize" step.
  return NextResponse.json({
    draftGraph: workflow?.draftGraph ?? EMPTY_GRAPH,
    publishedVersion: workflow?.publishedVersion ?? null,
    versions: workflow?.versions ?? [],
  });
});

export const PUT = withApiErrorHandler(async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db, session } = guard;

  const plan = await tenantPlan(session.user.tenantId);
  if (!planHasFeature(plan, "aiAgents")) {
    return NextResponse.json({ error: "AI agents are not included on this plan." }, { status: 403 });
  }

  const agent = await db.aiAgent.findUnique({ where: { id: params.id }, select: { id: true, tenantId: true } });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Lenient parse — a draft is stored REGARDLESS of validity (see
  // workflow-schema.ts's own header) so a mid-edit canvas is never lost on
  // autosave. `issues` is returned either way for inline display; the UI
  // decides what to do with warnings vs errors, this route doesn't block on
  // them.
  const { issues } = parseWorkflowDraft(body);

  const workflow = await db.aiWorkflow.upsert({
    where: { agentId: params.id },
    create: { tenantId: agent.tenantId, agentId: params.id, draftGraph: body },
    update: { draftGraph: body },
    select: { id: true, updatedAt: true },
  });

  return NextResponse.json({ ok: true, updatedAt: workflow.updatedAt, issues });
});
