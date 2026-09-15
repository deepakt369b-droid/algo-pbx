import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { requireAdminSessionMock, aiAgentMock, aiWorkflowMock, unsafeGlobalTenantMock } = vi.hoisted(() => ({
  requireAdminSessionMock: vi.fn(),
  aiAgentMock: { findUnique: vi.fn() },
  aiWorkflowMock: { findUnique: vi.fn(), upsert: vi.fn() },
  unsafeGlobalTenantMock: { findUnique: vi.fn() },
}));

vi.mock("@/lib/auth-guard", () => ({ requireAdminSession: requireAdminSessionMock }));
vi.mock("@/lib/db", () => ({ unsafeGlobalDb: { tenant: unsafeGlobalTenantMock } }));

import { GET, PUT } from "./route";

function fakeDb() {
  return { aiAgent: aiAgentMock, aiWorkflow: aiWorkflowMock };
}

function session() {
  return { session: { user: { id: "u1", tenantId: "tenant1" } }, db: fakeDb() };
}

function getRequest() {
  return new NextRequest("http://localhost/api/admin/ai/agents/agent1/workflow");
}

function putRequest(body: unknown) {
  return new NextRequest("http://localhost/api/admin/ai/agents/agent1/workflow", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const VALID_GRAPH = {
  schemaVersion: 1,
  nodes: [
    { kind: "START_CALL", id: "start", label: "Start", position: { x: 0, y: 0 }, prompt: "", allowInterruption: true, variables: [], modelOverride: {} },
    { kind: "END_CALL", id: "end", label: "End", position: { x: 0, y: 0 }, prompt: "Bye", allowInterruption: true, variables: [], modelOverride: {} },
  ],
  edges: [{ id: "e1", source: "start", target: "end", condition: "done" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  unsafeGlobalTenantMock.findUnique.mockResolvedValue({ plan: "premium" });
});

describe("GET /api/admin/ai/agents/[id]/workflow", () => {
  it("rejects when the tenant plan lacks aiAgents", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    unsafeGlobalTenantMock.findUnique.mockResolvedValue({ plan: "standard" });

    const response = await GET(getRequest(), { params: { id: "agent1" } });
    expect(response.status).toBe(403);
  });

  it("404s when the agent doesn't exist for this tenant", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue(null);

    const response = await GET(getRequest(), { params: { id: "agent1" } });
    expect(response.status).toBe(404);
  });

  it("returns an empty starter graph when no AiWorkflow row exists yet", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1" });
    aiWorkflowMock.findUnique.mockResolvedValue(null);

    const json = await (await GET(getRequest(), { params: { id: "agent1" } })).json();
    expect(json.draftGraph).toEqual({ schemaVersion: 1, nodes: [], edges: [] });
    expect(json.publishedVersion).toBeNull();
    expect(json.versions).toEqual([]);
  });

  it("returns the stored draft, published version, and version list", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1" });
    aiWorkflowMock.findUnique.mockResolvedValue({
      draftGraph: VALID_GRAPH,
      publishedVersion: { id: "v2", version: 2, publishedAt: "2026-09-15T00:00:00.000Z" },
      versions: [
        { id: "v2", version: 2, publishedAt: "2026-09-15T00:00:00.000Z" },
        { id: "v1", version: 1, publishedAt: "2026-09-14T00:00:00.000Z" },
      ],
    });

    const json = await (await GET(getRequest(), { params: { id: "agent1" } })).json();
    expect(json.draftGraph).toEqual(VALID_GRAPH);
    expect(json.publishedVersion.version).toBe(2);
    expect(json.versions).toHaveLength(2);
  });
});

describe("PUT /api/admin/ai/agents/[id]/workflow", () => {
  it("rejects when the tenant plan lacks aiAgents", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    unsafeGlobalTenantMock.findUnique.mockResolvedValue({ plan: "standard" });

    const response = await PUT(putRequest(VALID_GRAPH), { params: { id: "agent1" } });
    expect(response.status).toBe(403);
  });

  it("404s when the agent doesn't exist for this tenant", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue(null);

    const response = await PUT(putRequest(VALID_GRAPH), { params: { id: "agent1" } });
    expect(response.status).toBe(404);
  });

  it("stores a structurally invalid draft anyway and reports issues (lenient save)", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1" });
    aiWorkflowMock.upsert.mockResolvedValue({ id: "wf1", updatedAt: new Date("2026-09-15T00:00:00Z") });

    const invalidGraph = { schemaVersion: 1, nodes: [], edges: [] }; // fails min(1) nodes
    const response = await PUT(putRequest(invalidGraph), { params: { id: "agent1" } });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.issues.length).toBeGreaterThan(0);
    expect(aiWorkflowMock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: "agent1" },
        create: expect.objectContaining({ tenantId: "tenant1", agentId: "agent1", draftGraph: invalidGraph }),
        update: { draftGraph: invalidGraph },
      }),
    );
  });

  it("saves a valid draft with no issues", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1" });
    aiWorkflowMock.upsert.mockResolvedValue({ id: "wf1", updatedAt: new Date("2026-09-15T00:00:00Z") });

    const response = await PUT(putRequest(VALID_GRAPH), { params: { id: "agent1" } });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.issues).toEqual([]);
  });

  it("rejects a non-object body", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1" });

    const response = await PUT(
      new NextRequest("http://localhost/api/admin/ai/agents/agent1/workflow", {
        method: "PUT",
        body: "null",
        headers: { "content-type": "application/json" },
      }),
      { params: { id: "agent1" } },
    );
    expect(response.status).toBe(400);
  });
});
