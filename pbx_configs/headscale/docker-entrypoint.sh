#!/bin/sh
# Substitutes VM_PUBLIC_DOMAIN (passed as an environment variable on the
# headscale service, same value the domain/apply route resolves for
# Caddy's own site block) into config.yaml.template, then hands off to
# whatever CMD this container was started with. Re-runs on every
# container start/recreate, so a domain change just needs the container
# recreated (same mechanism cert-sync already uses to recreate `caddy`
# after a Caddyfile rewrite) — no separate "apply" step for headscale
# itself.
set -e

if [ -z "$VM_PUBLIC_DOMAIN" ]; then
  echo "docker-entrypoint-headscale.sh: VM_PUBLIC_DOMAIN is not set. Refusing to start with an unsubstituted config." >&2
  exit 1
fi

envsubst '${VM_PUBLIC_DOMAIN}' < /etc/headscale/config.yaml.template > /etc/headscale/config.yaml

exec "$@"
