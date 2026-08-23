#!/usr/bin/env bash
# Run on the UAE local office PC that is on the same LAN as the Dinstar
# GSM gateway. Advertises that LAN as a Tailscale subnet route so the cloud
# VM can reach the Dinstar box without opening any public router port.
# See ALGO_PBX_MASTER_DOC.md §6.3 for the full explanation.
set -euo pipefail

SUBNET="${1:-192.168.1.0/24}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale is not installed on this machine. Install it first: https://tailscale.com/download" >&2
  exit 1
fi

echo "Enabling IPv4 packet forwarding..."
if ! grep -qxF 'net.ipv4.ip_forward = 1' /etc/sysctl.d/99-tailscale.conf 2>/dev/null; then
  echo 'net.ipv4.ip_forward = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf >/dev/null
fi
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf

echo "Authenticating and advertising subnet ${SUBNET}..."
sudo tailscale up --advertise-routes="${SUBNET}"

cat <<EOF

Next manual step (cannot be scripted): open https://login.tailscale.com,
go to Machines, find this device, and APPROVE the advertised route
${SUBNET} under "Edit route settings".

Then run scripts/setup-tailscale-cloud.sh on the Ubuntu cloud VM.
EOF
