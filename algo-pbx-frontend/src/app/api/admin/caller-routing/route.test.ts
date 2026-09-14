import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

const { requireAdminSessionMock, callerRoutingRuleMock } = vi.hoisted(() => ({
  requireAdminSessionMock: vi.fn(),
  callerRoutingRuleMock: { findMany: vi.fn(), create: vi.fn() },
}));

vi.mock("@/lib/auth-guard", () => ({
  requireAdminSession: requireAdminSessionMock,
}));

import { GET, POST } from "./route";

function fakeDb() {
  return { callerRoutingRule: callerRoutingRuleMock };
}

function session(tenantId = "tenant1") {
  return { session: { user: { id: "u1", tenantId } }, db: fakeDb() };
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/caller-routing", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/caller-routing", () => {
  it("rejects an unauthenticated request", async () => {
    const unauthorized = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    requireAdminSessionMock.mockResolvedValue({ response: unauthorized });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(callerRoutingRuleMock.findMany).not.toHaveBeenCalled();
  });

  it("returns the tenant's rules", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    callerRoutingRuleMock.findMany.mockResolvedValue([
      { id: "r1", pattern: "+9715*", action: "BLOCK", note: null, createdAt: new Date() },
    ]);

    const response = await GET();
    const json = await response.json();

    expect(json.rules).toHaveLength(1);
    expect(json.rules[0].action).toBe("BLOCK");
  });
});

describe("POST /api/admin/caller-routing", () => {
  it("rejects an invalid pattern", async () => {
    requireAdminSessionMock.mockResolvedValue(session());

    const response = await POST(request({ pattern: "not-a-number", action: "BLOCK" }));

    expect(response.status).toBe(400);
    expect(callerRoutingRuleMock.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid action", async () => {
    requireAdminSessionMock.mockResolvedValue(session());

    const response = await POST(request({ pattern: "+971501234567", action: "MAYBE" }));

    expect(response.status).toBe(400);
  });

  it("normalizes an exact-number pattern to E.164 before storing", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    callerRoutingRuleMock.create.mockResolvedValue({
      id: "r1",
      pattern: "+971501234567",
      action: "PASS",
      note: null,
    });

    const response = await POST(request({ pattern: "0501234567", action: "PASS" }));
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(callerRoutingRuleMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pattern: "+971501234567", action: "PASS" }) })
    );
    expect(json.rule.pattern).toBe("+971501234567");
  });

  it("stores a prefix pattern as typed, without attempting E.164 normalization", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    callerRoutingRuleMock.create.mockResolvedValue({ id: "r1", pattern: "+9715*", action: "BLOCK", note: null });

    const response = await POST(request({ pattern: "+9715*", action: "BLOCK" }));

    expect(response.status).toBe(201);
    expect(callerRoutingRuleMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pattern: "+9715*" }) })
    );
  });

  it("rejects an unparseable exact number even though it matches the loose regex", async () => {
    requireAdminSessionMock.mockResolvedValue(session());

    // Passes the digits-only regex but isn't a real number libphonenumber
    // can parse — normalizeToE164 returns null for it.
    const response = await POST(request({ pattern: "000000", action: "BLOCK" }));

    expect(response.status).toBe(400);
    expect(callerRoutingRuleMock.create).not.toHaveBeenCalled();
  });

  it("maps a duplicate pattern (P2002) to a 409", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    callerRoutingRuleMock.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })
    );

    const response = await POST(request({ pattern: "+971501234567", action: "PASS" }));
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toMatch(/already exists/);
  });

  it("accepts an optional note", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    callerRoutingRuleMock.create.mockResolvedValue({
      id: "r1",
      pattern: "+971501234567",
      action: "PASS",
      note: "VIP partner",
    });

    const response = await POST(request({ pattern: "+971501234567", action: "PASS", note: "VIP partner" }));

    expect(response.status).toBe(201);
    expect(callerRoutingRuleMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ note: "VIP partner" }) })
    );
  });
});
