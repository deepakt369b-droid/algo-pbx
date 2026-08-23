// Renders PJSIP endpoint/auth/aor stanzas for pbx_configs/pjsip_dynamic.conf
// — Phase A's config-generation approach to extension provisioning (see the
// plan file referenced in LLM.md §7: config-gen + AMI `pjsip reload`,
// rejected PJSIP realtime/ODBC for testability and to keep Prisma the sole
// schema owner). Pure and side-effect-free by design: the API route that
// calls this handles secret generation, the actual file write, and
// triggering the AMI reload — this function only turns data into text.
//
// Stanza shapes mirror pbx_configs/pjsip.conf's original hand-written
// [1001]/[1001-auth]/[1001-aor] (webrtc) and [2001]/[2001-auth]/[2001-aor]
// (hardware) templates exactly, so existing behavior for those two
// extensions is preserved once they're migrated into the generated file.

export interface ExtensionForPjsip {
  number: string;
  kind: "webrtc" | "hardware";
  sipSecret: string;
}

const BANNER = `; GENERATED FILE — DO NOT HAND-EDIT.
; Rendered by src/lib/pjsip-config.ts from the Extension table in Postgres.
; Hand edits will be silently overwritten the next time an extension is
; created, updated, or removed. To change static config (transports, the
; Dinstar trunk), edit pjsip-base.conf instead — see docker-compose.yml's
; comment on how the two files are #included together.
`;

// Defense in depth: this function's output is written directly into a file
// Asterisk parses and reloads. Callers are expected to have already
// validated `number` (e.g. \\d{3,6}) and generated `sipSecret` themselves,
// but a bracket or newline here could inject an extra [section] or corrupt
// the file, so reject rather than silently emit broken/hostile config.
const UNSAFE_CHARS = /[[\]\r\n]/;

function assertSafe(value: string, field: string): void {
  if (UNSAFE_CHARS.test(value)) {
    throw new Error(`renderPjsipConf: unsafe character in ${field} (brackets/newlines not allowed): ${value}`);
  }
}

// Codec order deliberately makes alaw first choice, not opus. The far end
// of every call this endpoint can reach is either another 8kHz endpoint or
// the Dinstar GSM trunk (also alaw-only, see pjsip-base.conf) — so putting
// opus first bought zero perceived quality while forcing Asterisk to
// transcode opus(48kHz)<->alaw(8kHz) on 100% of calls: a full decode,
// resample, and re-encode pass adding ~10-20ms of one-way latency and real
// CPU load, competing with Asterisk's other real-time work for it. opus is
// kept available (agents' browsers will still negotiate alaw since it's
// listed and PJSIP picks the endpoint's preferred/first match) only as a
// fallback for the rare internal-only WebRTC-to-WebRTC call where no
// transcoding penalty applies either way.
function renderWebrtcStanza(ext: ExtensionForPjsip): string {
  return `[${ext.number}]
type=endpoint
transport=transport-wss
context=from-agent
disallow=all
allow=alaw,ulaw,opus
webrtc=yes
use_avpf=yes
media_encryption=dtls
dtls_verify=fingerprint
dtls_cert_file=/etc/asterisk/keys/asterisk.crt
dtls_private_key_file=/etc/asterisk/keys/asterisk.key
dtls_setup=actpass
ice_support=yes
media_use_received_transport=yes
; webrtc=yes implies use_avpf/media_encryption/dtls_verify/ice_support/
; media_use_received_transport, but NOT these two — both needed once this
; endpoint is expected to actually complete calls through NAT reliably.
rewrite_contact=yes
rtp_symmetric=yes
; direct_media=yes is PJSIP's default when unset, and was unset here. That
; lets Asterisk attempt to re-INVITE media directly between a DTLS/SRTP
; WebRTC browser and the alaw Dinstar trunk (reached over a Tailscale
; subnet) — a renegotiation that cannot succeed, producing 1-3s mid-call
; audio dropouts as it's attempted and reverted, and breaking both
; MixMonitor recording and ConfBridge (both require Asterisk to stay in
; the media path). pjsip-base.conf's dinstar-trunk already had this right;
; the generated endpoint template did not.
direct_media=no
rtp_timeout=30
rtp_timeout_hold=300
auth=${ext.number}-auth
aors=${ext.number}-aor

[${ext.number}-auth]
type=auth
auth_type=userpass
username=${ext.number}
password=${ext.sipSecret}

[${ext.number}-aor]
type=aor
max_contacts=2
remove_existing=yes
`;
}

function renderHardwareStanza(ext: ExtensionForPjsip): string {
  return `[${ext.number}]
type=endpoint
transport=transport-udp
context=from-internal
disallow=all
allow=alaw,ulaw
direct_media=no
rtp_timeout=30
rtp_timeout_hold=300
auth=${ext.number}-auth
aors=${ext.number}-aor

[${ext.number}-auth]
type=auth
auth_type=userpass
username=${ext.number}
password=${ext.sipSecret}

[${ext.number}-aor]
type=aor
max_contacts=1
`;
}

export function renderPjsipConf(extensions: ExtensionForPjsip[]): string {
  const stanzas = extensions.map((ext) => {
    assertSafe(ext.number, "number");
    assertSafe(ext.sipSecret, "sipSecret");
    return ext.kind === "webrtc" ? renderWebrtcStanza(ext) : renderHardwareStanza(ext);
  });

  return [BANNER, ...stanzas].join("\n");
}
