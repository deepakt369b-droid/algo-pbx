import { describe, expect, it } from "vitest";
import { buildPortCfgPayload } from "./port-config";

// Regression tests for the exact field scheme confirmed live against the
// production Dinstar UC2000 gateway 2026-08-29 — a fresh Node HTTP client
// (not just a browser) logged in and wrote this payload for real, then a
// browser re-read confirmed ports 0-3 showed "100" and 4-7 stayed empty
// with nothing else disturbed. These tests pin that shape so a future
// change can't silently drift from what was actually proven to work.
describe("buildPortCfgPayload", () => {
  it("sets the hotline on ports 0-3 only, matching this UC2000's real modem hardware", () => {
    const params = buildPortCfgPayload("100");
    for (const n of [0, 1, 2, 3]) {
      expect(params.get(`OffhookAutodial${n}`)).toBe("100");
    }
    for (const n of [4, 5, 6, 7]) {
      expect(params.get(`OffhookAutodial${n}`)).toBe("");
    }
  });

  it("leaves every SIP/registration field at the confirmed-blank baseline for all 8 ports", () => {
    const params = buildPortCfgPayload("100");
    for (let n = 0; n <= 7; n++) {
      expect(params.get(`SipAcc${n}`)).toBe("");
      expect(params.get(`AuthenticateID${n}`)).toBe("");
      expect(params.get(`SipAccPsw${n}`)).toBe("");
      expect(params.get(`SipLocalPort${n}`)).toBe("");
      expect(params.get(`PSTNHotline${n}`)).toBe("");
    }
  });

  it("sets Register=No Register (64) and the factory-default gains on every port", () => {
    const params = buildPortCfgPayload("100");
    for (let n = 0; n <= 7; n++) {
      expect(params.get(`Register${n}`)).toBe("64");
      expect(params.get(`TxGain${n}`)).toBe("2");
      expect(params.get(`RxGain${n}`)).toBe("6");
    }
  });

  it("leaves the form's bulk 'All' row blank", () => {
    const params = buildPortCfgPayload("100");
    for (const field of ["SipAcc", "AuthenticateID", "SipAccPsw", "SipLocalPort", "OffhookAutodial", "PSTNHotline"]) {
      expect(params.get(`${field}All`)).toBe("");
    }
  });

  it("includes the submit field the device's own form uses", () => {
    const params = buildPortCfgPayload("100");
    expect(params.get("ok")).toBe("Save");
  });

  it("accepts the alternate hotline value 's' matching extensions.conf's literal s extension", () => {
    const params = buildPortCfgPayload("s");
    expect(params.get("OffhookAutodial0")).toBe("s");
  });
});
