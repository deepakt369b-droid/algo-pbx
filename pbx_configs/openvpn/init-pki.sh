#!/usr/bin/env bash
# One-time OpenVPN server bootstrap: generate openvpn.conf, then initialize
# the CA + server certificate. Run ONCE, by hand, during initial deploy (see
# this directory's README.md "Setup" section) — NOT part of any container's
# automatic startup, and NOT re-runnable against an already-initialized PKI
# (the guard clause below refuses that rather than silently regenerating a
# CA and invalidating every client cert already issued against the old one).
#
# LEGACY-CLIENT COMPATIBILITY — READ THIS BEFORE "MODERNIZING" ANYTHING HERE.
# The Dinstar UC2000's embedded OpenVPN client is old firmware (likely
# 2.x/2.3-era — confirmed by inspecting its own VPN Parameter page, which
# offers no cipher/auth negotiation options at all, a hallmark of an old,
# fixed-suite client). A modern OpenVPN server's DEFAULTS (an AEAD/GCM
# cipher, SHA256+ auth already assumed, TLS 1.2+ minimum) will silently
# fail to complete a TLS handshake against a client that old — "silently"
# meaning: no clear error, just a tunnel that never comes up, which is
# exactly the failure mode the operator was warned to expect in G2 and told
# to check the gateway's own "Download Log" button for. The settings below
# are chosen SPECIFICALLY to be negotiable by that old client, not as a
# general security posture — do not "fix" these to modern defaults without
# re-testing against the real device first.
set -euo pipefail

OVPN_DATA_DIR="${OVPN_DATA_DIR:-/etc/openvpn}"

if [[ -z "${VM_PUBLIC_IP:-}" ]]; then
  echo "VM_PUBLIC_IP must be set (see .env) — this is the address the" >&2
  echo "Dinstar gateway's OpenVPN client will dial into port 1194/udp." >&2
  exit 1
fi

# Run genconfig + initpki INSIDE the openvpn-server container (it has
# easyrsa/openvpn's own tooling baked in) against the shared openvpn_data
# volume — invoke this script via:
#   docker compose run --rm openvpn-server /scripts/init-pki.sh
# (bind-mount this script read-only into the container — see
# docker-compose.yml's openvpn-server comment for the exact mount).

if [[ -f "${OVPN_DATA_DIR}/pki/ca.crt" ]]; then
  echo "Refusing to re-run: ${OVPN_DATA_DIR}/pki/ca.crt already exists." >&2
  echo "Re-initializing would invalidate every client cert already issued" >&2
  echo "against the current CA. If you genuinely need a fresh PKI, remove" >&2
  echo "the openvpn_data volume explicitly first — this script won't do" >&2
  echo "that for you." >&2
  exit 1
fi

# CORRECTED live on the real deployment VM (2026-09) — the original
# invocation here was flat-out wrong, caught only by actually running it:
#   1. `-c AES-256-CBC -a SHA256` — WRONG FLAGS. Confirmed via
#      `ovpn_genconfig --help` on the real image: `-c` is a boolean
#      "enable client-to-client" switch (no value), not a cipher flag —
#      there is no plain `-c`/`--cipher` flag for the data-channel
#      cipher at all. The generated openvpn.conf had NEITHER a `cipher`
#      nor an `auth` directive — meaning it would have silently fallen
#      back to OpenVPN's own modern AEAD defaults, defeating the entire
#      point of this legacy-compatibility work. Fixed below by appending
#      `cipher`/`auth` directly, same as tls-version-min already is.
#   2. No `-s SERVER_SUBNET` was passed, so kylemanna's own default
#      subnet was used — which is 192.168.255.0/24, NOT 10.8.0.0/24 (this
#      script's own header used to claim 10.8.0.0/24 was "OpenVPN's own
#      default" — that was never actually verified and was wrong. Every
#      other piece of this feature — the syslog dual-homing firewall
#      rules, the GatewaySite/client-config-dir plan, Headscale's own
#      config comment — assumes 10.8.0.0/24, so it's now passed
#      explicitly rather than trusted to any default.
#   3. `-d` (disable default route) and `-b -D` (disable the DNS-related
#      pushes) added — this tunnel exists so the VPS can reach ONE
#      embedded telephony gateway, not to become that device's default
#      internet route or to reconfigure its DNS. `-n 8.8.8.8 -n 1.1.1.1`
#      removed (only meaningful paired with DNS pushing, now disabled).
#   4. The stray `route 192.168.254.0/24` and the default
#      `status /tmp/...` line ovpn_genconfig emits regardless are
#      stripped below — the first pushes a route to a subnet that
#      doesn't exist anywhere in this deployment (harmless but
#      confusing), the second would otherwise leave two different
#      `status` directives in the same file alongside the real one this
#      script appends further down.
echo "Generating openvpn.conf (legacy-client-compatible settings)..."
ovpn_genconfig \
  -u "udp://${VM_PUBLIC_IP}:1194" \
  -s 10.8.0.0/24 \
  -d -b -D

sed -i '/^route 192\.168\.254\.0/d; /^status \/tmp\//d' "${OVPN_DATA_DIR}/openvpn.conf"

