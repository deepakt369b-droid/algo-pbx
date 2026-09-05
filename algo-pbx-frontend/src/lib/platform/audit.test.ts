import { describe, it, expect, vi } from "vitest";
import {
  requireReason,
  isReasonRequired,
  recordPlatformAudit,
  MissingReasonError,
  REASON_REQUIRED_ACTIONS,
  type PlatformAuditAction,
} from "./audit";

describe("requireReason", () => {
  it("returns the trimmed reason", () => {
    expect(requireReason("  disputed invoice settled  ")).toBe("disputed invoice settled");
  });

  it.each(["", "   ", "\t\n  "])("rejects whitespace-only input %j", (input) => {
    // The case a zod .min(1) would wave through, and the one that makes an
    // audit trail useless during an incident.
    expect(() => requireReason(input)).toThrow(MissingReasonError);
  });

  it.each([undefined, null, 42, {}, []])("rejects non-string %s", (input) => {
    expect(() => requireReason(input)).toThrow(MissingReasonError);
  });

  it("names the action in the error so the API can surface it verbatim", () => {
    expect(() => requireReason("", "tenant.suspend")).toThrow(/tenant\.suspend/);
  });
});

describe("isReasonRequired", () => {
  it.each<PlatformAuditAction>([
    "tenant.suspend",
    "tenant.offboard",
    "tenant.dialplan_cut",
    "billing.mark_paid",
    "billing.comp",
    "support_grant.create",
    "platform_user.role_change",
  ])("requires a reason for the consequential action %s", (action) => {
    expect(isReasonRequired(action)).toBe(true);
  });

  it.each<PlatformAuditAction>(["platform.login", "platform_user.totp_confirmed"])(
    "does not require one for the passive action %s",
    (action) => {
      expect(isReasonRequired(action)).toBe(false);
    }
  );

  // The plan lists these four by name as needing a reason; assert the list
  // literally so nobody can quietly drop one while refactoring.
  it("covers every action the plan names explicitly", () => {
    for (const action of [
      "tenant.suspend",
      "tenant.offboard",
      "tenant.dialplan_cut",
      "support_grant.create",
    ] as PlatformAuditAction[]) {
      expect(REASON_REQUIRED_ACTIONS).toContain(action);
    }
  });

  it("requires a reason for every billing action", () => {
    const billing = REASON_REQUIRED_ACTIONS.filter((a) => a.startsWith("billing."));
    expect(billing).toEqual([
      "billing.mark_paid",
      "billing.extend",
      "billing.change_plan",
      "billing.comp",
    ]);
  });
});

describe("recordPlatformAudit", () => {
  function fakeTx() {
    return { platformAuditLog: { create: vi.fn().mockResolvedValue({}) } };
  }

  it("writes the row with a trimmed reason", async () => {
    const tx = fakeTx();
    await recordPlatformAudit(
      {
        action: "billing.mark_paid",
        platformUserId: "pu1",
        tenantId: "t1",
        reason: "  paid by bank transfer  ",
        metadata: { paidUntil: "2026-10-05" },
      },
      tx
    );

    expect(tx.platformAuditLog.create).toHaveBeenCalledWith({
      data: {
        action: "billing.mark_paid",
        platformUserId: "pu1",
        tenantId: "t1",
        reason: "paid by bank transfer",
        metadata: { paidUntil: "2026-10-05" },
      },
    });
  });

  it("refuses to write a reason-required action with no reason", async () => {
    const tx = fakeTx();
    await expect(
      recordPlatformAudit({ action: "tenant.dialplan_cut", tenantId: "t1", reason: "  " }, tx)
    ).rejects.toThrow(MissingReasonError);
    // And crucially, writes nothing at all rather than a reasonless row.
    expect(tx.platformAuditLog.create).not.toHaveBeenCalled();
  });

  it("allows a passive action with no reason, storing null", async () => {
    const tx = fakeTx();
    await recordPlatformAudit({ action: "platform.login", platformUserId: "pu1" }, tx);
    expect(tx.platformAuditLog.create).toHaveBeenCalledWith({
      data: {
        action: "platform.login",
        platformUserId: "pu1",
        tenantId: null,
        reason: null,
        metadata: {},
      },
    });
  });

  it("defaults metadata to an empty object rather than undefined", async () => {
    const tx = fakeTx();
    await recordPlatformAudit({ action: "audit.export", platformUserId: "pu1" }, tx);
    const call = tx.platformAuditLog.create.mock.calls[0][0] as { data: { metadata: unknown } };
    expect(call.data.metadata).toEqual({});
  });
});
