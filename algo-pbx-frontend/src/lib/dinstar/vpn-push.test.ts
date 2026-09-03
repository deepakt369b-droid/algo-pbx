import { describe, expect, it } from "vitest";
import { isOpenVpnEnabledInHtml } from "./vpn-push";

// Realistic fragments of the live-confirmed enVPNCfg.htm page (see
// vpn-push.ts's header) — not the full page, just the one input this
// function cares about, in both states.
const CHECKED_FRAGMENT = `
<tr><td>OpenVPN Enable</td><td><input type="checkbox" name="OpenVPNEnable" id="OpenVPNEnable" checked></td></tr>
`;
const UNCHECKED_FRAGMENT = `
<tr><td>OpenVPN Enable</td><td><input type="checkbox" name="OpenVPNEnable" id="OpenVPNEnable"></td></tr>
`;

describe("isOpenVpnEnabledInHtml", () => {
  it("is true when the checkbox is checked", () => {
    expect(isOpenVpnEnabledInHtml(CHECKED_FRAGMENT)).toBe(true);
  });

  it("is false when the checkbox is present but unchecked", () => {
    expect(isOpenVpnEnabledInHtml(UNCHECKED_FRAGMENT)).toBe(false);
  });

  it("is false when the field is missing entirely (e.g. a login page)", () => {
    expect(isOpenVpnEnabledInHtml("<html><body>Please log in</body></html>")).toBe(false);
  });

  it("is false for empty input", () => {
    expect(isOpenVpnEnabledInHtml("")).toBe(false);
  });

  it("does not false-positive on 'checked' appearing elsewhere on the page", () => {
    const html = `<p>Status: checked</p><input type="checkbox" name="OpenVPNEnable">`;
    expect(isOpenVpnEnabledInHtml(html)).toBe(false);
  });

  it("handles single-quoted attribute syntax too", () => {
    const html = `<input type='checkbox' name='OpenVPNEnable' checked>`;
    expect(isOpenVpnEnabledInHtml(html)).toBe(true);
  });
});
