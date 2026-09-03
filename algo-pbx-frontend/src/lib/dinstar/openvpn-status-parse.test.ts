import { describe, expect, it } from "vitest";
import { parseOpenVpnStatusLog, findClientByCommonName } from "./openvpn-status-parse";

const SAMPLE_LOG = `TITLE,OpenVPN 2.4.7 x86_64-alpine-linux-musl
TIME,2026-09-03 12:00:00,1788609600
HEADER,CLIENT_LIST,Common Name,Real Address,Virtual Address,Virtual IPv6 Address,Bytes Received,Bytes Sent,Connected Since,Connected Since (time_t),Username,Client ID,Peer ID
CLIENT_LIST,uae-office,203.0.113.5:54321,10.8.0.10,,123456,654321,Thu Sep  3 11:58:00 2026,1788609480,UNDEF,0,0
HEADER,ROUTING_TABLE,Virtual Address,Common Name,Real Address,Last Ref,Last Ref (time_t)
ROUTING_TABLE,10.8.0.10,uae-office,203.0.113.5:54321,Thu Sep  3 12:00:00 2026,1788609600
GLOBAL_STATS,Max bcast/mcast queue length,0
END
`;

describe("parseOpenVpnStatusLog", () => {
  it("extracts a connected client from a real-shaped status-version 2 log", () => {
    const clients = parseOpenVpnStatusLog(SAMPLE_LOG);
    expect(clients).toHaveLength(1);
    expect(clients[0].commonName).toBe("uae-office");
    expect(clients[0].virtualAddress).toBe("10.8.0.10");
    expect(clients[0].connectedSince.toISOString()).toBe(new Date(1788609480 * 1000).toISOString());
  });

  it("returns an empty array for empty input", () => {
    expect(parseOpenVpnStatusLog("")).toEqual([]);
  });

  it("returns an empty array when there are no CLIENT_LIST rows at all", () => {
    const noClients = `TITLE,OpenVPN 2.4.7\nTIME,2026-09-03 12:00:00,1788609600\nGLOBAL_STATS,Max bcast/mcast queue length,0\nEND\n`;
    expect(parseOpenVpnStatusLog(noClients)).toEqual([]);
  });

  it("skips a malformed CLIENT_LIST row missing its time_t column rather than throwing", () => {
    const malformed = `CLIENT_LIST,uae-office,203.0.113.5:1,10.8.0.10\n`;
    expect(() => parseOpenVpnStatusLog(malformed)).not.toThrow();
    expect(parseOpenVpnStatusLog(malformed)).toEqual([]);
  });

  it("handles multiple connected clients", () => {
    const twoClients =
      SAMPLE_LOG.trimEnd() + `\nCLIENT_LIST,second-site,198.51.100.9:1,10.8.0.20,,1,1,x,1788609500,UNDEF,0,0\n`;
    const clients = parseOpenVpnStatusLog(twoClients);
    expect(clients.map((c) => c.commonName).sort()).toEqual(["second-site", "uae-office"]);
  });
});

describe("findClientByCommonName", () => {
  it("finds an existing client", () => {
    const clients = parseOpenVpnStatusLog(SAMPLE_LOG);
    expect(findClientByCommonName(clients, "uae-office")).toBeDefined();
  });

  it("returns undefined for a CN not currently connected", () => {
    const clients = parseOpenVpnStatusLog(SAMPLE_LOG);
    expect(findClientByCommonName(clients, "some-other-site")).toBeUndefined();
  });
});
