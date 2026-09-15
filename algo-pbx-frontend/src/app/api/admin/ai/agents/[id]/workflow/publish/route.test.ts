import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  requireAdminSessionMock,
  aiAgentMock,
  aiWorkflowMock,
  aiWorkflowVersionMock,
  aiProviderCredentialMock,
  extensionMock,
  unsafeGlobalTenantMock,
  txMock,
} = vi.hoisted(() => {
  const txMock = {
    aiWorkflowVersion: { create: vi.fn() },
    aiWorkflow: { update: vi.fn() },
  };
  return {
    requireAdminSessionMock: vi.fn(),
    aiAgentMock: { findUnique: vi.fn() },
    aiWorkflowMock: { findUnique: vi.fn(), update: vi.fn() },
    aiWorkflowVersionMock: { findFirst: vi.fn() },
    aiProviderCredentialMock: { findUnique: vi.fn(), findMany: vi.fn() },
    extensionMock: { findMany: vi.fn() },
    unsafeGlobalTenantMock: { findUnique: vi.fn() },
    txMock,
  };
});

vi.mock("@/lib/auth-guard", () => ({ requireAdminSession: requireAdminSessionMock }));
vi.mock("@/lib/db", () => ({ unsafeGlobalDb: { tenant: unsafeGlobalTenantMock } }));

import { POST } from "./route";

function fakeDb() {
  return {
    aiAgent: aiAgentMock,
    aiWorkflow: aiWorkflowMock,
    aiWorkflowVersion: aiWorkflowVersionMock,
    aiProviderCredential: aiProviderCredentialMock,
    extension: extensionMock,
    $transaction: vi.fn(async (fn: (tx: typeof txMock) => unknown) => fn(txMock)),
  };
}

function session() {
  return { session: { user: { id: "u1", tenantId: "tenant1" } }, db: fakeDb() };
}

