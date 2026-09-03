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

# Dinstar gateway syslog forwarding (gateway-syslog-listener service).
# Scoped to the whole Tailscale CGNAT range (100.64.0.0/10), not just the
# gateway's own 192.168.11.0/24 LAN address: the gateway reaches the VPS
# over a Tailscale SUBNET ROUTE (a machine on 192.168.11.0/24 advertising
# that route into the tailnet), and the source IP a forwarded packet
# actually carries when it arrives — the subnet router's own tailnet IP,
# or the gateway's real LAN IP, or something SNAT'd in between — is not
# yet confirmed (no real traffic has been observed arriving as of this
# writing). Narrow this to the gateway's actual observed source IP once
# real syslog traffic is captured and that's known for certain.
ufw allow from 100.64.0.0/10 to any port 5514 proto udp comment 'Dinstar gateway syslog'

# AMI (5038) and the web app's route to Postgres both cross from a Docker
# BRIDGE container to a directly-bound HOST socket (asterisk/postgres run
# outside the bridge or publish to loopback — see manager.conf's own ACL
# comment for the cdr-listener/web -> AMI direction specifically). That
# path goes through ufw's normal INPUT chain like any other host-bound
# connection — it is NOT covered by the DOCKER-USER rules below (those
# guard the OPPOSITE direction: external traffic reaching a
# Docker-published port). Real bug found deploying Loop A1 (first time
# Asterisk ever actually ran): with no rule here, ufw's default-deny-
# incoming policy silently dropped every AMI connection attempt from
# cdr-listener/web, surfacing as a slow, opaque ETIMEDOUT — not an
# obvious "connection refused." 172.16.0.0/12 matches manager.conf's own
# `permit` ACL range exactly — this is a second, independent layer
# (network-level) around the same already-narrow (application-level)
# trust boundary, not a wider one.
ufw allow from 172.16.0.0/12 to any port 5038 proto tcp comment 'AMI - Docker bridge only'

# Docker publishes ports by writing iptables rules DIRECTLY, bypassing ufw's
# INPUT chain. Published ports in docker-compose.yml are already safe
# (5432 bound to 127.0.0.1; web is fronted by Caddy), but this makes the
# guarantee explicit and future publishes must go through review:
# DOCKER-USER is evaluated before Docker's own NAT rules.
iptables -I DOCKER-USER -i eth0 -p tcp --dport 5432 -j REJECT 2>/dev/null || true
iptables -I DOCKER-USER -i eth0 -p tcp --dport 5038 -j REJECT 2>/dev/null || true
# Loop B0: belt-and-braces even though docker-compose.yml now binds web to
# 127.0.0.1 — if a future compose edit drops the bind address, this keeps
# the raw Next.js app (cleartext, bypasses Caddy/TLS) off the public
# interface. Port 3000 must only ever be reached via Caddy on 443.
iptables -I DOCKER-USER -i eth0 -p tcp --dport 3000 -j REJECT 2>/dev/null || true

ufw --force enable
ufw status verbose

echo
echo "Firewall active. Verify from ANOTHER machine that SSH still works"
echo "before closing your current session."
