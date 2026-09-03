import { describe, expect, it } from "vitest";
import { buildMultipartBody } from "./device-client";

describe("buildMultipartBody", () => {
  it("produces a body whose parts are all delimited by the given boundary", () => {
    const body = buildMultipartBody(
      { VPNType: "0", OpenVPNEnable: "on" },
      { fieldName: "opvn", filename: "site.ovpn", content: Buffer.from("dummy-ovpn-content") },
      "BOUNDARY123"
    );
    const text = body.toString("utf8");
    expect(text).toContain("--BOUNDARY123\r\n");
    expect(text).toContain("--BOUNDARY123--\r\n");
    // Every part (2 plain fields + 1 file part) opens with its own
    // boundary line, plus the closing terminator uses "--BOUNDARY123--".
    expect(text.match(/--BOUNDARY123\r\n/g)?.length).toBe(3); // VPNType, OpenVPNEnable, opvn file part
  });

  it("includes a Content-Disposition part for every plain field, in insertion order", () => {
    const body = buildMultipartBody(
      { VPNType: "0", OpenVPNEnable: "on", VPNUsername: "", VPNPassword: "", ok: "Save" },
      { fieldName: "opvn", filename: "site.ovpn", content: Buffer.from("x") },
      "B1"
    );
    const text = body.toString("utf8");
    const order = ["VPNType", "OpenVPNEnable", "VPNUsername", "VPNPassword", "ok", "opvn"];
    let lastIndex = -1;
    for (const name of order) {
      const idx = text.indexOf(`name="${name}"`);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it("includes the file part with filename and a binary-safe Content-Type", () => {
    const body = buildMultipartBody({}, { fieldName: "opvn", filename: "uae-office.ovpn", content: Buffer.from("cert-bytes") }, "B2");
    const text = body.toString("latin1");
    expect(text).toContain('name="opvn"; filename="uae-office.ovpn"');
    expect(text).toContain("Content-Type: application/octet-stream");
  });

  it("embeds the file content verbatim, including bytes that aren't valid UTF-8 text", () => {
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0xab, 0xcd]);
    const body = buildMultipartBody({}, { fieldName: "opvn", filename: "x.ovpn", content: binary }, "B3");
    // The exact byte sequence must appear unmodified somewhere in the body.
    expect(body.includes(binary)).toBe(true);
  });

  it("handles a realistically large file part without truncation", () => {
    const large = Buffer.alloc(64 * 1024, 0x41); // 64KB of 'A' — a real .ovpn with embedded PEM cert/key is a few KB
    const body = buildMultipartBody({ VPNType: "0" }, { fieldName: "opvn", filename: "big.ovpn", content: large }, "B4");
    expect(body.length).toBeGreaterThanOrEqual(large.length);
    expect(body.includes(large)).toBe(true);
  });

  it("field values containing quotes/ampersands don't break the part structure", () => {
    // These values are only ever operator-configured settings, not raw
    // end-user input (see the function's own header comment) — this test
    // just confirms the multipart framing itself stays well-formed even
    // if a value contains characters that would matter in other encodings.
    const body = buildMultipartBody(
      { VPNUsername: `weird"value&here` },
      { fieldName: "opvn", filename: "x.ovpn", content: Buffer.from("y") },
      "B5"
    );
    const text = body.toString("utf8");
    expect(text).toContain(`weird"value&here`);
    expect(text).toContain("--B5--\r\n");
  });
});
