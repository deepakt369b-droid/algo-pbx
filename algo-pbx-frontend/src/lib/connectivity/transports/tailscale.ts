import type { TransportModule } from "./types";

// Legacy path — unmonitored by design, matching the pre-registry
// behavior exactly (see the connectivity-check route's original
// comment: "not monitored by this poller at all — it has its own
// long-standing, separate reachability story via the Tailscale mesh
// itself"). `GatewaySite.status`/`lastHandshakeAt`/`lastReachableAt` are
// left untouched by the poller for TAILSCALE rows; this module's
// `probe()` always returns UNKNOWN with the site's own existing values
// carried through unchanged, never a fabricated UP/DOWN.
export const tailscaleTransport: TransportModule = {
  kind: "TAILSCALE",

  // No stored config blob for this transport — a Tailscale-transport
  // site authenticates via the host's own tailscaled daemon, not via
  // anything this app pushes or stores.
  validateConfig() {
    return { ok: true };
  },

  async probe(site) {
    return {
      status: "UNKNOWN",
      lastHandshakeAt: site.lastHandshakeAt,
      lastReachableAt: site.lastReachableAt,
      alertType: null,
    };
  },
};
