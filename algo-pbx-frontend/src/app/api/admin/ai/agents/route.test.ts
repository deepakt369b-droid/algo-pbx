import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

const { requireAdminSessionMock, aiAgentMock, extensionMock, tenantMock, assertSeatAvailableMock } = vi.hoisted(() => ({
  requireAdminSessionMock: vi.fn(),
  aiAgentMock: { findMany: vi.fn(), create: vi.fn() },
  extensionMock: { findFirst: vi.fn() },
  tenantMock: { findUnique: vi.fn() },
  assertSeatAvailableMock: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({
  requireAdminSession: requireAdminSessionMock,
}));

vi.mock("@/lib/db", () => ({
  unsafeGlobalDb: { tenant: tenantMock },
}));

vi.mock("@/lib/platform/seat-guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform/seat-guard")>("@/lib/platform/seat-guard");
  return {
    ...actual,
    assertSeatAvailable: assertSeatAvailableMock,
    getSeatUsage: vi.fn().mockResolvedValue({ seatsTotal: 10, seatsUsed: 1, seatsAvailable: 9 }),
  };
});

import { POST, GET } from "./route";

function fakeDb() {
  return { aiAgent: aiAgentMock, extension: extensionMock };
}

function session(tenantId = "tenant1") {
  return { session: { user: { id: "u1", tenantId } }, db: fakeDb() };
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/ai/agents", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/admin/ai/agents", () => {
  it("rejects when the tenant's plan does not include aiAgents", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    tenantMock.findUnique.mockResolvedValue({ plan: "standard" });

    const response = await POST(request({ name: "Riya", extensionNumber: "1050" }));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error).toMatch(/not included/i);
    expect(aiAgentMock.create).not.toHaveBeenCalled();
  });

  it("returns 409 when no seat is available", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    tenantMock.findUnique.mockResolvedValue({ plan: "premium" });
    const { SeatLimitError } = await import("@/lib/platform/seat-guard");
    assertSeatAvailableMock.mockRejectedValue(new SeatLimitError("tenant1", 4));

    const response = await POST(request({ name: "Riya", extensionNumber: "1050" }));
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toMatch(/no seats available/i);
    expect(aiAgentMock.create).not.toHaveBeenCalled();
  });

  it("creates an AI-kind extension + AiAgent on a qualifying plan with a free seat", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    tenantMock.findUnique.mockResolvedValue({ plan: "premium" });
    assertSeatAvailableMock.mockResolvedValue(undefined);
    extensionMock.findFirst.mockResolvedValue(null);
    aiAgentMock.create.mockResolvedValue({
      id: "agent1",
      name: "Riya",
      language: "en",
      pipelineMode: "CASCADE",
      enabled: true,
      outboundEnabled: false,
      dinstarPort: 1,
      extension: { id: "ext1", number: "1050" },
      greeting: "Hello, you are speaking with an automated assistant. How can I help you today?",
      systemPrompt: "",
    });

    const response = await POST(request({ name: "Riya", extensionNumber: "1050", dinstarPort: 1 }));
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.agent.id).toBe("agent1");
    expect(aiAgentMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Riya",
          outboundEnabled: false,
          dinstarPort: 1,
          extension: { create: expect.objectContaining({ number: "1050", agentType: "AI", tenantId: "tenant1" }) },
        }),
      })
    );
  });

  // Follow-up to §34 (LLM.md, 2026-09-14) — per-port AI agent assignment.
  it("defaults dinstarPort to null when omitted (not assigned to a GSM port yet)", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    tenantMock.findUnique.mockResolvedValue({ plan: "premium" });
    assertSeatAvailableMock.mockResolvedValue(undefined);
    extensionMock.findFirst.mockResolvedValue(null);
    aiAgentMock.create.mockResolvedValue({
      id: "agent2",
      name: "Riya",
      language: "en",
      pipelineMode: "CASCADE",
      enabled: true,
      outboundEnabled: false,
      dinstarPort: null,
      extension: { id: "ext2", number: "1051" },
      greeting: "Hello, you are speaking with an automated assistant. How can I help you today?",
      systemPrompt: "",
    });

    const response = await POST(request({ name: "Riya", extensionNumber: "1051" }));
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.agent.dinstarPort).toBeNull();
    expect(aiAgentMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dinstarPort: null }) })
    );
  });

  it("rejects a dinstarPort outside 1-4", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    tenantMock.findUnique.mockResolvedValue({ plan: "premium" });
    assertSeatAvailableMock.mockResolvedValue(undefined);

    const response = await POST(request({ name: "Riya", extensionNumber: "1050", dinstarPort: 5 }));

    expect(response.status).toBe(400);
    expect(aiAgentMock.create).not.toHaveBeenCalled();
  });

  it("returns a clear 409 when the requested GSM port is already taken on this tenant", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    tenantMock.findUnique.mockResolvedValue({ plan: "premium" });
    assertSeatAvailableMock.mockResolvedValue(undefined);
    extensionMock.findFirst.mockResolvedValue(null);
    aiAgentMock.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })
    );

    const response = await POST(request({ name: "Riya", extensionNumber: "1050", dinstarPort: 2 }));
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toMatch(/GSM port 2 is already assigned/i);
  });

  it("rejects unauthenticated requests before touching the db", async () => {
    const unauthorized = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    requireAdminSessionMock.mockResolvedValue({ response: unauthorized });

    const response = await POST(request({ name: "x", extensionNumber: "1050" }));

    expect(response.status).toBe(401);
    expect(tenantMock.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/ai/agents", () => {
  it("returns agents alongside the tenant's plan feature flag and seat usage", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    tenantMock.findUnique.mockResolvedValue({ plan: "premium" });
    aiAgentMock.findMany.mockResolvedValue([]);

    const response = await GET(new NextRequest("http://localhost/api/admin/ai/agents"));
    const json = await response.json();

    expect(json.planHasAiAgents).toBe(true);
    expect(json.seatUsage).toEqual({ seatsTotal: 10, seatsUsed: 1, seatsAvailable: 9 });
  });
});