function postRequest(body: unknown = {}) {
  return new NextRequest("http://localhost/api/admin/ai/agents/agent1/workflow/publish", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const VALID_GRAPH = {
  schemaVersion: 1,
  nodes: [
    { kind: "START_CALL", id: "start", label: "Start", position: { x: 0, y: 0 }, prompt: "", allowInterruption: true, variables: [], modelOverride: {} },
    { kind: "AGENT", id: "ask", label: "Ask", position: { x: 0, y: 0 }, prompt: "Ask name", allowInterruption: true, variables: [], modelOverride: {} },
    { kind: "END_CALL", id: "end", label: "End", position: { x: 0, y: 0 }, prompt: "Bye", allowInterruption: true, variables: [], modelOverride: {} },
  ],
  edges: [
    { id: "e1", source: "start", target: "ask", condition: "always" },
    { id: "e2", source: "ask", target: "end", condition: "done" },
  ],
};

const INVALID_GRAPH = { schemaVersion: 1, nodes: [], edges: [] };

beforeEach(() => {
  vi.clearAllMocks();
  unsafeGlobalTenantMock.findUnique.mockResolvedValue({ plan: "premium" });
});

describe("POST /api/admin/ai/agents/[id]/workflow/publish", () => {
  it("rejects when the tenant plan lacks aiAgents", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    unsafeGlobalTenantMock.findUnique.mockResolvedValue({ plan: "standard" });

    const response = await POST(postRequest(), { params: { id: "agent1" } });
    expect(response.status).toBe(403);
  });

  it("404s when the agent doesn't exist for this tenant", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue(null);

    const response = await POST(postRequest(), { params: { id: "agent1" } });
    expect(response.status).toBe(404);
  });

  it("400s when there is no draft graph to publish", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1", pipelineMode: "CASCADE", realtimeProviderId: null });
    aiWorkflowMock.findUnique.mockResolvedValue(null);

    const response = await POST(postRequest(), { params: { id: "agent1" } });
    expect(response.status).toBe(400);
  });

  it("422s and never writes a version when the draft has blocking issues", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1", pipelineMode: "CASCADE", realtimeProviderId: null });
    aiWorkflowMock.findUnique.mockResolvedValue({ id: "wf1", draftGraph: INVALID_GRAPH });

    const response = await POST(postRequest(), { params: { id: "agent1" } });
    const json = await response.json();

    expect(response.status).toBe(422);
    expect(json.issues.length).toBeGreaterThan(0);
    expect(txMock.aiWorkflowVersion.create).not.toHaveBeenCalled();
  });

  it("422s a REALTIME workflow on a Gemini realtime provider (cannot update instructions mid-session)", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({
      id: "agent1",
      tenantId: "tenant1",
      pipelineMode: "REALTIME",
      realtimeProviderId: "cred-rt",
    });
    aiProviderCredentialMock.findUnique.mockResolvedValue({ provider: "gemini" });
    aiWorkflowMock.findUnique.mockResolvedValue({ id: "wf1", draftGraph: VALID_GRAPH });

    const response = await POST(postRequest(), { params: { id: "agent1" } });
    const json = await response.json();

    expect(response.status).toBe(422);
    expect(json.issues.some((i: { message: string }) => i.message.includes("Gemini Live cannot change instructions"))).toBe(true);
  });

  it("allows a REALTIME workflow on an OpenAI realtime provider", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({
      id: "agent1",
      tenantId: "tenant1",
      pipelineMode: "REALTIME",
      realtimeProviderId: "cred-rt",
    });
    aiProviderCredentialMock.findUnique.mockResolvedValue({ provider: "openai" });
    aiWorkflowMock.findUnique.mockResolvedValue({ id: "wf1", draftGraph: VALID_GRAPH });
    aiWorkflowVersionMock.findFirst.mockResolvedValue(null);
    txMock.aiWorkflowVersion.create.mockResolvedValue({ id: "v1", version: 1 });

    const response = await POST(postRequest(), { params: { id: "agent1" } });
    expect(response.status).toBe(200);
  });

  it("rejects a node referencing a cross-tenant/nonexistent provider credential", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1", pipelineMode: "CASCADE", realtimeProviderId: null });
    const graphWithOverride = {
      ...VALID_GRAPH,
      nodes: VALID_GRAPH.nodes.map((n) =>
        n.id === "ask" ? { ...n, modelOverride: { llmProviderId: "cred-other-tenant", llmModel: "gpt-4o-mini" } } : n,
      ),
    };
    aiWorkflowMock.findUnique.mockResolvedValue({ id: "wf1", draftGraph: graphWithOverride });
    aiProviderCredentialMock.findMany.mockResolvedValue([]); // tenant-scoped db finds nothing

    const response = await POST(postRequest(), { params: { id: "agent1" } });
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toContain("cred-other-tenant");
    expect(txMock.aiWorkflowVersion.create).not.toHaveBeenCalled();
  });

  it("rejects a TRANSFER node referencing a non-HUMAN/cross-tenant extension", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1", pipelineMode: "CASCADE", realtimeProviderId: null });
    const graphWithTransfer = {
      schemaVersion: 1,
      nodes: [
        ...VALID_GRAPH.nodes.slice(0, 2),
        {
          kind: "TRANSFER",
          id: "xfer",
          label: "Transfer",
          position: { x: 0, y: 0 },
          prompt: "",
          allowInterruption: true,
          variables: [],
          modelOverride: {},
          transferTargetKind: "EXTENSION",
          transferNumberE164: null,
          transferExtensionId: "ext-other-tenant",
        },
      ],
      edges: [{ id: "e1", source: "start", target: "ask", condition: "always" }, { id: "e2", source: "ask", target: "xfer", condition: "needs human" }],
    };
    aiWorkflowMock.findUnique.mockResolvedValue({ id: "wf1", draftGraph: graphWithTransfer });
    extensionMock.findMany.mockResolvedValue([]);

    const response = await POST(postRequest(), { params: { id: "agent1" } });
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toContain("ext-other-tenant");
  });

  it("publishes a clean graph as version 1 when none exists yet", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1", pipelineMode: "CASCADE", realtimeProviderId: null });
    aiWorkflowMock.findUnique.mockResolvedValue({ id: "wf1", draftGraph: VALID_GRAPH });
    aiWorkflowVersionMock.findFirst.mockResolvedValue(null);
    txMock.aiWorkflowVersion.create.mockResolvedValue({ id: "v1", version: 1 });

    const response = await POST(postRequest(), { params: { id: "agent1" } });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.publishedVersion).toBe(1);
    expect(txMock.aiWorkflowVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: 1, workflowId: "wf1", tenantId: "tenant1", publishedByUserId: "u1" }) }),
    );
    expect(txMock.aiWorkflow.update).toHaveBeenCalledWith({ where: { id: "wf1" }, data: { publishedVersionId: "v1" } });
  });

  it("increments the version number on a subsequent publish", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1", pipelineMode: "CASCADE", realtimeProviderId: null });
    aiWorkflowMock.findUnique.mockResolvedValue({ id: "wf1", draftGraph: VALID_GRAPH });
    aiWorkflowVersionMock.findFirst.mockResolvedValue({ version: 3 });
    txMock.aiWorkflowVersion.create.mockResolvedValue({ id: "v4", version: 4 });

    const response = await POST(postRequest(), { params: { id: "agent1" } });
    const json = await response.json();

    expect(json.publishedVersion).toBe(4);
  });

  it("one-click reverts to an existing version without creating a new one", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1", pipelineMode: "CASCADE", realtimeProviderId: null });
    aiWorkflowMock.findUnique.mockResolvedValue({ id: "wf1", draftGraph: VALID_GRAPH });
    aiWorkflowVersionMock.findFirst.mockResolvedValue({ id: "v2", version: 2 });

    const response = await POST(postRequest({ revertToVersionId: "v2" }), { params: { id: "agent1" } });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.publishedVersion).toBe(2);
    expect(aiWorkflowMock.update).toHaveBeenCalledWith({ where: { id: "wf1" }, data: { publishedVersionId: "v2" } });
    expect(txMock.aiWorkflowVersion.create).not.toHaveBeenCalled();
  });

  it("rejects reverting to a version id that doesn't belong to this workflow", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1", pipelineMode: "CASCADE", realtimeProviderId: null });
    aiWorkflowMock.findUnique.mockResolvedValue({ id: "wf1", draftGraph: VALID_GRAPH });
    aiWorkflowVersionMock.findFirst.mockResolvedValue(null);

    const response = await POST(postRequest({ revertToVersionId: "ghost" }), { params: { id: "agent1" } });
    expect(response.status).toBe(400);
  });
});
