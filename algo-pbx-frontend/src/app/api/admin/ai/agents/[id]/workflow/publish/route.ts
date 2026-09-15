import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/auth-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { unsafeGlobalDb } from "@/lib/db";
import { planHasFeature } from "@/lib/platform/plan-catalog";
import { parseWorkflowForPublish, type WorkflowNode } from "@/lib/ai/workflow-schema";

export const dynamic = "force-dynamic";

async function tenantPlan(tenantId: string): Promise<string> {
  const tenant = await unsafeGlobalDb.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  return tenant?.plan ?? "standard";
}

const PublishRequestSchema = z.object({
  // Republish the current draft (default) or repoint publishedVersionId
  // back at an already-existing version (one-click revert) - mutually
  // exclusive, `revertToVersionId` short-circuits before the draft is even
  // read.
  revertToVersionId: z.string().nullable().optional(),
});

// POST /api/admin/ai/agents/[id]/workflow/publish — strict-parses the
// CURRENT DRAFT and, if clean, promotes it to a new immutable
// AiWorkflowVersion, repointing AiWorkflow.publishedVersionId at it. This is
// the ONLY way a graph can ever be read by agent-config/route.ts — see
// AiWorkflow's schema comment for why draftGraph itself is never trusted
// for a live call.
export const POST = withApiErrorHandler(async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db, session } = guard;

  const plan = await tenantPlan(session.user.tenantId);
  if (!planHasFeature(plan, "aiAgents")) {
    return NextResponse.json({ error: "AI agents are not included on this plan." }, { status: 403 });
  }

  const agent = await db.aiAgent.findUnique({
    where: { id: params.id },
    select: { id: true, tenantId: true, pipelineMode: true, realtimeProviderId: true },
  });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsedBody = PublishRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Invalid payload", issues: parsedBody.error.flatten() }, { status: 400 });
  }

  const workflow = await db.aiWorkflow.findUnique({ where: { agentId: params.id } });
  if (!workflow) {
    return NextResponse.json({ error: "No draft graph exists for this agent yet." }, { status: 400 });
  }

  // --- One-click revert: repoint at an already-published, already-valid
  // version. No new version row, no re-validation - the version being
  // reverted to was strict-parsed when IT was published. -------------------
  if (parsedBody.data.revertToVersionId) {
    const target = await db.aiWorkflowVersion.findFirst({
      where: { id: parsedBody.data.revertToVersionId, workflowId: workflow.id },
      select: { id: true, version: true },
    });
    if (!target) {
      return NextResponse.json({ error: "revertToVersionId: no such version for this workflow." }, { status: 400 });
    }
    await db.aiWorkflow.update({ where: { id: workflow.id }, data: { publishedVersionId: target.id } });
    return NextResponse.json({ ok: true, publishedVersion: target.version });
  }

  // --- Publish the current draft -------------------------------------------
  const realtimeProvider = agent.realtimeProviderId
    ? (await db.aiProviderCredential.findUnique({ where: { id: agent.realtimeProviderId }, select: { provider: true } }))
        ?.provider ?? null
    : null;

  const { graph, issues } = parseWorkflowForPublish(workflow.draftGraph, {
    pipelineMode: agent.pipelineMode === "REALTIME" ? "REALTIME" : "CASCADE",
    realtimeProvider,
  });
  const blockingIssues = issues.filter((i) => i.severity === "error");
  if (!graph || blockingIssues.length > 0) {
    return NextResponse.json({ error: "The workflow has unresolved issues and cannot be published.", issues }, { status: 422 });
  }

  // Every credential id any node's modelOverride references must belong to
  // this tenant - same cross-tenant/typo protection as the agent editor's
  // CREDENTIAL_ID_FIELDS check in ../route.ts, applied per-node here since a
  // graph can reference many different credentials across its nodes.
  const credentialIds = new Set<string>();
  const extensionIds = new Set<string>();
  for (const node of graph.nodes as WorkflowNode[]) {
    if (node.modelOverride.llmProviderId) credentialIds.add(node.modelOverride.llmProviderId);
    if (node.modelOverride.ttsProviderId) credentialIds.add(node.modelOverride.ttsProviderId);
    if (node.kind === "TRANSFER" && node.transferTargetKind === "EXTENSION" && node.transferExtensionId) {
      extensionIds.add(node.transferExtensionId);
    }
  }
  if (credentialIds.size > 0) {
    const found = await db.aiProviderCredential.findMany({
      where: { id: { in: [...credentialIds] } },
      select: { id: true },
    });
    const foundIds = new Set(found.map((c) => c.id));
    const missing = [...credentialIds].filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `One or more nodes reference a provider credential that does not belong to this tenant: ${missing.join(", ")}` },
        { status: 400 },
      );
    }
  }
  if (extensionIds.size > 0) {
    const found = await db.extension.findMany({
      where: { id: { in: [...extensionIds] }, agentType: "HUMAN" },
      select: { id: true },
    });
    const foundIds = new Set(found.map((e) => e.id));
    const missing = [...extensionIds].filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `One or more Transfer nodes reference an extension that is not a same-tenant human extension: ${missing.join(", ")}` },
        { status: 400 },
      );
    }
  }

  const latest = await db.aiWorkflowVersion.findFirst({
    where: { workflowId: workflow.id },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const nextVersion = (latest?.version ?? 0) + 1;

  const created = await db.$transaction(async (tx) => {
    const version = await tx.aiWorkflowVersion.create({
      data: {
        tenantId: agent.tenantId,
        workflowId: workflow.id,
        version: nextVersion,
        graph: graph as object,
        publishedByUserId: session.user.id,
      },
      select: { id: true, version: true },
    });
    await tx.aiWorkflow.update({ where: { id: workflow.id }, data: { publishedVersionId: version.id } });
    return version;
  });

  return NextResponse.json({ ok: true, publishedVersion: created.version, issues });
});
