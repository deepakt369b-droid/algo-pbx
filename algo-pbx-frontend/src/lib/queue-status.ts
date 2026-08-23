import type { AmiClient } from "@/lib/ami-client";
import type { AgentStatus, QueueSnapshot } from "@/types";

// Asterisk 20 AMI QueueMemberStatus device-state enum, verified against
// docs.asterisk.org/.../AMI_Events/QueueMemberStatus/. The QueueMember event
// emitted mid-QueueStatus-response is a different event from the async
// QueueMemberStatus one docs were checked against — field overlap (Status,
// Interface, Paused, ...) is likely but NOT confirmed identical. Treat this
// mapping as probable-not-proven until checked against a live Asterisk.
const DEVICE_STATUS_TO_AGENT_STATUS: Record<string, AgentStatus> = {
  "0": "OFFLINE", // AST_DEVICE_UNKNOWN
  "1": "AVAILABLE", // AST_DEVICE_NOT_INUSE
  "2": "BUSY", // AST_DEVICE_INUSE
  "3": "BUSY", // AST_DEVICE_BUSY
  "4": "OFFLINE", // AST_DEVICE_INVALID
  "5": "OFFLINE", // AST_DEVICE_UNAVAILABLE
  "6": "BUSY", // AST_DEVICE_RINGING
  "7": "BUSY", // AST_DEVICE_RINGINUSE
  "8": "BUSY", // AST_DEVICE_ONHOLD
};

export function mapQueueMemberStatus(status: string | undefined): AgentStatus {
  if (!status) return "OFFLINE";
  return DEVICE_STATUS_TO_AGENT_STATUS[status] ?? "OFFLINE";
}

/** "PJSIP/1001" -> "1001". Returns null if the interface doesn't look like
 * a PJSIP endpoint reference (e.g. a SIP or IAX2 tech we don't provision). */
export function extensionFromInterface(iface: string | undefined): string | null {
  if (!iface) return null;
  const match = /^PJSIP\/(\w+)/.exec(iface);
  return match ? match[1] : null;
}

interface QueueWithMembers {
  name: string;
  strategy: string;
  members: { extension: string }[];
}

/**
 * Live AMI QueueStatus snapshot for one or more queues — the single source
 * of truth for waiting/longestWaitSec/member status, shared by both
 * GET /api/queues and GET /api/wallboard so they can't drift apart. Before
 * this was extracted, the wallboard route hardcoded `waiting: 0`,
 * `longestWaitSec: 0`, and every member's status as `"AVAILABLE"` —
 * supervisors were making staffing decisions from invented numbers while
 * /api/queues, right next to it, computed the real thing from the exact
 * same AMI action. There is no reason for two implementations of this.
 */
export async function getQueueSnapshots(
  ami: AmiClient,
  queues: QueueWithMembers[]
): Promise<QueueSnapshot[]> {
  return Promise.all(
    queues.map(async (q): Promise<QueueSnapshot> => {
      try {
        const { events } = await ami.sendAndCollect(
          { Action: "QueueStatus", Queue: q.name },
          "QueueStatusComplete"
        );

        const entryEvents = events.filter((e) => e.Event === "QueueEntry");
        const memberEvents = events.filter((e) => e.Event === "QueueMember");

        const waiting = entryEvents.length;
        const longestWaitSec = entryEvents.reduce((max, e) => Math.max(max, Number(e.Wait ?? 0)), 0);

        const liveStatusByExtension = new Map(
          memberEvents
            .map((e) => [extensionFromInterface(e.Interface), mapQueueMemberStatus(e.Status)] as const)
            .filter((entry): entry is [string, AgentStatus] => entry[0] !== null)
        );

        return {
          name: q.name,
          strategy: q.strategy,
          waiting,
          longestWaitSec,
          members: q.members.map((m) => ({
            extension: m.extension,
            status: liveStatusByExtension.get(m.extension) ?? "OFFLINE",
          })),
        };
      } catch {
        // A single queue's AMI query failing (e.g. queue doesn't exist yet
        // on the Asterisk side) shouldn't take down the whole snapshot.
        return {
          name: q.name,
          strategy: q.strategy,
          waiting: 0,
          longestWaitSec: 0,
          members: q.members.map((m) => ({ extension: m.extension, status: "OFFLINE" as const })),
        };
      }
    })
  );
}
