// Parses OpenVPN's status-version 2 log format (comma-separated,
// documented at https://openvpn.net/community-resources/reference-manual-for-openvpn-2-4/
// under --status-version) — the exact format `pbx_configs/openvpn/init-pki.sh`
// configures via `status-version 2`. Pure, no I/O — the connectivity-check
// route (OpenVPN/Headscale/connectivity task, Node F) reads the file itself
// and passes its contents here. No dependency on a real OpenVPN server
// having ever run — testable against a hand-written fixture string.
//
// A CLIENT_LIST row's shape (0-indexed after the "CLIENT_LIST" tag):
//   1  Common Name
//   2  Real Address (peer's actual source ip:port)
//   3  Virtual Address (the tunnel IP OpenVPN assigned/pushed)
//   4  Virtual IPv6 Address
//   5  Bytes Received
//   6  Bytes Sent
//   7  Connected Since (human-readable)
//   8  Connected Since (time_t) — what this parser actually uses; the
//      human-readable column's format varies by server locale/timezone,
//      the unix timestamp column does not.
// Later columns (Username, Client ID, Peer ID, Data Channel Cipher) exist
// in some server versions and are ignored here — this parser only needs
// column 1 (CN) and column 8 (time_t).

export interface ConnectedClient {
  commonName: string;
  connectedSince: Date;
  virtualAddress: string | null;
}

/** Every currently-listed client in a status-version 2 log. Returns an
 * empty array for empty/malformed input rather than throwing — a status
 * log that doesn't parse cleanly (server not yet started, mid-write,
 * unexpected format) should read as "no data," never crash the poller. */
export function parseOpenVpnStatusLog(content: string): ConnectedClient[] {
  const clients: ConnectedClient[] = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith("CLIENT_LIST,")) continue;
    const cols = line.split(",");
    // Index 0 is the "CLIENT_LIST" tag itself.
    const commonName = cols[1]?.trim();
    const virtualAddress = cols[3]?.trim() || null;
    const timeT = cols[8]?.trim();
    if (!commonName || !timeT) continue;
    const epochSeconds = Number(timeT);
    if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) continue;
    clients.push({ commonName, connectedSince: new Date(epochSeconds * 1000), virtualAddress });
  }
  return clients;
}

/** Look up one site's connection by its Common Name (== GatewaySite.name).
 * `undefined` when that CN isn't currently listed as connected at all. */
export function findClientByCommonName(clients: ConnectedClient[], commonName: string): ConnectedClient | undefined {
  return clients.find((c) => c.commonName === commonName);
}
