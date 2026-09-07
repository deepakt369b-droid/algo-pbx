import { isValidIPv4 } from "@/lib/dinstar/gateway-alerts";
import { tcpProbe } from "./openvpn";
import type { ProbeContext, TransportModule } from "./types";

// New transport (W2 — connectivity plan §3.2, the only genuinely new
// transport this wave adds; the enum value itself landed in G0's schema
// pass). `GatewaySite.configEncrypted` holds the WireGuard *client*
// config text (a standard `wg-quick`-style `.conf`) at rest via the
// existing `encryptSetting`/`decryptSetting` helpers
// (src/lib/settings/crypto.ts) — the same AES-256-GCM scheme every other
// stored secret in this app already uses, not a new one invented here.

const SECTION_RE = {
  interface: /^\s*\[Interface\]\s*$/im,
  peer: /^\s*\[Peer\]\s*$/im,
};

// A WireGuard key is 32 raw bytes, base64-encoded — that's always 44
// characters, always ending in `=`. Loose enough to accept any valid key
// without re-deriving the exact base64 alphabet rules; strict enough to
// reject "PublicKey = " with nothing after it or an obviously truncated
// paste.
const BASE64_KEY_RE = /^[A-Za-z0-9+/]{42,43}=$/;

function extractField(config: string, field: string): string | null {
  const match = config.match(new RegExp(`^\\s*${field}\\s*=\\s*(.+)$`, "im"));
  return match ? match[1].trim() : null;
}

export const wireguardTransport: TransportModule = {
  kind: "WIREGUARD",

  /** Structural validation only — this cannot and does not confirm the
   * key material actually corresponds to a live peer, only that the
   * pasted text has the shape of a real `wg-quick` client config: both
   * required sections present, and a syntactically plausible
   * `PublicKey` under `[Peer]`. Real reachability is `probe()`'s job,
   * and even that (see below) cannot verify a real WireGuard handshake
   * from here. */
  validateConfig(config: unknown): { ok: boolean; error?: string } {
    if (typeof config !== "string" || config.trim().length === 0) {
      return { ok: false, error: "WireGuard config must be non-empty text (a wg-quick-style client config)." };
    }
    if (!SECTION_RE.interface.test(config)) {
      return { ok: false, error: "Missing [Interface] section." };
    }
    if (!SECTION_RE.peer.test(config)) {
      return { ok: false, error: "Missing [Peer] section." };
    }
    const publicKey = extractField(config, "PublicKey");
    if (!publicKey || !BASE64_KEY_RE.test(publicKey)) {
      return { ok: false, error: "Missing or malformed PublicKey under [Peer] — expected a 44-character base64 WireGuard key." };
    }
    return { ok: true };
  },

  /** IMPORTANT, STATED PLAINLY (matching this repo's honesty convention —
   * see `vpn-push.ts`'s `verifiedByPing: null` and the pre-registry
   * `checkHeadscaleNodeOnline()` comment this whole registry replaces):
   * there is no real WireGuard handshake introspection available from
   * here. `web` has no `wg`/`wg-quick` binary, no `CAP_NET_ADMIN`, and no
   * kernel WireGuard interface of its own to inspect a peer's last
   * handshake time against (the one genuine signal a real `wg show`
   * would give). This probe can only do what OpenVPN's own probe does
   * for its ping half — an in-process TCP connect-and-close against the
   * tunnel IP on port 80 — which proves *something* is reachable at that
   * address, not that the WireGuard tunnel itself is up (a host could
   * answer on 80 over its LAN address, or the tunnel could be up but the
   * gateway's own web server down). Treat `UP` from this transport as
   * "the tunnel IP is reachable," never as "the WireGuard handshake was
   * confirmed." */
  async probe(site, ctx: ProbeContext) {
    let pingOk: boolean | null = null;
    if (site.tunnelIp && isValidIPv4(site.tunnelIp)) {
      pingOk = await tcpProbe(site.tunnelIp, 80, 2000);
    }

    if (pingOk === null) {
      return {
        status: "UNKNOWN",
        lastHandshakeAt: site.lastHandshakeAt,
        lastReachableAt: site.lastReachableAt,
        alertType: null,
        note: "No tunnel IP assigned yet — nothing to probe.",
      };
    }

    // Reuses the OPENVPN taxonomy's "vpn.tunnel_unreachable" type rather
    // than inventing a WIREGUARD-specific one — the connectivity-check
    // route's alerting/email/audit-log plumbing (maybeSendAlert,
    // `SiteCriticalAlertType`) is already transport-agnostic about that
    // string, and a sixth near-identical alert type would only fragment
    // the taxonomy for no operational benefit. Deliberately NOT run
    // through `classifySiteAlert()` — that function's "handshake_stale
    // vs. tunnel_unreachable" distinction is OpenVPN-status-log-specific
    // (it means something different there: "haven't seen this CN
    // reconnect in 3 minutes") and doesn't apply to a transport whose
    // only signal is a single TCP probe with no separate handshake
    // concept — reusing it here would mislabel a plain unreachable
    // tunnel as a stale handshake.
    const alertType = pingOk ? null : ("vpn.tunnel_unreachable" as const);

    return {
      status: pingOk ? "UP" : "DOWN",
      lastHandshakeAt: pingOk ? ctx.now : site.lastHandshakeAt,
      lastReachableAt: pingOk ? ctx.now : site.lastReachableAt,
      alertType,
      note: "Reachability only (TCP:80 connect) — this deployment has no way to confirm a real WireGuard handshake from the `web` container.",
    };
  },
};
