// Pure-ish helper for turning a raw RTCStatsReport into the handful of
// numbers that actually explain "why did this call sound bad" — jitter,
// packet loss, round-trip time, and a rough E-model MOS estimate. Before
// this file existed, grep for `getStats` across the entire frontend
// returned zero hits: when an agent reported bad audio there was no data
// anywhere to tell whether the fault was the agent's home network, the
// cloud VM, or the Tailscale/UAE leg. Consumed by
// src/contexts/sip-context.tsx (polls the active session's peer connection
// every 5s and POSTs summaries to /api/calls/quality) and surfaced live in
// src/components/call-controls.tsx so agents can self-report accurately
// instead of guessing.

export interface CallQualitySample {
  timestamp: number;
  jitterMs: number | null;
  packetsLost: number | null;
  packetsReceived: number | null;
  roundTripTimeMs: number | null;
  jitterBufferDelayMs: number | null;
  mosEstimate: number | null;
  /** Confirmed packets leaving the agent's browser toward Asterisk. Was
   * entirely unrecorded before 2026-08-29 — "is the mic actually producing
   * sound" required decoding a live packet capture by hand, twice, in one
   * session. Present whenever an outbound audio track exists, independent
   * of whether the network ever delivers the packets anywhere. */
  packetsSent: number | null;
  /** The sender's OWN mic level (RTCAudioSourceStats.audioLevel, 0-1) —
   * read from `media-source`, i.e. before encoding/network, so this is the
   * one number that answers "is the microphone itself producing audio"
   * independent of every network-layer question. */
  audioLevel: number | null;
  /** Cumulative energy since the track started — a mic gated to silence
   * for most of a call shows this barely climbing sample to sample, which
   * is a much stronger signal than a single audioLevel snapshot. */
  totalAudioEnergy: number | null;
}

// Extracts the numbers we care about from getStats()'s report. Written
// defensively against the report shape varying slightly across browsers —
// every field is optional in the RTCStats dictionaries, Chrome/Firefox
// disagree on a few names, and this only needs to degrade to `null`, never
// throw, since it runs on a hot polling path during a live call.
export function extractCallQuality(report: RTCStatsReport): CallQualitySample {
  let jitterMs: number | null = null;
  let packetsLost: number | null = null;
  let packetsReceived: number | null = null;
  let jitterBufferDelayMs: number | null = null;
  let roundTripTimeMs: number | null = null;
  let packetsSent: number | null = null;
  let audioLevel: number | null = null;
  let totalAudioEnergy: number | null = null;

  report.forEach((stat) => {
    if (stat.type === "inbound-rtp" && (stat.kind === "audio" || stat.mediaType === "audio")) {
      if (typeof stat.jitter === "number") jitterMs = stat.jitter * 1000;
      if (typeof stat.packetsLost === "number") packetsLost = stat.packetsLost;
      if (typeof stat.packetsReceived === "number") packetsReceived = stat.packetsReceived;
      if (typeof stat.jitterBufferDelay === "number" && typeof stat.jitterBufferEmittedCount === "number" && stat.jitterBufferEmittedCount > 0) {
        jitterBufferDelayMs = (stat.jitterBufferDelay / stat.jitterBufferEmittedCount) * 1000;
      }
    }
    if (stat.type === "candidate-pair" && stat.state === "succeeded" && typeof stat.currentRoundTripTime === "number") {
      roundTripTimeMs = stat.currentRoundTripTime * 1000;
    }
    // outbound-rtp: confirms packets actually left the browser toward
    // Asterisk — the direction inbound-rtp/candidate-pair above cannot see
    // at all.
    if (stat.type === "outbound-rtp" && (stat.kind === "audio" || stat.mediaType === "audio")) {
      if (typeof stat.packetsSent === "number") packetsSent = stat.packetsSent;
    }
    // media-source: the mic's own signal, captured BEFORE encoding or the
    // network — the only stat that can distinguish "mic is silent" from
    // "mic is fine but the network/server dropped it".
    if (stat.type === "media-source" && stat.kind === "audio") {
      if (typeof stat.audioLevel === "number") audioLevel = stat.audioLevel;
      if (typeof stat.totalAudioEnergy === "number") totalAudioEnergy = stat.totalAudioEnergy;
    }
  });

  return {
    timestamp: Date.now(),
    jitterMs,
    packetsLost,
    packetsReceived,
    roundTripTimeMs,
    jitterBufferDelayMs,
    mosEstimate: estimateMos({ jitterMs, packetsLost, packetsReceived, roundTripTimeMs }),
    packetsSent,
    audioLevel,
    totalAudioEnergy,
  };
}

// Simplified ITU-T E-model (R-factor -> MOS), NOT a certified PESQ/POLQA
// score — good enough as a relative "is this call degraded" signal for an
// agent-facing indicator and for correlating quality complaints with a
// specific network leg, not for SLA reporting.
function estimateMos(input: {
  jitterMs: number | null;
  packetsLost: number | null;
  packetsReceived: number | null;
  roundTripTimeMs: number | null;
}): number | null {
  const { jitterMs, packetsLost, packetsReceived, roundTripTimeMs } = input;
  if (roundTripTimeMs == null) return null;

  // Base R-factor for a well-provisioned G.711/Opus path.
  let r = 93.2;

  // One-way delay penalty (Id) — approximate the one-way leg as RTT/2 plus
  // an average jitter-buffer contribution.
  const oneWayDelay = roundTripTimeMs / 2 + (jitterMs ?? 0);
  r -= oneWayDelay < 160 ? oneWayDelay / 40 : (oneWayDelay - 120) / 10;

  // Packet-loss penalty (Ie-eff), rough logarithmic approximation.
  if (packetsLost != null && packetsReceived != null && packetsReceived + packetsLost > 0) {
    const lossPct = (packetsLost / (packetsReceived + packetsLost)) * 100;
    r -= lossPct * 2.5;
  }

  r = Math.max(0, Math.min(100, r));
  if (r <= 0) return 1;
  // Standard R-to-MOS conversion.
  const mos = 1 + 0.035 * r + r * (r - 60) * (100 - r) * 7e-6;
  return Math.round(Math.max(1, Math.min(4.5, mos)) * 100) / 100;
}
