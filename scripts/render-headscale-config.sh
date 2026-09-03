#!/usr/bin/env bash
# Algo PBX — render pbx_configs/headscale/generated/config.yaml from
# pbx_configs/headscale/config.yaml.template and .env's VM_PUBLIC_DOMAIN.
#
# Run ONCE on the deployment host before the first
# `docker compose up -d headscale`, from the repo root:
#
#   bash scripts/render-headscale-config.sh
#
# Why this exists (corrects the original design — see git history on
# Dockerfile.headscale, removed): the official headscale/headscale image is
# a `ko`-built distroless image with NO shell and NO package manager (no
# /bin/sh, confirmed live: `apk add` and even `ls` fail with "no such file
# or directory") — a baked-in entrypoint script that runs envsubst at
# container start, the original plan, cannot work in that image at all.
# This mirrors render-caddy-env.sh's own pattern instead: substitute on the
# HOST, bind-mount the resulting static file read-only into the stock
# image — no custom Dockerfile, no shell needed inside the container.
#
# Safe to re-run: refuses to overwrite an existing rendered file (same
# convention as render-caddy-env.sh) — delete
# pbx_configs/headscale/generated/config.yaml by hand first if the domain
# genuinely changed and you want to re-render, then recreate the
# `headscale` container to pick it up.

set -euo pipefail
cd "$(dirname "$0")/.."

TEMPLATE=pbx_configs/headscale/config.yaml.template
OUT_DIR=pbx_configs/headscale/generated
OUT_FILE="$OUT_DIR/config.yaml"

mkdir -p "$OUT_DIR"

if [[ -f "$OUT_FILE" ]]; then
  echo "render-headscale-config: $OUT_FILE already exists — leaving it alone."
  exit 0
fi

if [[ ! -f .env ]]; then
  echo "render-headscale-config: no .env found — copy .env.example to .env and fill it in first." >&2
  exit 1
fi

DOMAIN="$(grep -E '^VM_PUBLIC_DOMAIN=' .env | head -1 | cut -d= -f2-)"
if [[ -z "$DOMAIN" ]]; then
  echo "render-headscale-config: VM_PUBLIC_DOMAIN is not set in .env — set it first." >&2
  exit 1
fi

if ! command -v envsubst >/dev/null 2>&1; then
  echo "render-headscale-config: envsubst not found — install gettext-base (Debian/Ubuntu) or gettext (RHEL/Alpine) on the deployment HOST (not inside any container)." >&2
  exit 1
fi

VM_PUBLIC_DOMAIN="$DOMAIN" envsubst '${VM_PUBLIC_DOMAIN}' < "$TEMPLATE" > "$OUT_FILE"
echo "render-headscale-config: wrote $OUT_FILE for domain $DOMAIN (server_url: https://vpn.$DOMAIN)."
echo "render-headscale-config: run 'docker compose up -d headscale' next."
