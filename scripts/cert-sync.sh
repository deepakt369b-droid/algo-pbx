#!/bin/sh
# Algo PBX — cert-sync: bridges Caddy's automatic Let's Encrypt cert
# (Loop C4) to the two other services that need the same real cert but
# can't read Caddy's own ACME storage format: Asterisk (WSS) and Coturn
# (TLS), both of which read a flat fullchain.pem/privkey.pem from
# pbx_configs/keys/ — the same path a manual certbot run used to populate.
# Also recreates the `caddy` container when /admin/settings' "Domain &
# TLS" section rewrites pbx_configs/generated/caddy.env, since Docker only
# reads env_file contents at container-CREATE time, never on a plain
# restart — a `docker restart` here would silently keep running with the
# OLD domain/token forever.
#
# DOCKER-SOCKET SUBTLETY, read before touching this file: this container
# only has a CLIENT (the docker/compose CLI) talking to the HOST's real
# dockerd over the mounted socket. `docker compose up -d --no-deps <svc>`
# issued from in here is executed by that HOST daemon, which knows nothing
# about this container's own filesystem — a build `context: .` or a bind
# mount `./Caddyfile:...` in docker-compose.yml must resolve to a path
# THE HOST can see, not /workspace (this container's own bind-mount of
# the repo, kept read-only here only for convenience/debugging, NEVER
# passed to `docker compose` as the project directory). The correct host
# path is discovered by asking the daemon what it mounted at /workspace
# FOR THIS CONTAINER — `docker inspect` on our own container id (which
# Docker conveniently sets as $HOSTNAME) returns that Source path.

set -eu

POLL_INTERVAL=30
DOMAIN="${VM_PUBLIC_DOMAIN:-}"
RESTART_MARKER=/generated/.caddy-restart-requested
KEYS_DIR=/keys
CADDY_CERT_ROOT=/caddy_data/caddy/certificates

log() { echo "cert-sync: $*"; }

host_project_dir() {
  docker inspect --format '{{ range .Mounts }}{{ if eq .Destination "/workspace" }}{{ .Source }}{{ end }}{{ end }}' "$HOSTNAME"
}

recreate_service() {
  service="$1"
  dir="$(host_project_dir)"
  if [ -z "$dir" ]; then
    log "could not determine the host project directory (docker inspect returned nothing for /workspace) — skipping recreate of $service"
    return 1
  fi
  # The `docker compose` CLI needs to open compose.yml/.env from a path
  # THIS container's own filesystem can resolve — it reads both locally
  # before it ever talks to the daemon over the socket, so passing the
  # bare discovered host path always 404s no matter how correctly it was
  # found (real bugs hit live, one after the other: "open
  # $dir/docker-compose.yml: no such file or directory", then the same
  # for $dir/.env even after pointing -f/--env-file at /workspace instead
  # — `up` specifically, unlike `config`, still insists on re-resolving
  # .env against --project-directory itself for its own bookkeeping).
  # Cheapest robust fix: make the discovered host path ALSO resolve
  # locally, by symlinking it to /workspace (this repo root's own
  # read-only bind-mount) inside cert-sync's own (writable) root
  # filesystem. That satisfies every path Compose might touch under
  # --project-directory, present or future, without chasing individual
  # flags one at a time.
  mkdir -p "$(dirname "$dir")" 2>/dev/null || true
  ln -sfn /workspace "$dir"
  # --force-recreate is required, not optional: only the CONTENT of a
  # bind-mounted file (Caddyfile) changed, not the compose SERVICE
  # DEFINITION itself, so plain `up -d` correctly (by Compose's own
  # config-hash-based idempotency model) treats this as "nothing to do"
  # and leaves the OLD process running against its already-open, now-
  # stale read of the file — confirmed live: caddy kept serving its
  # original boot-time config indefinitely across several marker-
  # triggered "recreates" that Compose silently no-op'd.
  log "recreating $service via docker compose (project dir: $dir)"
  docker compose --project-directory "$dir" -f "$dir/docker-compose.yml" up -d --no-deps --force-recreate "$service"
}

sync_cert() {
  [ -n "$DOMAIN" ] || return 0
  cert_dir=$(find "$CADDY_CERT_ROOT" -maxdepth 2 -type d -iname "$DOMAIN" 2>/dev/null | head -1)
  [ -n "$cert_dir" ] || return 0

  src_crt="$cert_dir/$DOMAIN.crt"
  src_key="$cert_dir/$DOMAIN.key"
  [ -f "$src_crt" ] && [ -f "$src_key" ] || return 0

  # Only act when Caddy's cert is actually newer than what's already in
  # the shared path — avoids restarting Asterisk/Coturn (which drops live
  # calls, see rtp_timeout handling) on every 30s poll tick.
  if [ -f "$KEYS_DIR/fullchain.pem" ] && [ "$KEYS_DIR/fullchain.pem" -nt "$src_crt" ]; then
    return 0
  fi

  log "new certificate detected for $DOMAIN — copying to $KEYS_DIR"
  cp "$src_crt" "$KEYS_DIR/fullchain.pem.new"
  cp "$src_key" "$KEYS_DIR/privkey.pem.new"
  mv "$KEYS_DIR/fullchain.pem.new" "$KEYS_DIR/fullchain.pem"
  mv "$KEYS_DIR/privkey.pem.new" "$KEYS_DIR/privkey.pem"

  log "restarting asterisk + coturn to pick up the new cert"
  # Plain restart suffices for these two (unlike caddy's env_file case
  # above) — they read the cert FILE fresh from the bind-mounted path on
  # every start; nothing about their own container env changed.
  docker restart algo-asterisk algo-coturn >/dev/null 2>&1 || log "restart of asterisk/coturn failed — check they're both running"
}

check_restart_marker() {
  [ -f "$RESTART_MARKER" ] || return 0
  log "restart marker present — recreating caddy"
  if recreate_service caddy; then
    rm -f "$RESTART_MARKER"
  else
    log "caddy recreate failed — leaving marker in place to retry next tick"
  fi
}

log "starting, polling every ${POLL_INTERVAL}s (domain: ${DOMAIN:-<unset>})"
while true; do
  check_restart_marker
  sync_cert
  sleep "$POLL_INTERVAL"
done
