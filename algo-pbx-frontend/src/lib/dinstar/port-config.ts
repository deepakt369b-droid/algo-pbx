// Builds and submits the "apply standard SIM config" write to the Dinstar
// admin web UI (POST /goform/PortCfg) — see device-client.ts's header for
// why this device's real per-port form values cannot be read back
// server-side, making this WRITE-ONLY by necessity, not by choice.
//
// The full-table field scheme and its exact values were confirmed live
// against the production gateway 2026-08-29: reading the real
// enPortList.htm form (via a browser, since only a browser executes the
// page's own field-drawing JS) showed every port's SIP/registration
// fields blank, Register=No Register (value 64), TxGain=+2dB (value 2),
// RxGain=+6dB (value 6) — this module reproduces exactly that baseline on
// every write, which is safe on THIS device today because nothing else is
// configured on any port. It is not a general-purpose "preserve whatever
// is there" writer — see the module header's limitation note.
import { loginToDevice, postForm } from "./device-client";

export interface ApplyStandardConfigResult {
  ok: boolean;
  ports: number[];
  error?: string;
}

// Only ports with real modem hardware on this specific UC2000-VE unit
// (confirmed in handoff.md/LLM.md across multiple sessions: ports 4-7 have
// no modem installed/powered). Touching an unpopulated port is harmless,
// but there is no reason to.
const REAL_PORTS = [0, 1, 2, 3];

// Register=64 is "No Register" (confirmed live from the real <select> —
// the other options are 65="Sip Proxy" and 0="sip-trunk-0 <AlgoPBX>", the
// LATTER of which the Tel->IP/IP->Tel ROUTING RULES already select at the
// port-group level; the per-port Register field is a different, legacy
// per-port registration mode this deployment has never used and must not
// suddenly enable here). TxGain/RxGain values are the untouched factory
// defaults observed on every port.
const REGISTER_NONE = "64";
const TX_GAIN_DEFAULT = "2"; // +2dB
const RX_GAIN_DEFAULT = "6"; // +6dB

export function buildPortCfgPayload(hotline: string): URLSearchParams {
  const params = new URLSearchParams();
  for (let n = 0; n <= 7; n++) {
    params.set(`SipAcc${n}`, "");
    params.set(`AuthenticateID${n}`, "");
    params.set(`SipAccPsw${n}`, "");
    params.set(`SipLocalPort${n}`, "");
    params.set(`Register${n}`, REGISTER_NONE);
    params.set(`TxGain${n}`, TX_GAIN_DEFAULT);
    params.set(`RxGain${n}`, RX_GAIN_DEFAULT);
    params.set(`OffhookAutodial${n}`, REAL_PORTS.includes(n) ? hotline : "");
    params.set(`PSTNHotline${n}`, "");
  }
  // The form's "All" row (bulk copy-to-every-port helpers) — left blank,
  // matching its own default/unused state confirmed live; these fields do
  // nothing when empty, they only act when a "copy" button is clicked
  // client-side, which this write never simulates.
  for (const field of ["SipAcc", "AuthenticateID", "SipAccPsw", "SipLocalPort", "OffhookAutodial", "PSTNHotline"]) {
    params.set(`${field}All`, "");
  }
  params.set("ok", "Save");
  return params;
}

/** Logs into the gateway's admin web UI and writes the standard SIM
 * config (a real, non-empty hotline on every populated port; everything
 * else left at its confirmed-blank/default baseline) to all 8 port rows
 * in one POST, matching how the device's own form actually submits.
 * `hotline` is typically "100" or "s" — either matches
 * `pbx_configs/extensions.conf`'s `[from-dinstar]` handler
 * (`_X.`/literal `s` both `Goto(s,1)`), see that context's own comment. */
export async function applyStandardPortConfig(host: string, username: string, password: string, hotline: string): Promise<ApplyStandardConfigResult> {
  const login = await loginToDevice(host, username, password);
  if (!login.ok || !login.cookie) {
    return { ok: false, ports: [], error: login.error ?? "Login failed." };
  }

  const payload = buildPortCfgPayload(hotline);
  const result = await postForm(host, login.cookie, "/goform/PortCfg", payload.toString());

  // Confirmed live: a successful save 302-redirects to /enSetOK.htm; a
  // rejected/unauthenticated request redirects to /enLogin.htm instead.
  const location = result.location ?? "";
  const succeeded = result.status >= 300 && result.status < 400 && /enSetOK\.htm/i.test(location);
  if (!succeeded) {
    return {
      ok: false,
      ports: [],
      error: /enLogin\.htm/i.test(location)
        ? "The gateway rejected the session — it may have expired mid-write. Try again."
        : `Unexpected response from the gateway (status ${result.status}).`,
    };
  }

  return { ok: true, ports: REAL_PORTS };
}
