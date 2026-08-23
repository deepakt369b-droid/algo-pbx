import { describe, expect, it } from "vitest";
import { findChannelsToRedirect } from "./conference-orchestration";

describe("findChannelsToRedirect", () => {
  it("returns the agent's channel plus its bridged peer when a BridgeId is shared", () => {
    const channels = [
      { channel: "PJSIP/1001-00000001", bridgeId: "bridge-a" },
      { channel: "PJSIP/dinstar-trunk-00000002", bridgeId: "bridge-a" },
      { channel: "PJSIP/1002-00000003", bridgeId: "bridge-b" },
    ];
    expect(findChannelsToRedirect(channels, "1001")).toEqual([
      "PJSIP/1001-00000001",
      "PJSIP/dinstar-trunk-00000002",
    ]);
  });

  it("returns only the agent's own channel when it has no BridgeId (degraded case)", () => {
    const channels = [{ channel: "PJSIP/1001-00000001", bridgeId: undefined }];
    expect(findChannelsToRedirect(channels, "1001")).toEqual(["PJSIP/1001-00000001"]);
  });

  it("returns an empty array when the agent has no active channel at all", () => {
    const channels = [{ channel: "PJSIP/1002-00000003", bridgeId: "bridge-b" }];
    expect(findChannelsToRedirect(channels, "1001")).toEqual([]);
  });

  it("does not include unrelated channels sharing no BridgeId", () => {
    const channels = [
      { channel: "PJSIP/1001-00000001", bridgeId: "bridge-a" },
      { channel: "PJSIP/1003-00000009", bridgeId: "bridge-c" },
    ];
    expect(findChannelsToRedirect(channels, "1001")).toEqual(["PJSIP/1001-00000001"]);
  });
});
