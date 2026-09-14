import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { requireAdminSessionMock, callerRoutingRuleMock } = vi.hoisted(() => ({
  requireAdminSessionMock: vi.fn(),
  callerRoutingRuleMock: { delete: vi.fn() },
}));

vi.mock("@/lib/auth-guard", () => ({
  requireAdminSession: requireAdminSessionMock,
}));

import { DELETE } from "./route";

function session(tenantId = "tenant1") {
  return { session: { user: { id: "u1", tenantId } }, db: { callerRoutingRule: callerRoutingRuleMock } };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/admin/caller-routing/[id]", () => {
  it("rejects an unauthenticated request", async () => {
    const unauthorized = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    requireAdminSessionMock.mockResolvedValue({ response: unauthorized });

    const response = await DELETE(new NextRequest("http://localhost/api/admin/caller-routing/r1"), {
      params: { id: "r1" },
    });

    expect(response.status).toBe(401);
    expect(callerRoutingRuleMock.delete).not.toHaveBeenCalled();
  });

  it("deletes the rule by id", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    callerRoutingRuleMock.delete.mockResolvedValue({ id: "r1" });

    const response = await DELETE(new NextRequest("http://localhost/api/admin/caller-routing/r1"), {
      params: { id: "r1" },
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(callerRoutingRuleMock.delete).toHaveBeenCalledWith({ where: { id: "r1" } });
  });

  it("swallows a delete of an already-gone (or cross-tenant) id rather than 500ing", async () => {
    requireAdminSessionMock.mockResolvedValue(session());
    callerRoutingRuleMock.delete.mockRejectedValue(new Error("Record to delete does not exist"));

    const response = await DELETE(new NextRequest("http://localhost/api/admin/caller-routing/missing"), {
      params: { id: "missing" },
    });

    expect(response.status).toBe(200);
  });
});
