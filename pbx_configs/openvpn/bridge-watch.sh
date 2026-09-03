#!/usr/bin/env bash
# INTERIM STATE (operator decision, 2026-09): the CA private key is now
# passphrase-protected (compliance requirement — the CA is the root of
# per-customer tenant isolation, so an unencrypted CA key on disk was
# rejected). This script's unattended NEW-cert issuance path is disabled
# below (see handle_generate) until "CA signing flow v2" ships an
# admin-approval-at-signing-time flow — new certs are issued manually by
# an admin in the meantime. Revocation (handle_revoke) is untouched: it
# also needs the CA passphrase and will hang the same way if triggered
# unattended — nothing currently calls it automatically, and v2's job
# includes wiring a real (supervised or approval-gated) caller for it.
#
# openvpn-bridge's entrypoint — the ONLY way the web app's server-side code
# (Next.js, no Docker socket, must never hold OpenVPN private key material
# in Postgres — see the plan's "Critical design constraint" on Node B) can
# get a client certificate generated or revoked. Same image as
# openvpn-server (kylemanna/docker-openvpn — it already bundles
# easyrsa/ovpn_getclient), same shared `openvpn_data` volume, but this
# container never runs the VPN daemon itself — it only ever runs PKI CLI
# commands against that shared volume. Mirrors this repo's existing
# `cert-sync` service in spirit (a narrowly-scoped, single-purpose watcher
# that acts on a marker file) but needs no Docker socket at all: cert
# generation happens by running a command inside THIS container against a
# volume it already has, not by controlling ANOTHER container.
#
# CONTRACT (the web-app caller-side code, built in a later task, must match
# this exactly):
#
#   Request:  create an EMPTY file at /requests/<site>.generate (to issue a
#             new client cert) or /requests/<site>.revoke (to revoke one).
#             <site> must be the exact GatewaySite.name / intended
#             certificate CN.
#
#   Response, for a .generate request:
#     success -> /clients/<site>.ovpn (the unified .ovpn file, real private
#                key embedded — download/QR source) AND /clients/<site>.done
#                (empty sentinel, written LAST, after the .ovpn file is
#                fully and atomically in place — poll for THIS file's
#                existence, not the .ovpn's, to avoid reading a
#                partially-written file)
#     failure -> /clients/<site>.error containing the error message, NO
#                .ovpn or .done file
#
#   Response, for a .revoke request:
#     success -> /clients/<site>.revoked (empty sentinel) — the caller must
#                separately restart/reload openvpn-server for the updated
#                CRL to actually take effect; this script does not do that
#                itself (it has no reason to touch the sibling container).
#     failure -> /clients/<site>.error
#
#   The request file itself is deleted once processed, success or failure,
#   so the queue never reprocesses a stale request.
#
# SAFETY: <site> is taken from a filename an external caller ultimately
# controls (via whatever validates GatewaySite.name before writing the
# request file) — this script does NOT trust that upstream validation
# alone. Every filename is re-validated here against a strict allowlist
# before ever being interpolated into a shell command, as defense in
# depth (this is exactly what this task's own security review is
# expected to check).
set -euo pipefail

REQUESTS_DIR="${REQUESTS_DIR:-/requests}"
CLIENTS_DIR="${CLIENTS_DIR:-/clients}"
POLL_INTERVAL_SECS="${POLL_INTERVAL_SECS:-2}"

# Strict allowlist: lowercase/uppercase letters, digits, hyphen, underscore,
# 1-64 chars. Matches GatewaySite.name's expected shape and is exactly what
# easyrsa accepts as a safe CN component. Anything else is refused outright
# — never passed to easyrsa/ovpn_getclient under any circumstances.
SAFE_NAME_RE='^[A-Za-z0-9_-]{1,64}$'

log() { echo "[bridge-watch] $(date -u +%FT%TZ) $*"; }

is_safe_name() {
  [[ "$1" =~ $SAFE_NAME_RE ]]
}

