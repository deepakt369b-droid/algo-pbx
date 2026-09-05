import { describe, it, expect } from "vitest";
import { buildEasyRsaCommand, copyableCommandBlock, OPENVPN_CONTAINER } from "./manual-cert-command";
import { certCn } from "./subnet";

describe("buildEasyRsaCommand", () => {
  const cmd = buildEasyRsaCommand("cust-acme-gw-1");

  it("targets the real container name from docker-compose.yml", () => {
    expect(OPENVPN_CONTAINER).toBe("algo-openvpn-server");
    for (const c of cmd.commands) expect(c).toContain("algo-openvpn-server");
  });

  it("issues then exports, in that order", () => {
    expect(cmd.commands).toHaveLength(2);
    expect(cmd.commands[0]).toContain("easyrsa build-client-full cust-acme-gw-1 nopass");
    expect(cmd.commands[1]).toContain("ovpn_getclient cust-acme-gw-1 combined");
  });

  // The exact argument mix-up that was hit issuing the first real cert.
  it("uses `combined` for ovpn_getclient, never `nopass`", () => {
    expect(cmd.commands[1]).not.toMatch(/ovpn_getclient \S+ nopass/);
    expect(cmd.commands[1]).toMatch(/ovpn_getclient \S+ combined/);
  });

  it("keeps `nopass` on build-client-full, where it belongs", () => {
    expect(cmd.commands[0]).toMatch(/build-client-full \S+ nopass$/);
  });

  it("runs interactively, since both commands prompt", () => {
    for (const c of cmd.commands) expect(c).toContain("docker exec -it");
  });

  it("frames the gate as deliberate, not as a failure", () => {
    expect(cmd.intro).toMatch(/deliberately manual/);
    expect(cmd.intro).toMatch(/CA signing flow v2/);
  });

  it("names the artifact the wizard will check for", () => {
    expect(cmd.expectedArtifact).toBe("/etc/openvpn/pki/issued/cust-acme-gw-1.crt");
  });
});

describe("warnings reproduce the failure modes hit on the first real cert", () => {
  const { warnings } = buildEasyRsaCommand("cust-acme-gw-1");
  const all = warnings.join("\n");

  it("explains the CA passphrase prompt and that the client key is nopass", () => {
    expect(all).toMatch(/CA passphrase/);
    expect(all).toMatch(/Only the CA key is passphrase-protected/);
  });

  it("reassures that a bad decrypt is a typo, not a damaged CA", () => {
    expect(all).toMatch(/bad decrypt/);
    expect(all).toMatch(/not the CA key being damaged/);
  });

  it("gives the surgical sign-req recovery for a repeated attempt", () => {
    expect(all).toMatch(/Request file already exists/);
    expect(all).toMatch(/easyrsa sign-req client cust-acme-gw-1/);
    // Deleting the request is the tempting wrong move; the text says not to.
    expect(all).toMatch(/Do not delete them/);
  });

  it("calls out the nopass/combined argument confusion explicitly", () => {
    expect(all).toMatch(/`nopass` belongs to build-client-full/);
  });

  it("warns that a missing -it hangs with no output", () => {
    expect(all).toMatch(/-it is required/);
  });
});

describe("input safety", () => {
  it.each(["", "bad name", "x;rm -rf /", "a".repeat(65), "cn$(whoami)"])(
    "refuses to build a command for unsafe CN %j",
    (bad) => {
      // These strings are pasted into a root shell — a bad CN must never
      // reach the clipboard in the first place.
      expect(() => buildEasyRsaCommand(bad)).toThrow(/SAFE_NAME_RE|\^\[A-Za-z0-9_-\]/);
    }
  );

  it("accepts anything subnet.ts's certCn() produces from a valid slug", () => {
    expect(() => buildEasyRsaCommand(certCn("acme-corp"))).not.toThrow();
    expect(() => buildEasyRsaCommand(certCn("demo", 2))).not.toThrow();
  });
});

describe("copyableCommandBlock", () => {
  it("joins the commands one per line for the clipboard button", () => {
    expect(copyableCommandBlock("cust-acme-gw-1").split("\n")).toHaveLength(2);
  });

  it("matches the demo gateway's real historical CN", () => {
    expect(copyableCommandBlock("cust-demo-gw-1")).toContain("build-client-full cust-demo-gw-1 nopass");
  });
});
