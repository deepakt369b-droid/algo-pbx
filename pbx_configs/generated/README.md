# pbx_configs/generated/

Files here are written by code (either at deploy time or live from the
admin panel), never hand-edited — same convention as `pjsip_dynamic.conf`/
`voicemail_dynamic.conf` one level up.

- `caddy.env` — `VM_PUBLIC_DOMAIN` + `CLOUDFLARE_API_TOKEN` for the `caddy`
  service's Cloudflare DNS-01 automatic HTTPS (Loop C4). Bootstrapped once
  by `scripts/render-caddy-env.sh` from `.env`'s `VM_PUBLIC_DOMAIN` (so a
  fresh deploy behaves exactly as before — no admin action required to
  boot). From then on, `/admin/settings`' "Domain & TLS" section can
  update it live: `POST /api/admin/settings/domain/apply` rewrites this
  file and asks the `cert-sync` service to recreate the `caddy` container
  so the new value actually takes effect (Docker only reads `env_file` at
  container-create time, not on a plain restart — see `cert-sync`'s own
  script for why it runs `docker compose up -d`, not `docker restart`).

Contains a real secret (the Cloudflare API token) once configured —
gitignored, never committed. `caddy.env` itself does not exist until
`scripts/render-caddy-env.sh` runs; `docker-compose.yml`'s `env_file:
required: false` on the `caddy` service means Compose does not fail if it's
still missing, but Caddy's own `{$VM_PUBLIC_DOMAIN}` substitution will be
empty until it does.
