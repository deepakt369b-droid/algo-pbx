// Orchestrates pushing an OpenVPN client config (.ovpn) to the Dinstar
// gateway's own admin UI (Network Configuration -> VPN Parameter), for the
// OpenVPN-primary/Headscale-fallback/Tailscale-legacy migration (task graph
// Node D). Confirmed live this session: the form is
// POST https://<host>/goform/VPNCfg, multipart/form-data, fields
// VPNType=0 (OpenVPN — the device's only VPN type), OpenVPNEnable=on,
// opvn=<file>, VPNUsername/VPNPassword, submit name="ok" value="Save".
//
// Unlike the SIM-port page (device-client.ts's own documented gap: no
// reliable read-back), THIS page is static HTML with live values embedded
// in the DOM — so after the push we re-GET the same page and check whether
// OpenVPnEnable's checkbox actually rendered as checked, rather than
// trusting the POST's 200/redirect alone. That re-GET is the genuine
// verification step the plan requires ("form-200 is not proof").
import { loginToDevice, postMultipart, getPage } from "./device-client";
import { getSetting } from "@/lib/settings/service";
import { db } from "@/lib/db";

export interface VpnPushResult {
  loggedIn: boolean;
  pushed: boolean;
  verifiedByReadback: boolean;
  /** Left for the caller (G2's live session) to fill in via a real ping —
   * this module only talks to the gateway's web UI, it has no network
   * path of its own to the tunnel IP to test reachability. */
  verifiedByPing: null;
  error?: string;
}

const VPN_CFG_PATH = "/goform/VPNCfg";
const VPN_PAGE_PATH = "/enVPNCfg.htm";

/** True if the re-fetched VPN Parameter page's raw HTML shows the
 * OpenVPNEnable checkbox as checked. Confirmed live: the page embeds
 * `<input type="checkbox" name="OpenVPNEnable" ... checked>` when enabled —
 * a plain substring/regex check is enough for this one boolean, no HTML
 * parser dependency needed. */
export function isOpenVpnEnabledInHtml(html: string): boolean {
  const match = html.match(/<input[^>]*name=["']OpenVPNEnable["'][^>]*>/i);
  if (!match) return false;
  return /\bchecked\b/i.test(match[0]);
}

async function auditPush(
  actorId: string,
  siteId: string,
  host: string,
  result: VpnPushResult
): Promise<void> {
  await db.auditLog.create({
    data: {
      action: "site.vpn_config_pushed",
      actorId,
      targetId: siteId,
      metadata: { host, ...result },
    },
  });
}

/** Pushes `ovpnFile` to the gateway at `host` and verifies via read-back.
 * Credentials come from the existing DINSTAR_WEBUI_USERNAME/PASSWORD
 * settings (already the exact pair device-client.ts's cookie login needs —
 * never hardcoded, never logged). VPNUsername/VPNPassword sent to the
 * device are deliberately empty: the generated .ovpn is fully
 * self-contained (embedded CA/cert/key from the OpenVPN bridge's PKI), so
 * this client config needs no separate inline auth layer — only cert-based
 * client auth. Never trusts the POST's 200/redirect alone. */
export async function pushVpnConfig(
  siteId: string,
  host: string,
  ovpnFile: Buffer,
  ovpnFilename: string,
  actorId: string
): Promise<VpnPushResult> {
  const result: VpnPushResult = {
    loggedIn: false,
    pushed: false,
    verifiedByReadback: false,
    verifiedByPing: null,
  };

  const [username, password] = await Promise.all([
    getSetting("DINSTAR_WEBUI_USERNAME"),
    getSetting("DINSTAR_WEBUI_PASSWORD"),
  ]);
  if (!username || !password) {
    result.error = "DINSTAR_WEBUI_USERNAME/PASSWORD are not configured — set them in /admin/settings first.";
    await auditPush(actorId, siteId, host, result);
    return result;
  }

  const login = await loginToDevice(host, username, password);
  if (!login.ok || !login.cookie) {
    result.error = login.error ?? "Login to the gateway's admin UI failed.";
    await auditPush(actorId, siteId, host, result);
    return result;
  }
  result.loggedIn = true;

  const push = await postMultipart(
    host,
    login.cookie,
    VPN_CFG_PATH,
    { VPNType: "0", OpenVPNEnable: "on", VPNUsername: "", VPNPassword: "", ok: "Save" },
    { fieldName: "opvn", filename: ovpnFilename, content: ovpnFile }
  );
  if (!push.ok) {
    result.error = push.error ?? `Config push failed (status ${push.status}).`;
    await auditPush(actorId, siteId, host, result);
    return result;
  }
  result.pushed = true;

  // The genuine read-back this device's static-HTML page allows — a fresh
  // GET with the same session cookie, not a trust-the-POST assumption.
  const readback = await getPage(host, login.cookie, VPN_PAGE_PATH);
  result.verifiedByReadback = readback.ok ? isOpenVpnEnabledInHtml(readback.body) : false;
  if (!result.verifiedByReadback) {
    result.error =
      result.error ??
      "Config was pushed but the re-read page does not show OpenVPN as enabled — check the gateway's own Download Log button (Network Configuration -> VPN Parameter) for why.";
  }

  await auditPush(actorId, siteId, host, result);
  return result;
}
