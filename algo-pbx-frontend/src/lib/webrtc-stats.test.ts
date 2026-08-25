import { describe, expect, it } from "vitest";
import { extractCallQuality } from "./webrtc-stats";

// RTCStatsReport is Map-like (has forEach(value, key)); a plain Map is a
// faithful enough stand-in for this pure extraction logic without needing
// a real RTCPeerConnection (unavailable in a Node test environment anyway).
function fakeReport(entries: Record<string, unknown>[]): RTCStatsReport {
  const map = new Map();
  entries.forEach((e, i) => map.set(String(i), e));
  return map as unknown as RTCStatsReport;
}

describe("extractCallQuality", () => {
  it("extracts jitter/loss/rtt from a clean report and estimates a high MOS", () => {
    const report = fakeReport([
      { type: "inbound-rtp", kind: "audio", jitter: 0.005, packetsLost: 0, packetsReceived: 1000, jitterBufferDelay: 4, jitterBufferEmittedCount: 1000 },
      { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.03 },
    ]);

    const q = extractCallQuality(report);
    expect(q.jitterMs).toBeCloseTo(5, 0);
    expect(q.packetsLost).toBe(0);
    expect(q.roundTripTimeMs).toBeCloseTo(30, 0);
    expect(q.mosEstimate).not.toBeNull();
    expect(q.mosEstimate!).toBeGreaterThan(4);
  });

  it("degrades the MOS estimate under high jitter and packet loss", () => {
    const report = fakeReport([
      { type: "inbound-rtp", kind: "audio", jitter: 0.12, packetsLost: 150, packetsReceived: 850 },
      { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.4 },
    ]);

    const q = extractCallQuality(report);
    expect(q.mosEstimate!).toBeLessThan(3);
  });

  it("returns nulls rather than throwing when no candidate-pair stat is present", () => {
    const report = fakeReport([{ type: "inbound-rtp", kind: "audio", jitter: 0.01 }]);
    const q = extractCallQuality(report);
    expect(q.roundTripTimeMs).toBeNull();
    expect(q.mosEstimate).toBeNull();
  });

  it("ignores non-succeeded candidate pairs", () => {
    const report = fakeReport([{ type: "candidate-pair", state: "failed", currentRoundTripTime: 0.05 }]);
    const q = extractCallQuality(report);
    expect(q.roundTripTimeMs).toBeNull();
  });
});