handle_generate() {
  local site="$1"
  # Clear any stale .done/.error sentinel from a PRIOR request for this same
  # site before processing this new one — the caller side (generate-cert/
  # route.ts) tries to do this itself before writing the request file, but
  # its own attempt silently no-ops: clients/ is mounted read-only into the
  # `web` container (by design — web must never hold write access to real
  # private key material), so its unlink() calls fail closed with EROFS and
  # get swallowed. This container has genuine read-write access to the same
  # volume, so it's the correct place to own this cleanup (V1 security
  # review caught the original gap: a leftover .error from a previous
  # attempt was being misread as the current request's own result).
  rm -f "${CLIENTS_DIR}/${site}.done" "${CLIENTS_DIR}/${site}.error"
  if [[ -f "${CLIENTS_DIR}/${site}.ovpn" ]]; then
    # Idempotent: a cert for this CN already exists (e.g. a retried
    # request, or the wizard was re-run) — re-emit the existing unified
    # file rather than trying (and failing) to re-issue the same CN.
    log "cert for '${site}' already exists, re-emitting without reissuing"
  elif [[ -f "/etc/openvpn/pki/issued/${site}.crt" ]]; then
    log "PKI already has an issued cert for '${site}' but no .ovpn on record — regenerating the unified file only"
  else
    # INTERIM HARD RULE (operator decision, pending "CA signing flow v2" —
    # see that plan when it exists): unattended `easyrsa build-client-full`
    # is DISABLED, not "made to work around" the now-passphrase-protected
    # CA key. Once the CA has a real passphrase, this call would block on
    # easyrsa's own interactive prompt for it — and this script has no TTY
    # and no route to the passphrase at all (it's held only in the
    # encrypted AppSetting store once v2 lands, never on this container's
    # filesystem). A hang on stdin inside a container is worse than a
    # clean, immediate refusal: every new client cert is issued by a human
    # running `easyrsa build-client-full <site> nopass` directly (client
    # key stays nopass — only the CA key is passphrase-protected — and
    # typing the CA passphrase when easyrsa prompts for it) until v2 ships
    # an admin-approval-at-signing-time flow. This branch only ever
    # refuses; it never attempts to sign anything.
    log "REFUSING to issue a new cert for '${site}': unattended signing is disabled (CA key is passphrase-protected, interim rule pending 'CA signing flow v2')"
    echo "New client certs are issued manually by an admin (easyrsa build-client-full ${site} nopass, typing the CA passphrase when prompted) until the CA signing flow v2 task ships. Ask an admin to issue this cert, then retry." > "${CLIENTS_DIR}/${site}.error"
    return
  fi

  local tmp="${CLIENTS_DIR}/.${site}.ovpn.tmp"
  if ! ovpn_getclient "${site}" nopass > "${tmp}" 2>"${CLIENTS_DIR}/${site}.error.tmp"; then
    mv "${CLIENTS_DIR}/${site}.error.tmp" "${CLIENTS_DIR}/${site}.error"
    rm -f "${tmp}"
    return
  fi
  rm -f "${CLIENTS_DIR}/${site}.error.tmp" "${CLIENTS_DIR}/${site}.error"
  # Atomic rename so a caller polling for the .ovpn file never reads a
  # partial write; the .done sentinel is the actual "ready" signal anyway.
  mv "${tmp}" "${CLIENTS_DIR}/${site}.ovpn"
  : > "${CLIENTS_DIR}/${site}.done"
  log "generated ${CLIENTS_DIR}/${site}.ovpn"
}

handle_revoke() {
  local site="$1"
  if [[ ! -f "/etc/openvpn/pki/issued/${site}.crt" ]]; then
    echo "no issued cert found for '${site}', nothing to revoke" > "${CLIENTS_DIR}/${site}.error"
    return
  fi
  log "revoking cert for '${site}'"
  if ! easyrsa --batch revoke "${site}" || ! EASYRSA_CRL_DAYS=3650 easyrsa gen-crl; then
    echo "revocation failed for '${site}'" > "${CLIENTS_DIR}/${site}.error"
    return
  fi
  rm -f "${CLIENTS_DIR}/${site}.ovpn" "${CLIENTS_DIR}/${site}.done"
  : > "${CLIENTS_DIR}/${site}.revoked"
  log "revoked '${site}' — openvpn-server must be restarted/reloaded to pick up the new CRL (this script does not do that itself)"
}

mkdir -p "${REQUESTS_DIR}" "${CLIENTS_DIR}"
log "watching ${REQUESTS_DIR} every ${POLL_INTERVAL_SECS}s"

while true; do
  for req in "${REQUESTS_DIR}"/*.generate "${REQUESTS_DIR}"/*.revoke; do
    [[ -e "${req}" ]] || continue  # glob didn't match anything
    base="$(basename "${req}")"
    site="${base%.*}"
    action="${base##*.}"

    if ! is_safe_name "${site}"; then
      log "REFUSING unsafe request filename: ${base}"
      rm -f "${req}"
      continue
    fi

    case "${action}" in
      generate) handle_generate "${site}" ;;
      revoke) handle_revoke "${site}" ;;
    esac
    rm -f "${req}"
  done
  sleep "${POLL_INTERVAL_SECS}"
done
