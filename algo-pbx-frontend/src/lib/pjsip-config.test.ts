import { describe, expect, it } from "vitest";
import { renderPjsipConf } from "./pjsip-config";

describe("renderPjsipConf", () => {
  it("renders a webrtc extension matching the hand-written template shape", () => {
    const output = renderPjsipConf([{ number: "1002", kind: "webrtc", sipSecret: "s3cr3t" , dialPermission: "LOCAL" }]);

    expect(output).toContain("[1002]");
    expect(output).toContain("type=endpoint");
    expect(output).toContain("transport=transport-wss");
    expect(output).toContain("context=from-agent");
    expect(output).toContain("disallow=all");
    // alaw is listed first deliberately: the far end of every call is
    // either another 8kHz endpoint or the alaw-only Dinstar trunk, so
    // preferring opus bought no perceived quality while forcing
    // transcoding (added latency + CPU) on every call. See the generator's
    // comment above renderWebrtcStanza.
    expect(output).toContain("allow=alaw,ulaw,opus");
    expect(output).toContain("rewrite_contact=yes");
    expect(output).toContain("rtp_symmetric=yes");
    expect(output).toContain("direct_media=no");
    expect(output).toContain("webrtc=yes");
    expect(output).toContain("use_avpf=yes");
    expect(output).toContain("media_encryption=dtls");
    expect(output).toContain("dtls_verify=fingerprint");
    expect(output).toContain("dtls_cert_file=/etc/asterisk/keys/asterisk.crt");
    expect(output).toContain("dtls_private_key=/etc/asterisk/keys/asterisk.key");
    expect(output).toContain("dtls_setup=actpass");
    expect(output).toContain("ice_support=yes");
    expect(output).toContain("media_use_received_transport=yes");
    // Pinned explicitly rather than left to PJSIP's implicit default —
    // see the generator's comment for why that coincidence (implicit
    // default == musiconhold.conf's only class name) was worth naming.
    expect(output).toContain("moh_suggest=default");
    expect(output).toContain("auth=1002");
    expect(output).toContain("aors=1002");

    expect(output).toContain("[1002]");
    expect(output).toContain("type=auth");
    expect(output).toContain("auth_type=userpass");
    expect(output).toContain("username=1002");
    expect(output).toContain("password=s3cr3t");

    expect(output).toContain("[1002]");
    expect(output).toContain("type=aor");
    expect(output).toContain("max_contacts=2");
    expect(output).toContain("remove_existing=yes");
    // Added 2026-08-29: without this, Asterisk never health-checks a WebRTC
    // contact (confirmed live — every contact showed "NonQual" in
    // `pjsip show aor`), so a dead browser tab leaves a permanent zombie
    // contact that later calls still fork to.
    expect(output).toContain("qualify_frequency=30");
  });

  it("renders a hardware extension matching the hand-written template shape", () => {
    const output = renderPjsipConf([{ number: "2002", kind: "hardware", sipSecret: "hw-secret" , dialPermission: "LOCAL" }]);

    expect(output).toContain("[2002]");
    expect(output).toContain("type=endpoint");
    expect(output).toContain("transport=transport-udp");
    // "from-internal" was never defined in extensions.conf — hardware
    // endpoints now share from-agent's context with WebRTC endpoints.
    expect(output).toContain("context=from-agent");
    expect(output).toContain("disallow=all");
    expect(output).toContain("allow=alaw,ulaw");
    expect(output).toContain("moh_suggest=default");
    expect(output).toContain("auth=2002");
    expect(output).toContain("aors=2002");

    expect(output).toContain("[2002]");
    expect(output).toContain("username=2002");
    expect(output).toContain("password=hw-secret");

    expect(output).toContain("[2002]");
    expect(output).toContain("max_contacts=1");

    // Hardware phones must NOT get WebRTC/DTLS fields — those only make
    // sense for the wss/webrtc transport.
    expect(output).not.toContain("webrtc=yes");
    expect(output).not.toContain("media_encryption=dtls");
  });

  it("renders multiple extensions as independent, non-bleeding blocks in order", () => {
    const output = renderPjsipConf([
      { number: "1002", kind: "webrtc", sipSecret: "secret-a" , dialPermission: "LOCAL" },
      { number: "2002", kind: "hardware", sipSecret: "secret-b" , dialPermission: "LOCAL" },
    ]);

    const indexOf1002 = output.indexOf("[1002]");
    const indexOf2002 = output.indexOf("[2002]");
    expect(indexOf1002).toBeGreaterThanOrEqual(0);
    expect(indexOf2002).toBeGreaterThan(indexOf1002);

    // Each extension's own secret appears, and only in its own block —
    // secret-a must not leak into the 2002 stanza's password line and
    // vice versa.
    expect(output).toContain("password=secret-a");
    expect(output).toContain("password=secret-b");
    const section2002 = output.slice(indexOf2002);
    expect(section2002).not.toContain("secret-a");
  });

  it("renders an empty array as an empty (or whitespace-only) string", () => {
    const output = renderPjsipConf([]);
    // Still allowed to contain the banner comment, just no stanzas.
    expect(output).not.toContain("[");
    expect(output).not.toContain("type=endpoint");
  });

  it("wraps the output with a DO NOT HAND-EDIT banner", () => {
    const output = renderPjsipConf([{ number: "1002", kind: "webrtc", sipSecret: "s" , dialPermission: "LOCAL" }]);
    expect(output).toMatch(/generated file/i);
    expect(output).toMatch(/do not hand-edit/i);
    expect(output).toContain("src/lib/pjsip-config.ts");
  });

  it("throws if a number contains characters that could inject a new stanza", () => {
    expect(() =>
      renderPjsipConf([{ number: "1002]\n[injected", kind: "webrtc", sipSecret: "s" , dialPermission: "LOCAL" }])
    ).toThrow();
  });

  it("picks the outbound context matching each extension's dialPermission (Loop C2)", () => {
    const local = renderPjsipConf([{ number: "1001", kind: "webrtc", sipSecret: "s", dialPermission: "LOCAL" }]);
    expect(local).toContain("context=from-agent-local");

    const national = renderPjsipConf([{ number: "1002", kind: "webrtc", sipSecret: "s", dialPermission: "NATIONAL" }]);
    expect(national).toContain("context=from-agent-national");
    expect(national).not.toContain("context=from-agent-local\n");

    const international = renderPjsipConf([{ number: "1003", kind: "hardware", sipSecret: "s", dialPermission: "INTERNATIONAL" }]);
    expect(international).toContain("context=from-agent-international");
  });

  it("throws if a sipSecret contains a newline or bracket", () => {
    expect(() =>
      renderPjsipConf([{ number: "1002", kind: "webrtc", sipSecret: "s\ninjected=yes" , dialPermission: "LOCAL" }])
    ).toThrow();
    expect(() =>
      renderPjsipConf([{ number: "1002", kind: "webrtc", sipSecret: "s]\n[1003]" , dialPermission: "LOCAL" }])
    ).toThrow();
  });
});
