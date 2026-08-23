import { describe, expect, it, vi } from "vitest";
import { extensionFromInterface, getQueueSnapshots, mapQueueMemberStatus } from "./queue-status";
import type { AmiClient } from "@/lib/ami-client";

describe("mapQueueMemberStatus", () => {
  it("maps NOT_INUSE (1) to AVAILABLE", () => {
    expect(mapQueueMemberStatus("1")).toBe("AVAILABLE");
  });

  it("maps INUSE, BUSY, RINGING, RINGINUSE, and ONHOLD to BUSY", () => {
    for (const code of ["2", "3", "6", "7", "8"]) {
      expect(mapQueueMemberStatus(code)).toBe("BUSY");
    }
  });

  it("maps UNKNOWN, INVALID, and UNAVAILABLE to OFFLINE", () => {
    for (const code of ["0", "4", "5"]) {
      expect(mapQueueMemberStatus(code)).toBe("OFFLINE");
    }
  });

  it("defaults to OFFLINE for an unrecognized or missing status", () => {
    expect(mapQueueMemberStatus("99")).toBe("OFFLINE");
    expect(mapQueueMemberStatus(undefined)).toBe("OFFLINE");
  });
});

describe("extensionFromInterface", () => {
  it("extracts the extension number from a PJSIP interface", () => {
    expect(extensionFromInterface("PJSIP/1001")).toBe("1001");
  });

  it("returns null for a non-PJSIP interface", () => {
    expect(extensionFromInterface("SIP/2001")).toBeNull();
  });

  it("returns null when the interface is missing", () => {
    expect(extensionFromInterface(undefined)).toBeNull();
  });
});

describe("getQueueSnapshots", () => {
  // Regression test for the specific bug this function was extracted to
  // fix: GET /api/wallboard used to hardcode waiting=0/longestWaitSec=0/
  // every member AVAILABLE regardless of what AMI actually reported,
  // while GET /api/queues computed the real thing from this identical
  // AMI action right next to it. Both routes now call this one function.
  it("computes real waiting count, longest wait, and per-member status from AMI events", async () => {
    const fakeAmi = {
      sendAndCollect: vi.fn().mockResolvedValue({
        response: { Response: "Success" },
        events: [
          { Event: "QueueEntry", Wait: "12" },
          { Event: "QueueEntry", Wait: "45" },
          { Event: "QueueMember", Interface: "PJSIP/1001", Status: "1" }, // AVAILABLE
          { Event: "QueueMember", Interface: "PJSIP/1002", Status: "2" }, // BUSY
          { Event: "QueueStatusComplete" },
        ],
      }),
    } as unknown as AmiClient;

    const result = await getQueueSnapshots(fakeAmi, [
      { name: "support_queue", strategy: "ringall", members: [{ extension: "1001" }, { extension: "1002" }, { extension: "1003" }] },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].waiting).toBe(2);
    expect(result[0].longestWaitSec).toBe(45);
    expect(result[0].members).toEqual([
      { extension: "1001", status: "AVAILABLE" },
      { extension: "1002", status: "BUSY" },
      // A configured member AMI didn't report on falls back to OFFLINE,
      // not to a fabricated "AVAILABLE" the way the old wallboard route did.
      { extension: "1003", status: "OFFLINE" },
    ]);
  });

  it("degrades one queue to a zeroed-out OFFLINE snapshot on AMI error without failing the whole batch", async () => {
    const fakeAmi = {
      sendAndCollect: vi.fn().mockRejectedValue(new Error("AMI timeout")),
    } as unknown as AmiClient;

    const result = await getQueueSnapshots(fakeAmi, [
      { name: "broken_queue", strategy: "ringall", members: [{ extension: "1001" }] },
    ]);

    expect(result[0].waiting).toBe(0);
    expect(result[0].members[0].status).toBe("OFFLINE");
  });
});
