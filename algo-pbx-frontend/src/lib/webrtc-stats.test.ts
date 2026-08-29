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

  // Regression tests for 2026-08-29: this file used to read ONLY
  // inbound-rtp/candidate-pair, so nothing here could ever confirm the
  // agent's own outgoing audio — the exact question that twice this
  // session could only be answered by decoding a live packet capture by
  // hand (the far end heard nothing while Asterisk's own packet counters
  // for the agent's leg looked perfectly healthy).

  it("extracts packetsSent from outbound-rtp", () => {
    const report = fakeReport([{ type: "outbound-rtp", kind: "audio", packetsSent: 1234 }]);
    const q = extractCallQuality(report);
    expect(q.packetsSent).toBe(1234);
  });

  it("extracts audioLevel and totalAudioEnergy from media-source", () => {
    const report = fakeReport([{ type: "media-source", kind: "audio", audioLevel: 0.42, totalAudioEnergy: 3.7 }]);
    const q = extractCallQuality(report);
    expect(q.audioLevel).toBe(0.42);
    expect(q.totalAudioEnergy).toBe(3.7);
  });

  it("distinguishes a healthy network from a silent mic on otherwise-identical packet counts", () => {
    // packetsSent climbing normally, but the mic's own media-source stat
    // shows near-zero level/energy — this is exactly the failure mode
    // that Asterisk's channel counters alone could not reveal.
    const report = fakeReport([
      { type: "outbound-rtp", kind: "audio", packetsSent: 5000 },
      { type: "media-source", kind: "audio", audioLevel: 0.0001, totalAudioEnergy: 0.0002 },
      { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.03 },
    ]);
    const q = extractCallQuality(report);
    expect(q.packetsSent).toBe(5000);
    expect(q.audioLevel).toBeLessThan(0.01);
    expect(q.totalAudioEnergy).toBeLessThan(0.01);
  });

  it("returns null for the new fields when their stat types are absent", () => {
    const report = fakeReport([{ type: "inbound-rtp", kind: "audio", jitter: 0.01 }]);
    const q = extractCallQuality(report);
    expect(q.packetsSent).toBeNull();
    expect(q.audioLevel).toBeNull();
    expect(q.totalAudioEnergy).toBeNull();
  });
});
