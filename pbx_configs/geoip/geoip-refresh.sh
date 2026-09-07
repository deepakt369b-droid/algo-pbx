#!/usr/bin/env sh
# Algo PBX — GeoIP mmdb refresh loop.
#
# Replaces the old `maxmindinc/geoipupdate` service, which needed a free
# MaxMind account + licence key before it would write anything. This
# script needs NO account, key, or env var: it downloads pre-built
# GeoLite2-FORMAT .mmdb files from a public, no-signup mirror instead of
# hitting MaxMind's own licence-gated update endpoint directly.
#
# SOURCE: sapics/ip-location-db (https://github.com/sapics/ip-location-db),
# `latest` GitHub Release. That project republishes MaxMind's GeoLite2
# Country + ASN databases (among others) as plain downloadable .mmdb
# files with no auth wall. It rebuilds them from MaxMind's own feed
# twice a week — same underlying data as `geoipupdate` used to fetch,
# just without the account requirement in front of it.
#
# LICENCE / ATTRIBUTION (do not remove — required by the terms below):
#   GeoLite2 data is created by MaxMind (https://www.maxmind.com) and is
#   provided under CC BY-SA 4.0 by MaxMind. Full EULA:
#   https://www.maxmind.com/en/geolite2/eula
#   This mirror/republish is via sapics/ip-location-db, MIT-licensed
#   tooling around GeoLite2-licensed DATA — see that repo's README for
#   the exact split between the two licences.
#
# Files are written into $DEST_DIR using the SAME filenames
# src/lib/geo/geoip.ts already hardcodes (GeoLite2-Country.mmdb /
# GeoLite2-ASN.mmdb) — zero code changes needed in that module, only
# which service populates the shared `geoip_data` volume changes.
#
# Runs as a long-lived poll loop (same style as
# pbx_configs/openvpn/bridge-watch.sh): fetch once at startup, then sleep
# and re-fetch on an interval. sapics updates these files twice weekly;
# daily is a safe, low-overhead cadence that never leaves them stale for
# more than a few hours past a real upstream update.
set -eu

DEST_DIR="${DEST_DIR:-/geoip}"
POLL_INTERVAL_SECS="${POLL_INTERVAL_SECS:-86400}"

COUNTRY_URL="https://github.com/sapics/ip-location-db/releases/download/latest/geolite2-country.mmdb"
ASN_URL="https://github.com/sapics/ip-location-db/releases/download/latest/geolite2-asn.mmdb"

log() { echo "[geoip-refresh] $(date -u +%FT%TZ) $*"; }

fetch_one() {
  url="$1"
  dest_name="$2"
  tmp="${DEST_DIR}/.${dest_name}.tmp"

  if curl -fsSL --retry 3 --retry-delay 5 -o "${tmp}" "${url}"; then
    # Atomic within the volume: rename, don't stream directly over the
    # live file, so a reader mid-open (geoip.ts's mtime-check reload)
    # never sees a half-written mmdb.
    mv -f "${tmp}" "${DEST_DIR}/${dest_name}"
    log "refreshed ${dest_name}"
  else
    rm -f "${tmp}"
    log "WARNING: failed to fetch ${dest_name} from ${url} — leaving existing file (if any) in place"
  fi
}

mkdir -p "${DEST_DIR}"
log "starting, refreshing every ${POLL_INTERVAL_SECS}s into ${DEST_DIR}"

while true; do
  fetch_one "${COUNTRY_URL}" "GeoLite2-Country.mmdb"
  fetch_one "${ASN_URL}" "GeoLite2-ASN.mmdb"
  sleep "${POLL_INTERVAL_SECS}"
done
