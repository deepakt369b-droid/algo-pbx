#!/usr/bin/env bash
# Run on the Ubuntu cloud VM hosting Algo PBX. Accepts the subnet route
# advertised by scripts/setup-tailscale-uae-office.sh and verifies the
# Dinstar gateway is reachable before you rely on it in pjsip.conf.
# See ALGO_PBX_MASTER_DOC.md §6.3.
set -euo pipefail

DINSTAR_IP="${1:-192.168.1.50}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale is not installed on this machine. Install it first: https://tailscale.com/download" >&2
  exit 1
fi

echo "Accepting advertised Tailscale routes..."
if tailscale status >/dev/null 2>&1; then
  sudo tailscale set --accept-routes
else
  sudo tailscale up --accept-routes
fi

echo "Testing connectivity to Dinstar gateway at ${DINSTAR_IP}..."
if ping -c 3 "${DINSTAR_IP}"; then
  echo "Reachable. If pbx_configs/pjsip.conf's dinstar-aor contact IP differs from ${DINSTAR_IP}, update it."
else
  echo "NOT reachable — check that the route was approved in the Tailscale admin console" \
       "(https://login.tailscale.com -> Machines -> Edit Route Settings) before debugging further." >&2
  exit 1
fi
