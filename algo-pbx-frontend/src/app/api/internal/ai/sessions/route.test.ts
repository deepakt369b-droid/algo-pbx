import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { recordAiSessionMock } = vi.hoisted(() => ({
  recordAiSessionMock: vi.fn(),
}));

vi.mock("@/lib/ai/sessions", () => ({
  recordAiSession: recordAiSessionMock,
}));

import { POST } from "./route";

function request(body: unknown, headers: Record<string, string> = { "x-internal-secret": "shared-secret-value" }) {
  return new NextRequest("http://localhost/api/internal/ai/sessions", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

function validReport(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent1",
    cdrUniqueId: "1234.1",
    transcript: [{ role: "caller", text: "hi", at: "2026-09-14T00:00:00.000Z" }],
    outcome: "completed",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.AI_SIDECAR_SHARED_SECRET = "shared-secret-value";
  recordAiSessionMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_SIDECAR_SHARED_SECRET;
});

describe("POST /api/internal/ai/sessions — auth", () => {
  it("rejects a request with no x-internal-secret header", async () => {
    const response = await POST(request(validReport(), {}));
    expect(response.status).toBe(401);
    expect(recordAiSessionMock).not.toHaveBeenCalled();
  });

  it("rejects when the shared secret env var is not configured at all", async () => {
    delete process.env.AI_SIDECAR_SHARED_SECRET;
    const response = await POST(request(validReport()));
    expect(response.status).toBe(401);
  });
});

describe("POST /api/internal/ai/sessions — validation", () => {
  it("accepts a normal completed report with no handoffExtensionId", async () => {
    const response = await POST(request(validReport()));
    expect(response.status).toBe(201);
    expect(recordAiSessionMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed", handoffExtensionId: null }));
  });

  it("accepts handed_off with a handoffExtensionId (internal extension number)", async () => {
    const response = await POST(request(validReport({ outcome: "handed_off", handoffExtensionId: "1002" })));
    expect(response.status).toBe(201);
    expect(recordAiSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "handed_off", handoffExtensionId: "1002" })
    );
  });

  it("accepts handed_off with a handoffExtensionId that is an external E.164 number", async () => {
    // handoffExtensionId has no FK to Extension by design (schema.prisma) —
    // it may be an external GSM-dialed number, not just an internal ext.
    const response = await POST(request(validReport({ outcome: "handed_off", handoffExtensionId: "+971501234567" })));
    expect(response.status).toBe(201);
  });

  it("rejects a non-null handoffExtensionId when outcome is not handed_off", async () => {
    const response = await POST(request(validReport({ outcome: "completed", handoffExtensionId: "1002" })));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(JSON.stringify(json)).toMatch(/handoffExtensionId/);
    expect(recordAiSessionMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid outcome value", async () => {
    const response = await POST(request(validReport({ outcome: "bogus" })));
    expect(response.status).toBe(400);
    expect(recordAiSessionMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed transcript entry", async () => {
    const response = await POST(request(validReport({ transcript: [{ role: "bogus", text: "hi", at: "x" }] })));
    expect(response.status).toBe(400);
    expect(recordAiSessionMock).not.toHaveBeenCalled();
  });
});
