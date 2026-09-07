import net from "node:net";
import { parseOpenVpnStatusLog, findClientByCommonName } from "@/lib/dinstar/openvpn-status-parse";
import { classifySiteAlert, isValidIPv4 } from "@/lib/dinstar/gateway-alerts";
import type { ProbeContext, TransportModule } from "./types";

// Lifted unchanged in behavior from the pre-registry `checkSite()`
// switch's OPENVPN branch and the connectivity-check route's own
// `tcpProbe()` — this is a move, not a rewrite. See git history on
// src/app/api/admin/gateway-sites/connectivity-check/route.ts for the
// pre-refactor version if a byte-for-byte diff is ever needed.

// TCP-connect reachability probe — deliberately NOT a shelled-out ICMP
// `ping`. Two real, verified-during-build reasons: (1) the `web` image
// (node:20-alpine, see algo-pbx-frontend/Dockerfile's `runner` stage) has
// no `ping` binary and no iputils package installed; (2) even with the
// binary present, ICMP sockets typically require root or CAP_NET_RAW
// inside a container, which this service deliberately doesn't have. An
// in-process TCP connect-and-close needs neither — matches the plan's own
// "ping + TCP:80 probe" wording via the TCP half, which is sufficient
// proof of reachability (the Dinstar's admin UI serves plain HTTP on 80
// only to 302-redirect to HTTPS — see device-client.ts's own comment — so
// even a redirect response, or just a successful SYN-ACK, confirms the
// device is live at this address). Exported (not just used internally) so
// wireguard.ts can reuse the exact same reachability primitive rather
// than a second, subtly-different copy.
export function tcpProbe(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export const openvpnTransport: TransportModule = {
  kind: "OPENVPN",

  // No stored config blob for this transport — an OPENVPN-transport
  // site's client config is generated/managed via the OpenVPN bridge's
  // own PKI (generate-cert / push-vpn-config routes), never via
  // `GatewaySite.configEncrypted`.
  validateConfig() {
    return { ok: true };
  },

  async probe(site, ctx: ProbeContext) {
    const clients = ctx.statusLogContent ? parseOpenVpnStatusLog(ctx.statusLogContent) : [];
    const match = findClientByCommonName(clients, site.name);
    const lastHandshakeAt = match?.connectedSince ?? site.lastHandshakeAt;

    let pingOk: boolean | null = null;
    if (site.tunnelIp && isValidIPv4(site.tunnelIp)) {
      pingOk = await tcpProbe(site.tunnelIp, 80);
    }

    const alertType = classifySiteAlert({
      transport: "OPENVPN",
      connectedInStatusSource: Boolean(match),
      lastHandshakeAt,
      pingOk,
      now: ctx.now,
    });

    return {
      status: alertType === "vpn.handshake_stale" ? "DEGRADED" : alertType === "vpn.tunnel_unreachable" ? "DOWN" : "UP",
      lastHandshakeAt,
      lastReachableAt: pingOk ? ctx.now : site.lastReachableAt,
      alertType,
    };
  },
};
