import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tenantDbMock, aiAgentMock, doNotCallEntryMock, auditLogMock, ensureSystemActorIdMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  aiAgentMock: { findUnique: vi.fn() },
  doNotCallEntryMock: { findUnique: vi.fn() },
  auditLogMock: { create: vi.fn() },
  ensureSystemActorIdMock: vi.fn(),
}));

vi.mock("@/lib/db-tenant", () => ({
  tenantDb: tenantDbMock,
}));

vi.mock("@/lib/db", () => ({
  unsafeGlobalDb: { __unsafeGlobalDb: true },
}));

vi.mock("@/lib/support-grant", () => ({
  ensureSystemActorId: ensureSystemActorIdMock,
}));

import { checkEscalationDial, checkOutbound, isWithinCallHours, destinationLocalHour } from "./compliance";
import type { AiComplianceCheckInput } from "./types";
import type { AiEscalationComplianceInput } from "./compliance";

function fakeDb() {
  return { aiAgent: aiAgentMock, doNotCallEntry: doNotCallEntryMock, auditLog: auditLogMock };
}

function baseInput(overrides: Partial<AiComplianceCheckInput> = {}): AiComplianceCheckInput {
  return {
    tenantId: "t1",
    agentId: "agent1",
    destinationE164: "+919812345678",
    nowUtc: new Date("2026-09-14T10:00:00Z"), // 10:00 UTC
    destinationLocalUtcOffsetMinutes: 330, // IST, +5:30 -> local 15:30
    ...overrides,
  };
}

function fullyPermissiveAgent(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    outboundEnabled: true,
    allowedDestinations: [] as string[],
    callHoursStart: null,
    callHoursEnd: null,
    ...overrides,
  };
}

beforeEach(() => {
  tenantDbMock.mockReturnValue(fakeDb());
  ensureSystemActorIdMock.mockResolvedValue("system-actor-1");
  doNotCallEntryMock.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isWithinCallHours", () => {
  it("handles a normal (non-wrapping) window", () => {
    expect(isWithinCallHours(10, 9, 18)).toBe(true);
    expect(isWithinCallHours(8, 9, 18)).toBe(false);
    expect(isWithinCallHours(18, 9, 18)).toBe(false); // end is exclusive
    expect(isWithinCallHours(9, 9, 18)).toBe(true); // start is inclusive
  });

  it("handles a window that wraps midnight", () => {
    expect(isWithinCallHours(23, 22, 6)).toBe(true);
    expect(isWithinCallHours(2, 22, 6)).toBe(true);
    expect(isWithinCallHours(6, 22, 6)).toBe(false); // end exclusive
    expect(isWithinCallHours(22, 22, 6)).toBe(true); // start inclusive
    expect(isWithinCallHours(10, 22, 6)).toBe(false);
  });

  it("treats a zero-width window (start === end) as unrestricted", () => {
    expect(isWithinCallHours(0, 5, 5)).toBe(true);
    expect(isWithinCallHours(23, 5, 5)).toBe(true);
  });
});

describe("destinationLocalHour", () => {
  it("shifts UTC by the offset and wraps into 0-23", () => {
    expect(destinationLocalHour(new Date("2026-09-14T10:00:00Z"), 330)).toBe(15); // IST
    expect(destinationLocalHour(new Date("2026-09-14T22:00:00Z"), 240)).toBe(2); // UAE +4, wraps to next day
    expect(destinationLocalHour(new Date("2026-09-14T02:00:00Z"), -300)).toBe(21); // negative offset, wraps back
  });
});

