import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

const { requireAdminSessionMock, aiAgentMock, extensionMock, aiProviderCredentialMock, unsafeGlobalAiAgentMock } =
  vi.hoisted(() => ({
    requireAdminSessionMock: vi.fn(),
    aiAgentMock: { findUnique: vi.fn(), update: vi.fn() },
    extensionMock: { findUnique: vi.fn() },
    aiProviderCredentialMock: { findUnique: vi.fn() },
    unsafeGlobalAiAgentMock: { findFirst: vi.fn() },
  }));

vi.mock("@/lib/auth-guard", () => ({
  requireAdminSession: requireAdminSessionMock,
}));

vi.mock("@/lib/db", () => ({
  unsafeGlobalDb: { aiAgent: unsafeGlobalAiAgentMock },
}));

import { GET, PATCH } from "./route";

function fakeDb() {
  return { aiAgent: aiAgentMock, extension: extensionMock, aiProviderCredential: aiProviderCredentialMock };
}

function session(tenantId = "tenant1") {
  return { session: { user: { id: "u1", tenantId } }, db: fakeDb() };
}

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/admin/ai/agents/agent1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/ai/agents/[id]", () => {
  it("returns 404 when the agent doesn't exist for this tenant", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue(null);

    const response = await GET(new NextRequest("http://localhost/api/admin/ai/agents/agent1"), {
      params: { id: "agent1" },
    });

    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/admin/ai/agents/[id] — escalation fields", () => {
  it("rejects an unauthenticated request before touching the db", async () => {
    const unauthorized = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    requireAdminSessionMock.mockResolvedValue({ response: unauthorized });

    const response = await PATCH(patchRequest({ escalationEnabled: true }), { params: { id: "agent1" } });

    expect(response.status).toBe(401);
    expect(aiAgentMock.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when the agent doesn't exist for this tenant", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ escalationEnabled: true }), { params: { id: "agent1" } });

    expect(response.status).toBe(404);
  });

  it("rejects an unparseable phone number for handoffNumberE164", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1" });

    const response = await PATCH(
      patchRequest({ handoffTargetKind: "NUMBER", handoffNumberE164: "not-a-number" }),
      { params: { id: "agent1" } }
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toMatch(/handoffNumberE164/);
    expect(aiAgentMock.update).not.toHaveBeenCalled();
  });

  it("normalizes a valid national-format number to E.164 before saving", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1" });
    aiAgentMock.update.mockResolvedValue({ id: "agent1", handoffNumberE164: "+971501234567" });

    const response = await PATCH(
      patchRequest({ handoffTargetKind: "NUMBER", handoffNumberE164: "0501234567" }),
      { params: { id: "agent1" } }
    );

    expect(response.status).toBe(200);
    expect(aiAgentMock.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ handoffNumberE164: "+971501234567" }) })
    );
  });

  it("rejects a handoffExtensionId that doesn't exist for this tenant", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1" });
    extensionMock.findUnique.mockResolvedValue(null);

    const response = await PATCH(
      patchRequest({ handoffTargetKind: "EXTENSION", handoffExtensionId: "ext-other-tenant" }),
      { params: { id: "agent1" } }
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toMatch(/handoffExtensionId/);
    expect(aiAgentMock.update).not.toHaveBeenCalled();
  });

  it("rejects a handoffExtensionId that resolves to an AI-kind extension", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1" });
    extensionMock.findUnique.mockResolvedValue({ id: "ext2", agentType: "AI" });

    const response = await PATCH(
      patchRequest({ handoffTargetKind: "EXTENSION", handoffExtensionId: "ext2" }),
      { params: { id: "agent1" } }
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toMatch(/handoffExtensionId/);
    expect(aiAgentMock.update).not.toHaveBeenCalled();
  });

  it("accepts a valid same-tenant HUMAN extension as the handoff target", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1" });
    extensionMock.findUnique.mockResolvedValue({ id: "ext2", agentType: "HUMAN" });
    aiAgentMock.update.mockResolvedValue({ id: "agent1", handoffExtensionId: "ext2" });

    const response = await PATCH(
      patchRequest({ escalationEnabled: true, handoffTargetKind: "EXTENSION", handoffExtensionId: "ext2" }),
      { params: { id: "agent1" } }
    );

    expect(response.status).toBe(200);
    expect(aiAgentMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ escalationEnabled: true, handoffTargetKind: "EXTENSION", handoffExtensionId: "ext2" }),
      })
    );
  });

  it("rejects enabling a second tenant's AI agent (existing cross-tenant guard, unaffected by escalation fields)", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1" });
    unsafeGlobalAiAgentMock.findFirst.mockResolvedValue({ id: "other-agent" });

    const response = await PATCH(patchRequest({ enabled: true }), { params: { id: "agent1" } });

    expect(response.status).toBe(409);
    expect(aiAgentMock.update).not.toHaveBeenCalled();
  });

  it("maps a dinstarPort P2002 conflict to a clear 409", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    aiAgentMock.findUnique.mockResolvedValue({ id: "agent1", tenantId: "tenant1" });
    aiAgentMock.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })
    );

    const response = await PATCH(patchRequest({ dinstarPort: 2 }), { params: { id: "agent1" } });
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toMatch(/GSM port 2 is already assigned/i);
  });
});
