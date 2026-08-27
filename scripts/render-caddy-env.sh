#!/usr/bin/env bash
# Algo PBX — bootstrap pbx_configs/generated/{caddy.env,Caddyfile} from
# .env and the repo-root Caddyfile template.
#
# Run ONCE on the deployment host before the first `docker compose up`,
# from the repo root:
#
#   bash scripts/render-caddy-env.sh
#
# Why this exists: the `caddy` service (Loop C4, domain-connect automation)
# reads VM_PUBLIC_DOMAIN/CLOUDFLARE_API_TOKEN from
# pbx_configs/generated/caddy.env instead of docker-compose.yml's own
# `environment:` block, so that /admin/settings' "Domain & TLS" section can
# rewrite it later and have a container recreate (via the `cert-sync`
# service) actually pick the change up — Docker only reads `env_file` at
# container-CREATE time, not on every restart, so ANY mechanism for
# changing these values after first boot needs them to live in a file, not
# a value baked into docker-compose.yml's `environment:` block. This
# script's only job is to seed that file from .env's EXISTING
# VM_PUBLIC_DOMAIN the first time, so a fresh deploy needs no admin-panel
# action to boot — exactly the behavior before this feature existed.
#
# Safe to re-run: refuses to overwrite an existing file (an admin may have
# already configured a different domain/token via /admin/settings since
# the file was created — this script must never clobber that).

set -euo pipefail
cd "$(dirname "$0")/.."

ENV_OUT=pbx_configs/generated/caddy.env
CADDYFILE_OUT=pbx_configs/generated/Caddyfile

mkdir -p pbx_configs/generated

if [[ -f "$ENV_OUT" ]]; then
  echo "render-caddy-env: $ENV_OUT already exists — leaving it alone."
else
  if [[ ! -f .env ]]; then
    echo "render-caddy-env: no .env found — copy .env.example to .env and fill it in first." >&2
    exit 1
  fi
  DOMAIN="$(grep -E '^VM_PUBLIC_DOMAIN=' .env | head -1 | cut -d= -f2-)"
  if [[ -z "$DOMAIN" ]]; then
    echo "render-caddy-env: VM_PUBLIC_DOMAIN is not set in .env — set it first." >&2
    exit 1
  fi
  cat > "$ENV_OUT" <<EOF
VM_PUBLIC_DOMAIN=$DOMAIN
# CLOUDFLARE_API_TOKEN left blank — Caddyfile (generated, see below)
# stays plain-HTTP-only until this is set. Configure both in
# /admin/settings under "Domain & TLS" (Save, then Connect domain), or
# set it here by hand and re-run
# \`docker compose up -d --no-deps caddy\` yourself.
CLOUDFLARE_API_TOKEN=
EOF
  echo "render-caddy-env: wrote $ENV_OUT for domain $DOMAIN."
fi

# Seeded from the repo-root Caddyfile (a safe, always-parses plain-HTTP
# template — see its own header comment for why it's not the file Caddy
# actually mounts). POST /api/admin/settings/domain/apply overwrites THIS
# file with the full HTTPS+Cloudflare version once a real domain/token
# are configured — never touches the git-tracked template.
if [[ -f "$CADDYFILE_OUT" ]]; then
  echo "render-caddy-env: $CADDYFILE_OUT already exists — leaving it alone."
else
  cp Caddyfile "$CADDYFILE_OUT"
  echo "render-caddy-env: seeded $CADDYFILE_OUT from the repo-root template (plain HTTP only until a domain is connected)."
fi
