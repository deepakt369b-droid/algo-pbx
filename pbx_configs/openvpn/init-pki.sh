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

echo "Generating openvpn.conf (legacy-client-compatible settings)..."
ovpn_genconfig \
  -u "udp://${VM_PUBLIC_IP}:1194" \
  -n 8.8.8.8 -n 1.1.1.1 \
  -c AES-256-CBC \
  -a SHA256

# ovpn_genconfig has no flags for these — append directly. Order matters
# less than presence; OpenVPN reads the whole file.
{
  echo ""
  echo "# --- Legacy-client compatibility (see init-pki.sh's header) ---"
  echo "# tls-version-min 1.0: the old embedded client cannot negotiate"
  echo "# TLS 1.2+, which modern OpenVPN otherwise requires by default."
  echo "tls-version-min 1.0"
  echo "# data-ciphers-fallback: lets a client that doesn't speak the"
  echo "# modern --data-ciphers negotiation list still connect using the"
  echo "# single cipher named here, instead of being rejected outright."
  echo "data-ciphers-fallback AES-256-CBC"
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
  echo "status ${OVPN_DATA_DIR}/openvpn-status.log"
  echo "status-version 2"
  echo "status-cadence 10 5"
} >> "${OVPN_DATA_DIR}/openvpn.conf"

echo "Initializing PKI (CA + server cert) — this WILL prompt for a CA"
echo "passphrase unless run with EASYRSA_BATCH=1 / nopass; do this"
echo "interactively, do not pipe a blank CA passphrase into production:"
ovpn_initpki

echo ""
echo "Done. Server identity: 10.8.0.1 (OpenVPN's own default first"
echo "server-side address for its default 10.8.0.0/24 subnet)."
echo "Next: generate a per-site client cert via the requests/clients"
echo "file-drop contract documented in bridge-watch.sh, not this script."
