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
 * itself validate shape beyond the injection guard shared with pjsip-config.ts. */
export function renderDinstarConf(ip: string): string {
  assertSafe(ip, "ip");
  return `${BANNER}
[dinstar-aor]
type=aor
contact=sip:${ip}:5060

[dinstar-identify]
type=identify
endpoint=dinstar-trunk
match=${ip}
`;
}
