import type { SiteTransport } from "@prisma/client";
import { transports } from "@/lib/connectivity/transports";

// Per-user VPN client config generation (owner-page enchanted-sphinx plan,
// W3). Emits the config text; never throws — every failure mode is a
// `{ok:false, error}` return, matching this repo's existing convention (see
// transports/wireguard.ts's own validateConfig()).
//
// The generated WireGuard text is self-validated through
// `transports.WIREGUARD.validateConfig()` before being returned — the exact
// same structural check `GatewaySite.configEncrypted` is held to — so this
// generator can never hand out a config the rest of the app's own validator
// would reject.

export interface UserVpnProfileInput {
  transport: SiteTransport;
  userLabel: string;
  tunnelIp: string;
  clientPrivateKey: string;
  serverPublicKey: string;
  /** "host:port", e.g. the tenant's OpenVPN/WireGuard bridge address. */
  serverEndpoint: string;
  /** CIDR(s) routed through the tunnel, e.g. "10.8.3.0/24". */
  allowedIps: string;
  dns?: string;
  presharedKey?: string;
}

export type BuildVpnConfigResult =
  | { ok: true; config: string; filename: string }
  | { ok: false; error: string };

/**
 * Whether this transport has a config this app can generate and hand to a
 * user directly. TAILSCALE and OPENVPN do not: Tailscale authenticates via
 * its own daemon/auth key flow, and this app's OpenVPN config lives in the
 * bridge's own PKI (see src/lib/platform/manual-cert-command.ts) — neither
 * has a client config this function can honestly construct from a
 * UserVpnProfile row alone. Stated plainly rather than emitting a config
 * that only looks plausible, matching the repo's existing honesty
 * convention (see wireguard.ts's own probe() comment).
 */
export function supportsGeneratedConfig(transport: SiteTransport): boolean {
  return transport === "WIREGUARD" || transport === "HEADSCALE";
}

export function vpnConfigFilename(transport: SiteTransport, label: string): string {
  const safe = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "profile";
  const ext = transport === "OPENVPN" ? "ovpn" : "conf";
  return `${safe}-${transport.toLowerCase()}.${ext}`;
}

function buildWireguardLikeConfig(input: UserVpnProfileInput): string {
  const lines = [
    "[Interface]",
    `# ${input.userLabel}`,
    `PrivateKey = ${input.clientPrivateKey}`,
    `Address = ${input.tunnelIp}/32`,
  ];
  if (input.dns) lines.push(`DNS = ${input.dns}`);
  lines.push("", "[Peer]");
  lines.push(`PublicKey = ${input.serverPublicKey}`);
  if (input.presharedKey) lines.push(`PresharedKey = ${input.presharedKey}`);
  lines.push(`Endpoint = ${input.serverEndpoint}`);
  lines.push(`AllowedIPs = ${input.allowedIps}`);
  lines.push("PersistentKeepalive = 25");
  return lines.join("\n") + "\n";
}

export function buildUserVpnConfig(input: UserVpnProfileInput): BuildVpnConfigResult {
  if (!supportsGeneratedConfig(input.transport)) {
    return {
      ok: false,
      error: `${input.transport} has no config this app can generate — it is issued through that transport's own flow (see supportsGeneratedConfig()'s doc comment).`,
    };
  }

  const config = buildWireguardLikeConfig(input);

  // Self-validate through the SAME check GatewaySite.configEncrypted is
  // held to, so this function can never emit something the rest of the app
  // would reject as malformed.
  const verdict = transports.WIREGUARD.validateConfig(config);
  if (!verdict.ok) {
    return { ok: false, error: verdict.error ?? "Generated config failed validation." };
  }

  return { ok: true, config, filename: vpnConfigFilename(input.transport, input.userLabel) };
}
