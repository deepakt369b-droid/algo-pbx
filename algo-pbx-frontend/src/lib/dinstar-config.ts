// Renders pbx_configs/pjsip_dinstar.conf — the [dinstar-aor]/[dinstar-identify]
// stanzas that pjsip-base.conf used to hand-write with a hardcoded
// 192.168.1.50, in a read-only mount that required SSH access to change.
// Mirrors src/lib/pjsip-config.ts's shape exactly: pure, side-effect-free,
// the same GENERATED-FILE banner, the same bracket/CRLF injection guard.

const BANNER = `; GENERATED FILE — DO NOT HAND-EDIT.
; Rendered by src/lib/dinstar-config.ts from the Dinstar setup wizard
; (/admin/dinstar) or the DINSTAR_LAN_IP setting. Hand edits will be
; silently overwritten the next time the wizard applies a change. The
; static Dinstar trunk endpoint (allow=, dtmf_mode=, etc.) stays in
; pjsip-base.conf — only the discovered IP lives here.
`;

const UNSAFE_CHARS = /[[\]\r\n]/;

function assertSafe(value: string, field: string): void {
  if (UNSAFE_CHARS.test(value)) {
    throw new Error(`renderDinstarConf: unsafe character in ${field} (brackets/newlines not allowed): ${value}`);
  }
}

/** `ip` must already be a validated IPv4/hostname — this function does not
 * itself validate shape beyond the injection guard shared with pjsip-config.ts.
 *
 * `sipPort` is the Dinstar's OWN local SIP port (where Asterisk sends
 * outbound INVITEs). It defaults to 5060 but the UC2000 must be moved off
 * 5060 if Asterisk's transport-udp also binds 5060 on the same host — the
 * device refuses a trunk peer whose port equals its own local port. This
 * office's gateway is on 5061 (DINSTAR_SIP_PORT). */
export function renderDinstarConf(ip: string, sipPort = 5060): string {
  assertSafe(ip, "ip");
  const port = Number.isInteger(sipPort) && sipPort >= 1 && sipPort <= 65535 ? sipPort : 5060;
  return `${BANNER}
[dinstar-aor]
type=aor
contact=sip:${ip}:${port}

[dinstar-identify]
type=identify
endpoint=dinstar-trunk
match=${ip}
`;
}
