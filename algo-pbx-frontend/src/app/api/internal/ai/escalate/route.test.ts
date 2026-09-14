import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  getAmiClientMock,
  aiAgentMock,
  checkEscalationDialMock,
  tenantDbMock,
  contactUpsertMock,
  userFindFirstMock,
  ensureSystemActorIdMock,
  createTaskMock,
} = vi.hoisted(() => ({
  getAmiClientMock: vi.fn(),
  aiAgentMock: { findUnique: vi.fn() },
  checkEscalationDialMock: vi.fn(),
  tenantDbMock: vi.fn(),
  contactUpsertMock: vi.fn(),
  userFindFirstMock: vi.fn(),
  ensureSystemActorIdMock: vi.fn(),
  createTaskMock: vi.fn(),
}));

vi.mock("@/lib/ami-client", () => ({
  getAmiClient: getAmiClientMock,
}));

vi.mock("@/lib/db", () => ({
  unsafeGlobalDb: { aiAgent: aiAgentMock },
}));

vi.mock("@/lib/db-tenant", () => ({
  tenantDb: tenantDbMock,
}));

vi.mock("@/lib/ai/compliance", () => ({
  checkEscalationDial: checkEscalationDialMock,
}));

vi.mock("@/lib/support-grant", () => ({
  ensureSystemActorId: ensureSystemActorIdMock,
}));

vi.mock("@/lib/crm/tasks-data", () => ({
  createTask: createTaskMock,
}));

function fakeTenantDb() {
  return { contact: { upsert: contactUpsertMock }, user: { findFirst: userFindFirstMock } };
}

import { POST } from "./route";

const CALL_UUID = "11111111-1111-1111-1111-111111111111";

function request(body: unknown, headers: Record<string, string> = { "x-internal-secret": "shared-secret-value" }) {
  return new NextRequest("http://localhost/api/internal/ai/escalate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

function numberTargetAgent(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant1",
    escalationEnabled: true,
    handoffTargetKind: "NUMBER",
    handoffNumberE164: "+971501234567",
    handoffExtension: null,
    extension: { number: "2001", dialPermission: "INTERNATIONAL" },
    ...overrides,
  };
}

function extensionTargetAgent(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant1",
    escalationEnabled: true,
    handoffTargetKind: "EXTENSION",
    handoffNumberE164: null,
    handoffExtension: { number: "1002" },
    extension: { number: "2001", dialPermission: "LOCAL" },
    ...overrides,
  };
}

/** A configurable fake AMI client. Each test overrides only what it needs;
 * defaults are a "nothing ever happens" shape that would otherwise hang. */
