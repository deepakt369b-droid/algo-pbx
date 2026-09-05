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
