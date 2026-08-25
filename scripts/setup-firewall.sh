#!/usr/bin/env bash
# Algo PBX — host firewall bootstrap (ufw).
#
# Applies the port matrix from DEPLOYMENT.md §1. Run ONCE on the cloud VM
# after first boot, BEFORE exposing the VM publicly:
#
#   sudo bash scripts/setup-firewall.sh
#
# EDIT $SSH_PORT first if you do not use 22 — locking yourself out of a
# remote VM is the classic ufw accident.
#
# Deliberately NOT opened to the public internet:
#   5060/udp  — SIP; the Dinstar trunk is reached over the tailscale0
#               interface only (LLM.md §2 hard constraint)
#   5038/tcp  — AMI; reachable only from the Docker bridge subnet,
#               enforced by manager.conf's permit ACL
#   5432/tcp  — Postgres; published on loopback only by docker-compose.yml

set -euo pipefail

SSH_PORT="${SSH_PORT:-22}"
COTURN_RELAY_START=20001
COTURN_RELAY_END=30000
RTP_START=10000
RTP_END=20000

if [[ $EUID -ne 0 ]]; then echo "run as root (sudo)"; exit 1; fi
if ! command -v ufw >/dev/null; then apt-get update && apt-get install -y ufw; fi

ufw --force reset

# Base policy: deny all inbound, allow all outbound.
ufw default deny incoming
ufw default outgoing allow

# SSH — keep this correct or you lose the box.
ufw allow "${SSH_PORT}/tcp" comment 'SSH'

# Web app + reverse proxy.
ufw allow 80/tcp    comment 'HTTP -> HTTPS redirect / certbot HTTP-01'
ufw allow 443/tcp   comment 'Caddy web app'
ufw allow 443/udp   comment 'HTTP/3'

# Asterisk WSS signaling.
ufw allow 8089/tcp  comment 'Asterisk WSS signaling'

# Coturn listener + TLS listener.
ufw allow 3478/tcp  comment 'TURN TCP'
ufw allow 3478/udp  comment 'STUN/TURN UDP'
ufw allow 5349/tcp  comment 'TURN over TLS'

# Media ranges. Rate limiting does not apply to UDP media; use plain allows.
ufw allow "${RTP_START}:${RTP_END}/udp"        comment 'Asterisk RTP'
ufw allow "${COTURN_RELAY_START}:${COTURN_RELAY_END}/udp" comment 'Coturn relay'

# Tailscale interface: trust it for anything not explicitly allowed above
# (SIP 5060 to the Dinstar trunk arrives here via the subnet route).
ufw allow in on tailscale0 comment 'Tailscale mesh - full trust'

# Docker publishes ports by writing iptables rules DIRECTLY, bypassing ufw's
# INPUT chain. Published ports in docker-compose.yml are already safe
# (5432 bound to 127.0.0.1; web is fronted by Caddy), but this makes the
# guarantee explicit and future publishes must go through review:
# DOCKER-USER is evaluated before Docker's own NAT rules.
iptables -I DOCKER-USER -i eth0 -p tcp --dport 5432 -j REJECT 2>/dev/null || true
iptables -I DOCKER-USER -i eth0 -p tcp --dport 5038 -j REJECT 2>/dev/null || true

ufw --force enable
ufw status verbose

echo
echo "Firewall active. Verify from ANOTHER machine that SSH still works"
echo "before closing your current session."
