import { describe, it, expect } from "vitest";
import { buildUserVpnConfig, vpnConfigFilename, supportsGeneratedConfig } from "./user-vpn-config";

// 44-char base64-looking key (42 'A's + one 'B' + '='), satisfying
// wireguard.ts's BASE64_KEY_RE without needing real key material.
const FAKE_KEY = "A".repeat(43) + "=";

const baseInput = {
  transport: "WIREGUARD" as const,
  userLabel: "Jane Doe",
  tunnelIp: "10.8.3.20",
  clientPrivateKey: FAKE_KEY,
  serverPublicKey: FAKE_KEY,
  serverEndpoint: "vpn.example.com:51820",
  allowedIps: "10.8.3.0/24",
};

describe("supportsGeneratedConfig", () => {
  it("supports WireGuard and Headscale", () => {
    expect(supportsGeneratedConfig("WIREGUARD")).toBe(true);
    expect(supportsGeneratedConfig("HEADSCALE")).toBe(true);
  });

  it("does not support Tailscale or OpenVPN", () => {
    expect(supportsGeneratedConfig("TAILSCALE")).toBe(false);
    expect(supportsGeneratedConfig("OPENVPN")).toBe(false);
  });
});

describe("buildUserVpnConfig", () => {
  it("builds a valid WireGuard client config that round-trips through the transport validator", () => {
    const result = buildUserVpnConfig(baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toContain("[Interface]");
      expect(result.config).toContain("[Peer]");
      expect(result.config).toContain(`Address = ${baseInput.tunnelIp}/32`);
      expect(result.config).toContain(`Endpoint = ${baseInput.serverEndpoint}`);
      expect(result.filename).toBe("jane-doe-wireguard.conf");
    }
  });

  it("rejects a malformed private key by producing a config the transport validator itself rejects", () => {
    const result = buildUserVpnConfig({ ...baseInput, serverPublicKey: "not-a-real-key" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/PublicKey/);
  });

  it("returns an honest failure for Tailscale — no generated config", () => {
    const result = buildUserVpnConfig({ ...baseInput, transport: "TAILSCALE" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no config this app can generate/);
  });

  it("returns an honest failure for OpenVPN — no generated config", () => {
    const result = buildUserVpnConfig({ ...baseInput, transport: "OPENVPN" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no config this app can generate/);
  });
});

describe("vpnConfigFilename", () => {
  it("sanitises a label with spaces and slashes", () => {
    expect(vpnConfigFilename("WIREGUARD", "Jane / Doe  Agent")).toBe("jane-doe-agent-wireguard.conf");
  });

  it("falls back to 'profile' for an empty label", () => {
    expect(vpnConfigFilename("WIREGUARD", "   ")).toBe("profile-wireguard.conf");
  });

  it("uses the .ovpn extension for OpenVPN", () => {
    expect(vpnConfigFilename("OPENVPN", "Jane")).toBe("jane-openvpn.ovpn");
  });
});
