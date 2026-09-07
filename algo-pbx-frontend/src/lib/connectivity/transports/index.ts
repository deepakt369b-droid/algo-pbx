import type { SiteTransport } from "@prisma/client";
import { tailscaleTransport } from "./tailscale";
import { openvpnTransport } from "./openvpn";
import { headscaleTransport } from "./headscale";
import { wireguardTransport } from "./wireguard";
import type { TransportModule } from "./types";

// The registry the connectivity-check route's `checkSite()` dispatches
// through — a fifth transport is a new file plus one line here, not a
// patch to a growing `switch`.
export const transports: Record<SiteTransport, TransportModule> = {
  TAILSCALE: tailscaleTransport,
  OPENVPN: openvpnTransport,
  HEADSCALE: headscaleTransport,
  WIREGUARD: wireguardTransport,
};

export type { ProbeContext, ProbeResult, TransportModule } from "./types";