describe("checkOutbound", () => {
  it("denies and audits when the agent is not found", async () => {
    aiAgentMock.findUnique.mockResolvedValue(null);
    const decision = await checkOutbound(baseInput());
    expect(decision).toEqual({ allowed: false, reason: "agent not found or disabled" });
    expect(auditLogMock.create).toHaveBeenCalledTimes(1);
    expect(auditLogMock.create.mock.calls[0][0].data).toMatchObject({
      action: "ai.compliance_check",
      actorId: "system-actor-1",
      tenantId: "t1",
      targetId: "agent1",
      metadata: expect.objectContaining({ allowed: false, reason: "agent not found or disabled" }),
    });
  });

  it("denies when the agent is disabled", async () => {
    aiAgentMock.findUnique.mockResolvedValue(fullyPermissiveAgent({ enabled: false }));
    const decision = await checkOutbound(baseInput());
    expect(decision).toEqual({ allowed: false, reason: "agent not found or disabled" });
  });

  it("denies when outboundEnabled is false, even if everything else would pass", async () => {
    aiAgentMock.findUnique.mockResolvedValue(
      fullyPermissiveAgent({ outboundEnabled: false, allowedDestinations: ["+91"] })
    );
    const decision = await checkOutbound(baseInput());
    expect(decision).toEqual({ allowed: false, reason: "outbound calling is disabled for this agent" });
  });

  it("denies when the destination does not match any allowedDestinations prefix", async () => {
    aiAgentMock.findUnique.mockResolvedValue(fullyPermissiveAgent({ allowedDestinations: ["+971"] }));
    const decision = await checkOutbound(baseInput({ destinationE164: "+919812345678" }));
    expect(decision).toEqual({ allowed: false, reason: "destination not in allowedDestinations" });
  });

  it("allows when the destination matches an allowedDestinations prefix", async () => {
    aiAgentMock.findUnique.mockResolvedValue(fullyPermissiveAgent({ allowedDestinations: ["+91", "+971"] }));
    const decision = await checkOutbound(baseInput({ destinationE164: "+919812345678" }));
    expect(decision).toEqual({ allowed: true });
  });

  it("treats an empty allowedDestinations as 'no restriction' when outboundEnabled is true", async () => {
    aiAgentMock.findUnique.mockResolvedValue(fullyPermissiveAgent({ allowedDestinations: [] }));
    const decision = await checkOutbound(baseInput());
    expect(decision).toEqual({ allowed: true });
  });

  it("denies outside the permitted call-hours window", async () => {
    aiAgentMock.findUnique.mockResolvedValue(
      fullyPermissiveAgent({ callHoursStart: 9, callHoursEnd: 18 })
    );
    // 10:00 UTC + 330 min offset = 15:30 local -> within 9-18, should pass;
    // use an input that lands outside instead.
    const decision = await checkOutbound(
      baseInput({ nowUtc: new Date("2026-09-14T00:00:00Z"), destinationLocalUtcOffsetMinutes: 330 }) // 05:30 local
    );
    expect(decision).toEqual({ allowed: false, reason: "outside permitted calling hours" });
  });

  it("allows inside the permitted call-hours window", async () => {
    aiAgentMock.findUnique.mockResolvedValue(fullyPermissiveAgent({ callHoursStart: 9, callHoursEnd: 18 }));
    const decision = await checkOutbound(
      baseInput({ nowUtc: new Date("2026-09-14T10:00:00Z"), destinationLocalUtcOffsetMinutes: 330 }) // 15:30 local
    );
    expect(decision).toEqual({ allowed: true });
  });

  it("handles a call-hours window that wraps midnight", async () => {
    aiAgentMock.findUnique.mockResolvedValue(fullyPermissiveAgent({ callHoursStart: 22, callHoursEnd: 6 }));
    // 23:00 UTC + 240 min (UAE) = 03:00 local next day -> within wrapped window
    const decision = await checkOutbound(
      baseInput({ nowUtc: new Date("2026-09-14T23:00:00Z"), destinationLocalUtcOffsetMinutes: 240 })
    );
    expect(decision).toEqual({ allowed: true });
  });

  it("denies when the destination is on the Do Not Call list", async () => {
    aiAgentMock.findUnique.mockResolvedValue(fullyPermissiveAgent());
    doNotCallEntryMock.findUnique.mockResolvedValue({ id: "dnc1" });
    const decision = await checkOutbound(baseInput());
    expect(decision).toEqual({ allowed: false, reason: "destination is on the Do Not Call list" });
  });

  it("allows when every check passes", async () => {
    aiAgentMock.findUnique.mockResolvedValue(
      fullyPermissiveAgent({ allowedDestinations: ["+91"], callHoursStart: 9, callHoursEnd: 18 })
    );
    doNotCallEntryMock.findUnique.mockResolvedValue(null);
    const decision = await checkOutbound(baseInput());
    expect(decision).toEqual({ allowed: true });
  });

  it("writes an audit log row for every decision, allowed or denied", async () => {
    aiAgentMock.findUnique.mockResolvedValue(fullyPermissiveAgent());
    await checkOutbound(baseInput());
    expect(ensureSystemActorIdMock).toHaveBeenCalledWith({ __unsafeGlobalDb: true }, "t1");
    expect(auditLogMock.create).toHaveBeenCalledTimes(1);
    expect(auditLogMock.create.mock.calls[0][0].data).toMatchObject({
      action: "ai.compliance_check",
      actorId: "system-actor-1",
      tenantId: "t1",
      targetId: "agent1",
      metadata: expect.objectContaining({ allowed: true }),
    });
  });
});

