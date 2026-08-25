export type CallState = "idle" | "calling" | "ringing" | "active" | "held";

export type AgentStatus = "AVAILABLE" | "BUSY" | "BREAK" | "OFFLINE";

export interface CdrRow {
  id: string;
  uniqueId: string;
  callerNumber: string;
  destination: string;
  direction: "inbound" | "outbound" | "internal";
  disposition: string;
  startedAt: string;
  durationSec: number;
  agentExtension: string | null;
  recordingUrl: string | null;
}

export interface QueueSnapshot {
  name: string;
  strategy: string;
  waiting: number;
  longestWaitSec: number;
  // "PAUSED" comes from the AMI QueueMember event's Paused flag (an agent
  // deliberately held out of rotation via QueuePause) — it is not an
  // Asterisk device state, hence the union rather than widening AgentStatus.
  members: { extension: string; status: AgentStatus | "PAUSED" }[];
}

export interface WallboardSnapshot {
  activeCalls: number;
  agentsOnline: number;
  queues: QueueSnapshot[];
  generatedAt: string;
}