# Caught live generating the FIRST client cert: `ovpn_getclient` (used by
# both the manual admin flow and bridge-watch.sh's idempotent re-emit
# path) does NOT read the server's own openvpn.conf for cipher/auth —
# it only honors $OVPN_CIPHER/$OVPN_AUTH from ovpn_env.sh, which
# ovpn_genconfig's own CLI flags (-a/-C/-T) map to ambiguously/
# unreliably (already burned twice this session trusting genconfig flag
# semantics that turned out wrong — not gambling a third time). Setting
# these directly in the persisted env file is the same fix already
# proven to work live. Without this, every generated client .ovpn
# silently omits cipher/auth entirely, the exact "legacy-compat work
# quietly didn't apply" failure mode this whole script exists to avoid —
# just on the CLIENT config this time instead of the server's.
# OVPN_ROUTES is also cleared here — it independently persists the same
# stray default route stripped from openvpn.conf above, and a fresh
# `ovpn_getclient` run reads this env file, not the already-patched
# openvpn.conf, so both had to be fixed for the fix to actually hold.
sed -i \
  -e 's/^declare -x OVPN_AUTH=$/declare -x OVPN_AUTH=SHA256/' \
  -e 's/^declare -x OVPN_CIPHER=$/declare -x OVPN_CIPHER=AES-256-CBC/' \
  -e '/^declare -x OVPN_ROUTES=/d' \
  "${OVPN_DATA_DIR}/ovpn_env.sh"
echo 'declare -x OVPN_ROUTES=()' >> "${OVPN_DATA_DIR}/ovpn_env.sh"

# ovpn_genconfig has no flags for these — append directly. Order matters
# less than presence; OpenVPN reads the whole file.
{
  echo ""
  echo "# --- Legacy-client compatibility (see init-pki.sh's header) ---"
  echo "# cipher/auth: NOT set via ovpn_genconfig flags (see the header"
  echo "# comment above on why -c/-a were wrong) — set directly here."
  echo "# AES-256-CBC (not an AEAD/GCM cipher) and SHA256 auth are what"
  echo "# the old embedded client can actually negotiate."
  echo "cipher AES-256-CBC"
  echo "auth SHA256"
  echo "# tls-version-min 1.0: the old embedded client cannot negotiate"
  echo "# TLS 1.2+, which modern OpenVPN otherwise requires by default."
  echo "tls-version-min 1.0"
  echo "# NOT setting data-ciphers-fallback: caught live on the real"
  echo "# deployment VM — the actual installed openvpn binary in this"
  echo "# image is 2.4.9, which predates that directive entirely (added"
  echo "# in 2.5+) and refuses to start with 'Unrecognized option' if"
  echo "# it's present. 2.4.9 doesn't have modern --data-ciphers"
  echo "# negotiation to begin with — the bare 'cipher AES-256-CBC'"
  echo "# above is already what it uses, no fallback directive needed."
  echo "# Do not re-add this without confirming the actual installed"
  echo "# openvpn version first (docker logs algo-openvpn-server shows"
  echo "# it on every start)."
  echo "# Compression is deprecated (VORACLE) AND unlikely to be correctly"
  echo "# negotiated by a client this old either way — explicitly off,"
  echo "# not left to either side's default."
  echo "comp-lzo no"
  echo ""
  echo "# --- Connectivity-poller status log (OpenVPN/Headscale/connectivity"
  echo "# task, Node F) --- explicit rather than relying on ovpn_genconfig's"
  echo "# own default (which varies by image version/path) — the 60s"
  echo "# connectivity-check route reads this file (via a subpath volume"
  echo "# mount into the web container, see docker-compose.yml's web"
  echo "# service comment) to determine per-site handshake freshness."
  echo "# status-version 2 is the machine-parseable comma-separated format;"
  echo "# cadence 10 5 writes at most every 10s, forced at least every 5"
  echo "# checks — frequent enough that a 60s poll never reads a stale file."
  echo "# status-cadence was tried and removed — caught live: it doesn't"
  echo "# exist until OpenVPN 2.6 (added well after this server's actual"
  echo "# 2.4.9 binary). status-version 2 alone has existed since much"
  echo "# earlier and is sufficient — the connectivity-check poller only"
  echo "# needs the file to update periodically, which OpenVPN already"
  echo "# does on its own without this directive."
  echo "status ${OVPN_DATA_DIR}/openvpn-status.log"
  echo "status-version 2"
} >> "${OVPN_DATA_DIR}/openvpn.conf"

echo "Initializing PKI (CA + server cert) — this WILL prompt for a CA"
echo "passphrase unless run with EASYRSA_BATCH=1 / nopass; do this"
echo "interactively, do not pipe a blank CA passphrase into production:"
ovpn_initpki

echo ""
echo "Done. Server identity: 10.8.0.1 (the -s 10.8.0.0/24 subnet passed"
echo "above, NOT a genconfig default — see this script's header)."
echo "Next: generate a per-site client cert via the requests/clients"
echo "file-drop contract documented in bridge-watch.sh, not this script."
