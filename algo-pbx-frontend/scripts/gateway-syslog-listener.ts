#!/usr/bin/env -S node --enable-source-maps
// Standalone, long-running UDP listener for the Dinstar gateway's syslog
// forwarding (Diagnostic -> Syslog on the gateway's own web UI — NOT the
// generic Tools -> Remote Server page, which is an unrelated feature with
// no port/level fields). Deliberately a DUMB FORWARDER: it does no line
// parsing or event classification itself — it just accepts datagrams,
// batches them, and POSTs the raw lines to POST /api/gateway-events, which
// applies src/lib/dinstar/syslog-parse.ts server-side. This mirrors
// ami-cdr-listener.ts's own separation of concerns (a small, dumb,
// hard-to-crash intake process; the real logic lives in the web tier where
// it can be redeployed without restarting the thing facing untrusted
// network input) and keeps this process's attack surface — a UDP socket
// facing a device we don't control — as small as possible.
//
// Run via `npm run gateway-syslog-listener` (tsx) or as its own container
// (docker-compose.yml's `gateway-syslog-listener` service, network_mode:
// host — this process must bind the VPS's real Tailscale IP, not a Docker
// bridge address).
//
// KNOWN STATE as of this writing (2026-09-03): the gateway's Diagnostic ->
// Syslog page was configured live (server = the VPS's Tailscale IP, port
// 5514, level INFO, Signal/System/Management Log enabled) and confirmed to
// SAVE and PERSIST through a full gateway reboot — but zero UDP or TCP
// traffic on port 514 or 5514 was observed arriving at the VPS across a
// reboot, a config re-save, a port block/unblock toggle, and a mobile-call-
// test attempt, verified via tcpdump on both the narrow (tailscale0) and a
// wide (any interface, TCP+UDP) capture. This gap is UNRESOLVED — the
// operator's SIM was ejected mid-diagnosis, which is what would let a real
// GSM/call event be tried next. Do not assume this listener has been
// proven to receive real gateway traffic; it has only been built to be
// correct once traffic does arrive.
//
// DUAL-HOMING (OpenVPN/Headscale/connectivity task, Node F, 2026-09-03):
// G2's live cutover re-points the gateway's Diagnostic -> Syslog Remote
// Server target at 10.8.0.1 (the OpenVPN tunnel's server-side address,
// host-visible here because openvpn-server also runs network_mode: host).
// Both the Tailscale path and the OpenVPN path must keep receiving during
// the transition window — the operator explicitly deferred deprecating
// Tailscale until G2 step 7 confirms the OpenVPN path works end-to-end, so
// dropping Tailscale-path events before then would be a real, silent data
// loss regression. SYSLOG_BIND_IP_SECONDARY (optional) opens a second
// socket on the same port when set; unset, behavior is byte-for-byte
// identical to before this change — no default second bind, same
// "never assume a wildcard address" posture as the primary bind below.

import dgram from "node:dgram";

const BIND_PORT = Number(process.env.SYSLOG_BIND_PORT || 5514);
const INGEST_URL = process.env.GATEWAY_EVENTS_INGEST_URL || "http://127.0.0.1:3000/api/gateway-events";
const INGEST_SECRET = process.env.GATEWAY_INGEST_SECRET || "";

const PRIMARY_BIND_IP = process.env.SYSLOG_BIND_IP;
// Optional — only set once G2's cutover has re-pointed the gateway at
// 10.8.0.1 and dual-homing is actually needed. Left unset, this process
// binds only the primary (Tailscale) address, exactly as before.
const SECONDARY_BIND_IP = process.env.SYSLOG_BIND_IP_SECONDARY;

// Fail loudly rather than default to 0.0.0.0 — a wildcard bind on a
// syslog-over-UDP port facing the internet (this VPS's other interface) is
// exactly the kind of quiet misconfiguration that turns into an open relay
// or a log-injection vector. The gateway is reached over Tailscale and (once
// G2 lands) the OpenVPN tunnel — this must be told each address explicitly,
// never assumed.
if (!PRIMARY_BIND_IP) {
  console.error("gateway-syslog-listener: SYSLOG_BIND_IP must be set to the VPS's Tailscale IP. Refusing to bind 0.0.0.0. Exiting.");
  process.exit(1);
}
if (!INGEST_SECRET) {
  console.error("gateway-syslog-listener: GATEWAY_INGEST_SECRET must be set. Exiting.");
  process.exit(1);
}

