import { describe, it, expect } from "vitest";
import {
  suspendBlastRadius,
  unsuspendBlastRadius,
  dialplanCutBlastRadius,
  dialplanRestoreBlastRadius,
  offboardBlastRadius,
  supportGrantBlastRadius,
  platformUserDisableBlastRadius,
  platformOwnerCreateBlastRadius,
  TELEPHONY_UNAFFECTED_NOTE,
  extensionAssignBlastRadius,
  extensionUnassignBlastRadius,
  extensionDialPermissionBlastRadius,
  planChangeBlastRadius,
} from "./blast-radius";

describe("suspendBlastRadius", () => {
  // Asserted against the literal mandated sentence. If a component edits this
  // copy, this test fails — which is the entire purpose of the module.
  it("matches the mandated wording exactly", () => {
    expect(suspendBlastRadius("Acme Ltd", 12)).toBe(
      "This suspends login for all 12 users of Acme Ltd. Calls are NOT affected."
    );
  });

  it("pluralises correctly at one user", () => {
    expect(suspendBlastRadius("Acme Ltd", 1)).toBe(
      "This suspends login for all 1 user of Acme Ltd. Calls are NOT affected."
    );
  });

  it("handles zero users without reading as a typo", () => {
    expect(suspendBlastRadius("Acme Ltd", 0)).toContain("all 0 users");
  });
});

describe("the suspend/telephony distinction is stated everywhere it should be", () => {
  it("suspend and unsuspend both say calls are unaffected", () => {
    expect(suspendBlastRadius("Acme", 3)).toMatch(/Calls are NOT affected/);
    expect(unsuspendBlastRadius("Acme", 3)).toMatch(/Calls were never affected/);
  });

  it("the shared note says login-only and never-automatic", () => {
    expect(TELEPHONY_UNAFFECTED_NOTE).toMatch(/login only/i);
    expect(TELEPHONY_UNAFFECTED_NOTE).toMatch(/never stopped automatically/i);
  });
});

describe("dialplanCutBlastRadius — the one action that IS an outage", () => {
  const copy = dialplanCutBlastRadius("Acme Ltd");

  it("says plainly that all calls stop, both directions", () => {
    expect(copy).toMatch(/STOPS ALL CALLS/);
    expect(copy).toMatch(/inbound and outbound/);
  });

  it("names the customer-facing consequence rather than abstracting it", () => {
    expect(copy).toMatch(/blame them/);
  });

  it("states it is not a billing action and never automatic", () => {
    expect(copy).toMatch(/not a billing action/);
    expect(copy).toMatch(/never triggered automatically/);
  });

  it("asks for typed confirmation", () => {
    expect(copy).toMatch(/Type the tenant slug/);
  });

  // Guards against the worst possible copy-paste: reusing the reassuring
  // suspend sentence on the action that actually cuts calls.
  it("never claims calls are unaffected", () => {
    expect(copy).not.toMatch(/NOT affected/);
    expect(copy).not.toMatch(/never affected/);
  });

  it("names the tenant so a wrong-row click is visible", () => {
    expect(copy).toContain("Acme Ltd");
    expect(dialplanRestoreBlastRadius("Acme Ltd")).toContain("Acme Ltd");
  });
});

describe("offboardBlastRadius", () => {
  const copy = offboardBlastRadius("Acme Ltd", 9);

  it("enumerates the revocation steps", () => {
    expect(copy).toMatch(/certificate is revoked/);
    expect(copy).toMatch(/CRL is regenerated/);
    expect(copy).toMatch(/OpenVPN is reloaded/);
    expect(copy).toMatch(/blocked at the firewall/);
  });

  it("states the no-deletion rule unmissably", () => {
    expect(copy).toMatch(/NO DATA IS DELETED/);
    expect(copy).toMatch(/export must be offered first/);
    expect(copy).toMatch(/PDPL/);
  });

  it("includes the login blast radius with correct pluralisation", () => {
    expect(copy).toContain("all 9 users");
    expect(offboardBlastRadius("Acme", 1)).toContain("all 1 user.");
  });
});

