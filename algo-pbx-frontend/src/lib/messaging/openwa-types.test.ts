import { describe, expect, it } from "vitest";
import { toWaInstanceStatus, type OpenWaSessionStatus } from "./openwa-types";

describe("toWaInstanceStatus", () => {
  const pairingStates: OpenWaSessionStatus[] = ["created", "initializing", "qr_ready", "authenticating"];
  for (const state of pairingStates) {
    it(`maps "${state}" to PAIRING`, () => {
      expect(toWaInstanceStatus(state)).toBe("PAIRING");
    });
  }

  it('maps "ready" to CONNECTED', () => {
    expect(toWaInstanceStatus("ready")).toBe("CONNECTED");
  });

  const disconnectedStates: OpenWaSessionStatus[] = ["disconnected", "failed", "action_required"];
  for (const state of disconnectedStates) {
    it(`maps "${state}" to DISCONNECTED`, () => {
      expect(toWaInstanceStatus(state)).toBe("DISCONNECTED");
    });
  }
});