function fakeAmi(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    sendAndCollect: vi.fn().mockResolvedValue({ response: {}, events: [] }),
    send: vi.fn().mockResolvedValue({}),
    waitForEvent: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function coreShowChannelsWith(channels: Array<{ Channel: string; Uniqueid?: string; CallerIDNum?: string }>) {
  return {
    response: {},
    events: channels.map((c) => ({ Event: "CoreShowChannel", ...c })),
  };
}

beforeEach(() => {
  process.env.AI_SIDECAR_SHARED_SECRET = "shared-secret-value";
  checkEscalationDialMock.mockResolvedValue({ allowed: true });
  tenantDbMock.mockReturnValue(fakeTenantDb());
  ensureSystemActorIdMock.mockResolvedValue("system-actor-1");
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_SIDECAR_SHARED_SECRET;
  delete process.env.GSM_TRUNK_CAPACITY;
});

describe("POST /api/internal/ai/escalate — auth", () => {
  it("rejects a request with no x-internal-secret header", async () => {
    const response = await POST(request({ action: "check", agentId: "a1", callUuid: CALL_UUID }, {}));
    expect(response.status).toBe(401);
    expect(getAmiClientMock).not.toHaveBeenCalled();
  });

  it("rejects when the shared secret env var is not configured at all", async () => {
    delete process.env.AI_SIDECAR_SHARED_SECRET;
    const response = await POST(request({ action: "check", agentId: "a1", callUuid: CALL_UUID }));
    expect(response.status).toBe(401);
  });
});

describe("POST /api/internal/ai/escalate — validation", () => {
  it("rejects an invalid action", async () => {
    const response = await POST(request({ action: "bogus", agentId: "a1", callUuid: CALL_UUID }));
    expect(response.status).toBe(400);
  });

  it("rejects a non-UUID callUuid", async () => {
    const response = await POST(request({ action: "check", agentId: "a1", callUuid: "not-a-uuid" }));
    expect(response.status).toBe(400);
  });
});

describe("POST /api/internal/ai/escalate — check", () => {
  it("reports unavailable when the agent doesn't exist", async () => {
    aiAgentMock.findUnique.mockResolvedValue(null);
    getAmiClientMock.mockReturnValue(fakeAmi());

    const response = await POST(request({ action: "check", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ available: false, reason: "agent_not_found" });
  });

  it("reports unavailable when escalation is disabled", async () => {
    aiAgentMock.findUnique.mockResolvedValue(numberTargetAgent({ escalationEnabled: false }));
    getAmiClientMock.mockReturnValue(fakeAmi());

    const response = await POST(request({ action: "check", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ available: false, reason: "escalation_disabled" });
  });

  it("reports unavailable when no target is configured", async () => {
    aiAgentMock.findUnique.mockResolvedValue(numberTargetAgent({ handoffTargetKind: null, handoffNumberE164: null }));
    getAmiClientMock.mockReturnValue(fakeAmi());

    const response = await POST(request({ action: "check", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ available: false, reason: "no_target_configured" });
  });

  it("reports unavailable when the caller's channel can't be found", async () => {
    aiAgentMock.findUnique.mockResolvedValue(extensionTargetAgent());
    getAmiClientMock.mockReturnValue(fakeAmi({ sendAndCollect: vi.fn().mockResolvedValue(coreShowChannelsWith([])) }));

    const response = await POST(request({ action: "check", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ available: false, reason: "call_not_found" });
  });

  it("blocks a NUMBER target when GSM capacity is already at the configured limit", async () => {
    aiAgentMock.findUnique.mockResolvedValue(numberTargetAgent());
    getAmiClientMock.mockReturnValue(
      fakeAmi({
        sendAndCollect: vi.fn().mockResolvedValue(
          coreShowChannelsWith([
            { Channel: "PJSIP/dinstar-trunk-00000001", Uniqueid: CALL_UUID },
          ])
        ),
      })
    );

    const response = await POST(request({ action: "check", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ available: false, reason: "gsm_capacity" });
  });

  it("allows a NUMBER target when there is no other active GSM channel (under the default capacity of 1)", async () => {
    // GSM_TRUNK_CAPACITY is read once at module load (see the route's own
    // comment on why) — this exercises the real default (1) by keeping
    // active GSM channel count at 0, rather than mutating the env var at
    // runtime, which the module would never observe.
    aiAgentMock.findUnique.mockResolvedValue(numberTargetAgent());
    getAmiClientMock.mockReturnValue(
      fakeAmi({ sendAndCollect: vi.fn().mockResolvedValue(coreShowChannelsWith([{ Channel: "PJSIP/2001-00000001", Uniqueid: CALL_UUID }])) })
    );

    const response = await POST(request({ action: "check", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ available: true, targetKind: "NUMBER", targetLabel: "+971501234567" });
  });

  it("allows an EXTENSION target regardless of GSM channel count", async () => {
    aiAgentMock.findUnique.mockResolvedValue(extensionTargetAgent());
    getAmiClientMock.mockReturnValue(
      fakeAmi({
        sendAndCollect: vi.fn().mockResolvedValue(
          coreShowChannelsWith([
            { Channel: "PJSIP/dinstar-trunk-00000001", Uniqueid: CALL_UUID },
            { Channel: "PJSIP/dinstar-trunk-00000002" },
          ])
        ),
      })
    );

    const response = await POST(request({ action: "check", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ available: true, targetKind: "EXTENSION", targetLabel: "1002" });
  });

  it("reports unavailable when checkEscalationDial denies a NUMBER target", async () => {
    aiAgentMock.findUnique.mockResolvedValue(numberTargetAgent());
    checkEscalationDialMock.mockResolvedValue({ allowed: false, reason: "destination not in allowedDestinations" });
    getAmiClientMock.mockReturnValue(
      fakeAmi({ sendAndCollect: vi.fn().mockResolvedValue(coreShowChannelsWith([{ Channel: "PJSIP/2001-00000001", Uniqueid: CALL_UUID }])) })
    );

    const response = await POST(request({ action: "check", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ available: false, reason: "compliance_denied" });
  });
});

describe("POST /api/internal/ai/escalate — merge", () => {
  it("never touches the caller when the AI leg never joins the conference (join-gate timeout)", async () => {
    aiAgentMock.findUnique.mockResolvedValue(extensionTargetAgent());
    const send = vi.fn().mockResolvedValue({});
    const sendAndCollect = vi
      .fn()
      .mockResolvedValueOnce(coreShowChannelsWith([{ Channel: "PJSIP/dinstar-trunk-00000001", Uniqueid: CALL_UUID }]))
      // reapStrayAiLeg's own CoreShowChannels call, finds nothing to hang up
      .mockResolvedValueOnce(coreShowChannelsWith([]));
    const waitForEvent = vi.fn().mockResolvedValue(null); // ConfbridgeJoin never arrives
    getAmiClientMock.mockReturnValue(fakeAmi({ send, sendAndCollect, waitForEvent }));

    const response = await POST(request({ action: "merge", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ merged: false, reason: "ai_leg_join_timeout" });
    // The AI leg was Originated, but the caller was NEVER Redirected.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ Action: "Originate", Channel: "Local/ai@ai-conference-leg/n" }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ Action: "Redirect" }));
  });

  it("hangs up the AI leg and reports caller_hung_up when the caller vanishes before the Redirect lands", async () => {
    aiAgentMock.findUnique.mockResolvedValue(extensionTargetAgent());
    const send = vi.fn().mockImplementation(async (fields: Record<string, string>) => {
      if (fields.Action === "Redirect") throw new Error("AMI action failed (Redirect): No such channel");
      return {};
    });
    const sendAndCollect = vi
      .fn()
      .mockResolvedValue(coreShowChannelsWith([{ Channel: "PJSIP/dinstar-trunk-00000001", Uniqueid: CALL_UUID }]));
    const waitForEvent = vi.fn().mockResolvedValue({
      Event: "ConfbridgeJoin",
      Conference: "9123456",
      Channel: "Local/ai@ai-conference-leg-00000001;1",
    });
    getAmiClientMock.mockReturnValue(fakeAmi({ send, sendAndCollect, waitForEvent }));

    const response = await POST(request({ action: "merge", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ merged: false, reason: "caller_hung_up" });
    expect(send).toHaveBeenCalledWith({ Action: "Hangup", Channel: "Local/ai@ai-conference-leg-00000001;1" });
    // The human must never be dialed if the caller is already gone.
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ Action: "Originate", Channel: "PJSIP/1002" }));
  });

  it("merges an EXTENSION target end to end and reports whether the human answered", async () => {
    aiAgentMock.findUnique.mockResolvedValue(extensionTargetAgent());
    const send = vi.fn().mockResolvedValue({});
    const sendAndCollect = vi
      .fn()
      .mockResolvedValue(coreShowChannelsWith([{ Channel: "PJSIP/dinstar-trunk-00000001", Uniqueid: CALL_UUID }]));
    const waitForEvent = vi
      .fn()
      .mockResolvedValueOnce({ Event: "ConfbridgeJoin", Channel: "Local/ai@ai-conference-leg-00000001;1" })
      .mockResolvedValueOnce({ Event: "OriginateResponse", Reason: "4", Response: "Success" });
    getAmiClientMock.mockReturnValue(fakeAmi({ send, sendAndCollect, waitForEvent }));

    const response = await POST(request({ action: "merge", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toMatchObject({ merged: true, targetKind: "EXTENSION", targetLabel: "1002", humanAnswered: true });
    expect(json.confId).toMatch(/^9\d{6}$/);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ Action: "Redirect", Channel: "PJSIP/dinstar-trunk-00000001" }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ Action: "Originate", Channel: "PJSIP/1002" }));
  });

  it("dials a NUMBER target via Local/…@from-agent-<tier>/n, never directly at the dinstar trunk", async () => {
    aiAgentMock.findUnique.mockResolvedValue(numberTargetAgent());
    const send = vi.fn().mockResolvedValue({});
    const sendAndCollect = vi.fn().mockResolvedValue(coreShowChannelsWith([{ Channel: "PJSIP/2001-00000001", Uniqueid: CALL_UUID }]));
    const waitForEvent = vi
      .fn()
      .mockResolvedValueOnce({ Event: "ConfbridgeJoin", Channel: "Local/ai@ai-conference-leg-00000001;1" })
      .mockResolvedValueOnce(null); // human never answers
    getAmiClientMock.mockReturnValue(fakeAmi({ send, sendAndCollect, waitForEvent }));

    const response = await POST(request({ action: "merge", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toMatchObject({ merged: true, targetKind: "NUMBER", humanAnswered: false });
    const humanOriginate = send.mock.calls.find(
      (call) => call[0].Action === "Originate" && call[0].Channel !== "Local/ai@ai-conference-leg/n"
    );
    expect(humanOriginate).toBeDefined();
    expect(humanOriginate![0].Channel).toBe("Local/971501234567@from-agent-international/n");
    expect(humanOriginate![0].Channel).not.toMatch(/dinstar-trunk/);
  });

  it("blocks a NUMBER merge outright when GSM capacity is exhausted, before Originating anything", async () => {
    aiAgentMock.findUnique.mockResolvedValue(numberTargetAgent());
    const send = vi.fn().mockResolvedValue({});
    const sendAndCollect = vi.fn().mockResolvedValue(
      coreShowChannelsWith([{ Channel: "PJSIP/dinstar-trunk-00000001", Uniqueid: CALL_UUID }])
    );
    getAmiClientMock.mockReturnValue(fakeAmi({ send, sendAndCollect }));

    const response = await POST(request({ action: "merge", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ merged: false, reason: "gsm_capacity" });
    expect(send).not.toHaveBeenCalled();
  });

  it("reports call_not_found when the caller's channel can't be resolved", async () => {
    aiAgentMock.findUnique.mockResolvedValue(extensionTargetAgent());
    getAmiClientMock.mockReturnValue(fakeAmi({ sendAndCollect: vi.fn().mockResolvedValue(coreShowChannelsWith([])) }));

    const response = await POST(request({ action: "merge", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ merged: false, reason: "call_not_found" });
  });

  it("blocks a NUMBER merge when checkEscalationDial denies it (e.g. DNC), before touching AMI further", async () => {
    aiAgentMock.findUnique.mockResolvedValue(numberTargetAgent());
    checkEscalationDialMock.mockResolvedValue({ allowed: false, reason: "destination is on the Do Not Call list" });
    const send = vi.fn().mockResolvedValue({});
    const sendAndCollect = vi.fn().mockResolvedValue(coreShowChannelsWith([{ Channel: "PJSIP/2001-00000001", Uniqueid: CALL_UUID }]));
    getAmiClientMock.mockReturnValue(fakeAmi({ send, sendAndCollect }));

    const response = await POST(request({ action: "merge", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ merged: false, reason: "compliance_denied" });
    expect(checkEscalationDialMock).toHaveBeenCalledWith({
      tenantId: "tenant1",
      agentId: "a1",
      destinationE164: "+971501234567",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("never calls checkEscalationDial for an EXTENSION target — it dials no outside line", async () => {
    aiAgentMock.findUnique.mockResolvedValue(extensionTargetAgent());
    const send = vi.fn().mockResolvedValue({});
    const sendAndCollect = vi.fn().mockResolvedValue(coreShowChannelsWith([{ Channel: "PJSIP/dinstar-trunk-00000001", Uniqueid: CALL_UUID }]));
    const waitForEvent = vi
      .fn()
      .mockResolvedValueOnce({ Event: "ConfbridgeJoin", Channel: "Local/ai@ai-conference-leg-00000001;1" })
      .mockResolvedValueOnce(null);
    getAmiClientMock.mockReturnValue(fakeAmi({ send, sendAndCollect, waitForEvent }));

    await POST(request({ action: "merge", agentId: "a1", callUuid: CALL_UUID }));

    expect(checkEscalationDialMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/internal/ai/escalate — callback", () => {
  it("reports agent_not_found when the agent doesn't exist", async () => {
    aiAgentMock.findUnique.mockResolvedValue(null);
    getAmiClientMock.mockReturnValue(fakeAmi());

    const response = await POST(request({ action: "callback", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ created: false, reason: "agent_not_found" });
  });

  it("reports call_not_found when the caller's channel can't be resolved", async () => {
    aiAgentMock.findUnique.mockResolvedValue({ tenantId: "tenant1" });
    getAmiClientMock.mockReturnValue(fakeAmi({ sendAndCollect: vi.fn().mockResolvedValue(coreShowChannelsWith([])) }));

    const response = await POST(request({ action: "callback", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ created: false, reason: "call_not_found" });
  });

  it("reports caller_number_unknown when CoreShowChannel has no CallerIDNum", async () => {
    aiAgentMock.findUnique.mockResolvedValue({ tenantId: "tenant1" });
    getAmiClientMock.mockReturnValue(
      fakeAmi({ sendAndCollect: vi.fn().mockResolvedValue(coreShowChannelsWith([{ Channel: "PJSIP/2001-1", Uniqueid: CALL_UUID }])) })
    );

    const response = await POST(request({ action: "callback", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ created: false, reason: "caller_number_unknown" });
    expect(contactUpsertMock).not.toHaveBeenCalled();
  });

  it("reports no_assignee_available when there's no handoff-extension user and no tenant admin", async () => {
    aiAgentMock.findUnique
      .mockResolvedValueOnce({ tenantId: "tenant1" }) // handleCallback's own lookup
      .mockResolvedValueOnce({ handoffExtension: null }); // resolveCallbackAssignee's lookup
    contactUpsertMock.mockResolvedValue({ id: "contact1" });
    userFindFirstMock.mockResolvedValue(null);
    getAmiClientMock.mockReturnValue(
      fakeAmi({
        sendAndCollect: vi
          .fn()
          .mockResolvedValue(coreShowChannelsWith([{ Channel: "PJSIP/dinstar-trunk-1", Uniqueid: CALL_UUID, CallerIDNum: "+971501234567" }])),
      })
    );

    const response = await POST(request({ action: "callback", agentId: "a1", callUuid: CALL_UUID }));
    const json = await response.json();

    expect(json).toEqual({ created: false, reason: "no_assignee_available" });
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it("creates a callback task assigned to the handoff extension's user, and finds-or-creates the Contact", async () => {
    aiAgentMock.findUnique
      .mockResolvedValueOnce({ tenantId: "tenant1" })
      .mockResolvedValueOnce({ handoffExtension: { user: { id: "user-1" } } });
    contactUpsertMock.mockResolvedValue({ id: "contact1" });
    createTaskMock.mockResolvedValue({ id: "task-1" });
    getAmiClientMock.mockReturnValue(
      fakeAmi({
        sendAndCollect: vi
          .fn()
          .mockResolvedValue(coreShowChannelsWith([{ Channel: "PJSIP/dinstar-trunk-1", Uniqueid: CALL_UUID, CallerIDNum: "0501234567" }])),
      })
    );

    const response = await POST(
      request({ action: "callback", agentId: "a1", callUuid: CALL_UUID, reason: "billing question" })
    );
    const json = await response.json();

    expect(json).toEqual({ created: true, taskId: "task-1" });
    expect(contactUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_numberE164: { tenantId: "tenant1", numberE164: "+971501234567" } },
        create: { numberE164: "+971501234567" },
      })
    );
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "Callback requested — AI escalation",
        contactId: "contact1",
        assigneeId: "user-1",
        description: expect.stringContaining("billing question"),
      }),
      "system-actor-1"
    );
  });

  it("falls back to a tenant admin when the handoff target has no linked user", async () => {
    aiAgentMock.findUnique
      .mockResolvedValueOnce({ tenantId: "tenant1" })
      .mockResolvedValueOnce({ handoffExtension: { user: null } });
    contactUpsertMock.mockResolvedValue({ id: "contact1" });
    userFindFirstMock.mockResolvedValue({ id: "admin-1" });
    createTaskMock.mockResolvedValue({ id: "task-1" });
    getAmiClientMock.mockReturnValue(
      fakeAmi({
        sendAndCollect: vi
          .fn()
          .mockResolvedValue(coreShowChannelsWith([{ Channel: "PJSIP/dinstar-trunk-1", Uniqueid: CALL_UUID, CallerIDNum: "+971501234567" }])),
      })
    );

    await POST(request({ action: "callback", agentId: "a1", callUuid: CALL_UUID }));

    expect(userFindFirstMock).toHaveBeenCalledWith({ where: { role: "ADMIN" }, select: { id: true } });
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ assigneeId: "admin-1" }),
      "system-actor-1"
    );
  });
});