// A syslog line is at most a few hundred bytes in any real format (RFC
// 3164 caps at 1024 total). Anything wildly larger than that is not a
// syslog line from this gateway — cap hard rather than let a malformed or
// hostile datagram grow an unbounded buffer.
const MAX_LINE_BYTES = 8192;
const MAX_BATCH_LINES = 200;
const BATCH_FLUSH_MS = 1500;

interface CapturedLine {
  raw: string;
  sourceIp: string;
  receivedAt: string;
}

// One shared batch/flush pipeline across BOTH sockets — a line's downstream
// handling (batching, POST, drop-counting) doesn't care which interface it
// arrived on; only `sourceIp` (already per-datagram, from `rinfo`) carries
// that distinction through to the ingest route.
let buffer: CapturedLine[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let droppedOversized = 0;
let droppedParseError = 0;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, BATCH_FLUSH_MS);
}

async function flush() {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];

  try {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INGEST_SECRET}`,
      },
      body: JSON.stringify({ lines: batch }),
    });
    if (!res.ok) {
      console.error(`gateway-syslog-listener: ingest failed (${res.status}) for a batch of ${batch.length} line(s)`);
    }
  } catch (err) {
    // Never crash the process over a failed POST — the web tier being
    // briefly unreachable (a deploy, a restart) must not take down UDP
    // intake. The batch is dropped rather than retried/requeued: syslog
    // over UDP is already lossy by design (no delivery guarantee from the
    // gateway itself), so adding unbounded local retry buffering here
    // would just move the loss point without fixing it, at the cost of
    // memory growth if the web tier stays down for a while.
    console.error("gateway-syslog-listener: ingest request errored:", err);
  }
}

function handleDatagram(msg: Buffer, rinfo: { address: string }) {
  try {
    if (msg.length > MAX_LINE_BYTES) {
      droppedOversized++;
      return;
    }
    const raw = msg.toString("utf8");
    buffer.push({ raw, sourceIp: rinfo.address, receivedAt: new Date().toISOString() });
    if (buffer.length >= MAX_BATCH_LINES) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      void flush();
    } else {
      scheduleFlush();
    }
  } catch (err) {
    // A malformed/non-UTF8 datagram must never crash this process — it is
    // facing a device we don't control over an inherently untrusted
    // transport (plain UDP, no auth, no integrity check at the syslog
    // layer itself).
    droppedParseError++;
    console.error("gateway-syslog-listener: failed to handle datagram, dropping:", err);
  }
}

/** Binds one UDP socket to `bindIp:BIND_PORT`, wired to the shared
 * datagram handler above. Used for both the primary (Tailscale) and,
 * when set, the secondary (OpenVPN tunnel) bind — identical handling,
 * only the bound address differs. */
function bindSocket(bindIp: string, label: string): dgram.Socket {
  const socket = dgram.createSocket("udp4");
  socket.on("message", handleDatagram);
  socket.on("error", (err) => {
    console.error(`gateway-syslog-listener: socket error (${label}, ${bindIp}):`, err);
  });
  socket.bind(BIND_PORT, bindIp, () => {
    console.log(`gateway-syslog-listener: listening on ${bindIp}:${BIND_PORT} (${label}), forwarding to ${INGEST_URL}`);
  });
  return socket;
}

const sockets: dgram.Socket[] = [bindSocket(PRIMARY_BIND_IP, "primary/tailscale")];
if (SECONDARY_BIND_IP) {
  sockets.push(bindSocket(SECONDARY_BIND_IP, "secondary/openvpn"));
}

// Periodic visibility into drop counts — this process otherwise runs
// silent between events, and a steadily climbing drop count with zero
// successful ingests is the signal that something upstream (parser,
// ingest route, or the gateway's own config) needs attention.
setInterval(() => {
  if (droppedOversized > 0 || droppedParseError > 0) {
    console.warn(`gateway-syslog-listener: dropped ${droppedOversized} oversized, ${droppedParseError} unparseable datagram(s) so far`);
  }
}, 60_000).unref();

process.on("SIGTERM", () => {
  let remaining = sockets.length;
  const done = () => {
    remaining--;
    if (remaining <= 0) process.exit(0);
  };
  for (const s of sockets) s.close(done);
});