describe("checkEscalationDial", () => {
  function escalationInput(overrides: Partial<AiEscalationComplianceInput> = {}): AiEscalationComplianceInput {
    return { tenantId: "t1", agentId: "agent1", destinationE164: "+919812345678", ...overrides };
  }

  function escalationAgent(overrides: Record<string, unknown> = {}) {
    return { enabled: true, escalationEnabled: true, allowedDestinations: [] as string[], ...overrides };
  }

  it("denies when the agent doesn't exist or is disabled", async () => {
    aiAgentMock.findUnique.mockResolvedValue(null);
    const decision = await checkEscalationDial(escalationInput());
    expect(decision).toEqual({ allowed: false, reason: "agent not found or disabled" });
  });

  it("denies when escalationEnabled is false — NOT gated on outboundEnabled", async () => {
    aiAgentMock.findUnique.mockResolvedValue(escalationAgent({ escalationEnabled: false }));
    const decision = await checkEscalationDial(escalationInput());
    expect(decision).toEqual({ allowed: false, reason: "escalation is disabled for this agent" });
    // Confirms the query never even asked for outboundEnabled - this gate
    // is deliberately independent of it.
    expect(aiAgentMock.findUnique.mock.calls[0][0].select).not.toHaveProperty("outboundEnabled");
  });

  it("denies when the destination is outside allowedDestinations", async () => {
    aiAgentMock.findUnique.mockResolvedValue(escalationAgent({ allowedDestinations: ["+44"] }));
    const decision = await checkEscalationDial(escalationInput());
    expect(decision).toEqual({ allowed: false, reason: "destination not in allowedDestinations" });
  });

  it("denies when the destination is on the Do Not Call list", async () => {
    aiAgentMock.findUnique.mockResolvedValue(escalationAgent());
    doNotCallEntryMock.findUnique.mockResolvedValue({ id: "dnc1" });
    const decision = await checkEscalationDial(escalationInput());
    expect(decision).toEqual({ allowed: false, reason: "destination is on the Do Not Call list" });
  });

  it("allows when escalation is enabled, in-allowlist, and not DNC-listed - no call-hours check at all", async () => {
    aiAgentMock.findUnique.mockResolvedValue(escalationAgent({ allowedDestinations: ["+91"] }));
    const decision = await checkEscalationDial(escalationInput());
    expect(decision).toEqual({ allowed: true });
  });

  it("writes an audit log row under a distinct action name from checkOutbound", async () => {
    aiAgentMock.findUnique.mockResolvedValue(escalationAgent());
    await checkEscalationDial(escalationInput());
    expect(auditLogMock.create.mock.calls[0][0].data).toMatchObject({
      action: "ai.escalation_compliance_check",
      tenantId: "t1",
      targetId: "agent1",
      metadata: expect.objectContaining({ allowed: true, destinationE164: "+919812345678" }),
    });
  });
});
