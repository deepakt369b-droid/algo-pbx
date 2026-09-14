import { describe, expect, it } from "vitest";
import { canOfferAiAgentOption, isSeatMeterFull } from "./agent-eligibility";

// No @testing-library/react / jsdom in this repo's vitest setup
// (vitest.config.ts runs environment: "node") — these two checks are
// exercised as pure logic here rather than by rendering
// admin/users/page.tsx or the ai-agents pages, per that file's own header.

describe("canOfferAiAgentOption", () => {
  it("hides the AI option on a plan without the aiAgents feature", () => {
    expect(canOfferAiAgentOption("standard")).toBe(false);
    expect(canOfferAiAgentOption("trial")).toBe(false);
    expect(canOfferAiAgentOption("pro")).toBe(false);
  });

  it("shows the AI option on the premium plan", () => {
    expect(canOfferAiAgentOption("premium")).toBe(true);
  });

  it("treats an unknown plan id the same as one with no features", () => {
    expect(canOfferAiAgentOption("some-made-up-plan")).toBe(false);
  });
});

describe("isSeatMeterFull", () => {
  it("disables submission when seatsUsed has reached seatsTotal", () => {
    expect(isSeatMeterFull({ seatsUsed: 4, seatsTotal: 4 })).toBe(true);
  });

  it("disables submission when seatsUsed exceeds seatsTotal", () => {
    expect(isSeatMeterFull({ seatsUsed: 5, seatsTotal: 4 })).toBe(true);
  });

  it("allows submission when a seat is still free", () => {
    expect(isSeatMeterFull({ seatsUsed: 3, seatsTotal: 4 })).toBe(false);
  });

  it("treats a zero/unset seat allocation as full, not unlimited", () => {
    expect(isSeatMeterFull({ seatsUsed: 0, seatsTotal: 0 })).toBe(true);
  });
});