describe("supportGrantBlastRadius", () => {
  it("tells the operator the customer will see them", () => {
    const copy = supportGrantBlastRadius("Acme Ltd", 4);
    expect(copy).toMatch(/banner naming you/);
    expect(copy).toMatch(/4 hours/);
    expect(copy).toMatch(/audit log/);
  });

  it("pluralises a single hour", () => {
    expect(supportGrantBlastRadius("Acme", 1)).toContain("1 hour.");
  });
});

describe("platform user copy", () => {
  it("says a disable takes effect on the next request, not at session expiry", () => {
    const copy = platformUserDisableBlastRadius("ops@example.com");
    expect(copy).toMatch(/next request/);
    expect(copy).toMatch(/support grants they hold stop working/);
  });

  it("spells out what a PLATFORM_OWNER can do, including the dialplan cut", () => {
    const copy = platformOwnerCreateBlastRadius("ops@example.com");
    expect(copy).toMatch(/cut any tenant's dialplan/);
    expect(copy).toMatch(/Type the email below/);
  });
});

describe("extension assignment copy", () => {
  it("states the extension assign consequence exactly", () => {
    expect(extensionAssignBlastRadius("101", "agent@example.com")).toBe(
      "This assigns extension 101 to agent@example.com. They can place and receive calls on it immediately."
    );
  });

  it("states the extension unassign consequence exactly", () => {
    expect(extensionUnassignBlastRadius("101", "agent@example.com")).toBe(
      "This unassigns extension 101 from agent@example.com. It becomes unassigned and unreachable until reassigned."
    );
  });

  it("states the dial permission change exactly", () => {
    expect(extensionDialPermissionBlastRadius("101", "INTERNATIONAL")).toBe(
      "This changes extension 101's dial permission to INTERNATIONAL."
    );
  });
});

describe("planChangeBlastRadius", () => {
  it("states a plain upgrade with no feature loss", () => {
    const text = planChangeBlastRadius("Acme", "Standard", "Premium", {
      direction: "upgrade",
      priceDeltaUsd: 300,
      featuresLost: [],
      aiAgentsToLock: 0,
    });
    expect(text).toBe("Upgrades Acme from Standard to Premium (+$300/mo).");
  });

  it("states a downgrade with no configured AI agents to lock", () => {
    const text = planChangeBlastRadius("Acme", "Premium", "Standard", {
      direction: "downgrade",
      priceDeltaUsd: -300,
      featuresLost: ["aiAgents"],
      aiAgentsToLock: 0,
    });
    expect(text).toContain("Downgrades Acme from Premium to Standard (-$300/mo).");
    expect(text).toContain("none are currently configured, so nothing is locked");
  });

  it("names the exact number of AI agents that will be locked, and states the safe-fallthrough guarantee", () => {
    const text = planChangeBlastRadius("Acme", "Premium", "Standard", {
      direction: "downgrade",
      priceDeltaUsd: -300,
      featuresLost: ["aiAgents"],
      aiAgentsToLock: 3,
    });
    expect(text).toContain("3 AI agents will be locked (disabled) immediately");
    expect(text).toContain("fall through to the human queue");
    expect(text).toContain("nothing is deleted");
  });

  it("singularises correctly for exactly one agent", () => {
    const text = planChangeBlastRadius("Acme", "Premium", "Standard", {
      direction: "downgrade",
      priceDeltaUsd: -300,
      featuresLost: ["aiAgents"],
      aiAgentsToLock: 1,
    });
    expect(text).toContain("1 AI agent will be locked");
    expect(text).not.toContain("1 AI agents");
  });

  it("states no price change explicitly when the price is identical", () => {
    const text = planChangeBlastRadius("Acme", "Standard", "Standard", {
      direction: "same",
      priceDeltaUsd: 0,
      featuresLost: [],
      aiAgentsToLock: 0,
    });
    expect(text).toBe("Changes Acme from Standard to Standard (no price change).");
  });
});
