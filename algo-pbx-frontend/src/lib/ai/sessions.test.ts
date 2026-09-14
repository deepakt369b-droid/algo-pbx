import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  aiAgentFindUniqueMock,
  tenantDbMock,
  aiCallSessionCreateMock,
  callDetailRecordFindUniqueMock,
  contactFindUniqueMock,
  recordActivityMock,
} = vi.hoisted(() => ({
  aiAgentFindUniqueMock: vi.fn(),
  tenantDbMock: vi.fn(),
  aiCallSessionCreateMock: vi.fn(),
  callDetailRecordFindUniqueMock: vi.fn(),
  contactFindUniqueMock: vi.fn(),
  recordActivityMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  unsafeGlobalDb: { aiAgent: { findUnique: aiAgentFindUniqueMock } },
}));

vi.mock("@/lib/db-tenant", () => ({
  tenantDb: tenantDbMock,
}));

vi.mock("@/lib/crm/activity", () => ({
  recordActivity: recordActivityMock,
}));

import { recordAiSession } from "./sessions";
import type { AiSessionReportRequest } from "./types";

function fakeTenantDb() {
  return {
    aiCallSession: { create: aiCallSessionCreateMock },
    callDetailRecord: { findUnique: callDetailRecordFindUniqueMock },
    contact: { findUnique: contactFindUniqueMock },
  };
}

const BASE_INPUT: AiSessionReportRequest = {
  agentId: "agent1",
  cdrUniqueId: "cdr-123",
  transcript: [{ role: "agent", text: "hello", at: "2026-09-14T10:00:00Z" }],
  outcome: "completed",
};

beforeEach(() => {
  tenantDbMock.mockReturnValue(fakeTenantDb());
  aiCallSessionCreateMock.mockResolvedValue({ id: "session1" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("recordAiSession", () => {
  it("throws when the AiAgent does not exist", async () => {
    aiAgentFindUniqueMock.mockResolvedValue(null);
    await expect(recordAiSession(BASE_INPUT)).rejects.toThrow(/no AiAgent found/);
    expect(aiCallSessionCreateMock).not.toHaveBeenCalled();
  });

  it("writes an AiCallSession row scoped to the agent's tenant", async () => {
    aiAgentFindUniqueMock.mockResolvedValue({ tenantId: "tenant1", name: "Support Bot" });
    callDetailRecordFindUniqueMock.mockResolvedValue(null); // CDR not caught up yet — expected

    await recordAiSession(BASE_INPUT);

    expect(tenantDbMock).toHaveBeenCalledWith("tenant1");
    expect(aiCallSessionCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aiAgentId: "agent1",
          cdrUniqueId: "cdr-123",
          outcome: "completed",
        }),
      })
    );
    // No CDR yet -> no contact lookup -> no Activity write, and no throw.
    expect(contactFindUniqueMock).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("also writes a CRM Activity row when the CDR and a matching contact exist", async () => {
    aiAgentFindUniqueMock.mockResolvedValue({ tenantId: "tenant1", name: "Support Bot" });
    callDetailRecordFindUniqueMock.mockResolvedValue({
      id: "cdr-row-1",
      callerNumberE164: "+911234567890",
      durationSec: 42,
      startedAt: new Date("2026-09-14T09:00:00Z"),
    });
    contactFindUniqueMock.mockResolvedValue({ id: "contact1" });

    await recordAiSession({ ...BASE_INPUT, summary: "Customer asked about billing." });

    expect(contactFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_numberE164: { tenantId: "tenant1", numberE164: "+911234567890" } },
      })
    );
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const [activityInput] = recordActivityMock.mock.calls[0];
    expect(activityInput.type).toBe("CALL");
    expect(activityInput.contactId).toBe("contact1");
    expect(activityInput.refId).toBe("cdr-123");
    expect(activityInput.summary).toContain("Support Bot");
    expect(activityInput.summary).toContain("Customer asked about billing.");
  });

  it("does not throw when the Activity write fails — the session report must still succeed", async () => {
    aiAgentFindUniqueMock.mockResolvedValue({ tenantId: "tenant1", name: "Support Bot" });
    callDetailRecordFindUniqueMock.mockResolvedValue({
      id: "cdr-row-1",
      callerNumberE164: "+911234567890",
      durationSec: 42,
      startedAt: new Date("2026-09-14T09:00:00Z"),
    });
    contactFindUniqueMock.mockResolvedValue({ id: "contact1" });
    recordActivityMock.mockRejectedValue(new Error("boom"));

    await expect(recordAiSession(BASE_INPUT)).resolves.toBeUndefined();
    expect(aiCallSessionCreateMock).toHaveBeenCalled();
  });
});
