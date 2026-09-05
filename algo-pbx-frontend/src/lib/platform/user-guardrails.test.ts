import { describe, it, expect } from "vitest";
import {
  canDisable,
  canEnable,
  canChangeRole,
  canResetTotp,
  enabledOwnerCount,
  type PlatformUserView,
} from "./user-guardrails";

const owner1: PlatformUserView = { id: "o1", email: "owner1@x.com", role: "PLATFORM_OWNER", disabled: false };
const owner2: PlatformUserView = { id: "o2", email: "owner2@x.com", role: "PLATFORM_OWNER", disabled: false };
const disabledOwner: PlatformUserView = { id: "o3", email: "owner3@x.com", role: "PLATFORM_OWNER", disabled: true };
const support: PlatformUserView = { id: "s1", email: "support@x.com", role: "PLATFORM_SUPPORT", disabled: false };

function reasonOf(r: ReturnType<typeof canDisable>): string {
  return r.ok ? "" : r.reason;
}

describe("last-owner protection — disable", () => {
  it("refuses to disable the only owner", () => {
    const result = canDisable(owner1, [owner1, support], "o2");
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/last enabled PLATFORM_OWNER/);
    expect(reasonOf(result)).toMatch(/Create another owner first/);
  });

  it("allows disabling an owner when a second enabled owner exists", () => {
    expect(canDisable(owner1, [owner1, owner2], "o2").ok).toBe(true);
  });

  // The subtle one: a disabled owner cannot log in, so it cannot be the
  // account that rescues us, and must not count as a spare.
  it("does not count a DISABLED owner as the spare", () => {
    const result = canDisable(owner1, [owner1, disabledOwner], "o2");
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/last enabled/);
  });

  it("always allows disabling a support user", () => {
    expect(canDisable(support, [owner1, support], "o1").ok).toBe(true);
  });

  it("refuses to disable an already-disabled account", () => {
    expect(canDisable(disabledOwner, [owner1, disabledOwner], "o1").ok).toBe(false);
  });
});

describe("self-action protection", () => {
  it("refuses self-disable even with other owners present", () => {
    const result = canDisable(owner1, [owner1, owner2], "o1");
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/cannot disable your own account/i);
  });

  it("refuses self-role-edit — the privilege-escalation case", () => {
    // A compromised support session promoting itself to owner is exactly the
    // boundary the platform plane exists to draw.
    const result = canChangeRole(support, "PLATFORM_OWNER", [owner1, support], "s1");
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/cannot change your own role/i);
  });

  it("refuses self-demotion by the same rule", () => {
    expect(canChangeRole(owner1, "PLATFORM_SUPPORT", [owner1, owner2], "o1").ok).toBe(false);
  });
});

describe("reason precedence when two rules both apply", () => {
  // The sole owner acting on themselves trips both the last-owner rule and
  // the self-edit rule. Either way the action is refused, but only one of the
  // two messages is true: "ask another platform owner" names somebody who
  // does not exist, and would send an operator looking for a colleague
  // instead of creating a second owner.
  it("tells the sole owner to create another owner, not to ask one", () => {
    const result = canDisable(owner1, [owner1, support], "o1");
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/last enabled PLATFORM_OWNER/);
    expect(reasonOf(result)).toMatch(/Create another owner first/);
  });

  it("gives the same precedence for a sole owner demoting themselves", () => {
    const result = canChangeRole(owner1, "PLATFORM_SUPPORT", [owner1, support], "o1");
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/last enabled PLATFORM_OWNER/);
    expect(reasonOf(result)).toMatch(/Promote another owner first/);
  });

  // A no-op is neither, and must not borrow either message.
  it("answers a no-op role change as a no-op, even for the sole owner", () => {
    const result = canChangeRole(owner1, "PLATFORM_OWNER", [owner1, support], "o1");
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/already has the PLATFORM_OWNER role/);
  });
});

describe("last-owner protection — demotion", () => {
  it("refuses to demote the only owner", () => {
    const result = canChangeRole(owner1, "PLATFORM_SUPPORT", [owner1, support], "o2");
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/last enabled PLATFORM_OWNER/);
    expect(reasonOf(result)).toMatch(/Promote another owner first/);
  });

  it("allows demoting an owner when a second enabled owner exists", () => {
    expect(canChangeRole(owner1, "PLATFORM_SUPPORT", [owner1, owner2], "o2").ok).toBe(true);
  });

  it("always allows promoting a support user", () => {
    expect(canChangeRole(support, "PLATFORM_OWNER", [owner1, support], "o1").ok).toBe(true);
  });

  it("refuses a no-op role change", () => {
    expect(canChangeRole(support, "PLATFORM_SUPPORT", [owner1, support], "o1").ok).toBe(false);
  });
});

describe("canEnable", () => {
  it("enables a disabled account", () => {
    expect(canEnable(disabledOwner).ok).toBe(true);
  });

  it("refuses a no-op enable", () => {
    expect(canEnable(owner1).ok).toBe(false);
  });
});

describe("canResetTotp", () => {
  // Deliberately NOT last-owner-guarded: this is the recovery path for an
  // owner who lost their authenticator, so blocking it would create the very
  // lockout the other rules exist to prevent.
  it("allows resetting TOTP for the last remaining owner", () => {
    expect(canResetTotp(owner1).ok).toBe(true);
  });

  it("refuses for a disabled account", () => {
    const result = canResetTotp(disabledOwner);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/Enable the account before/);
  });
});

describe("enabledOwnerCount", () => {
  it("counts only enabled owners", () => {
    expect(enabledOwnerCount([owner1, owner2, disabledOwner, support])).toBe(2);
    expect(enabledOwnerCount([disabledOwner, support])).toBe(0);
  });
});
