# OpenWA — vendored WhatsApp engine

Upstream: https://github.com/rmyndharis/OpenWA (MIT license, actively
maintained). Pinned commit: `99874630c9d386340d71f191b310c8bd8aa52ee3`.

## Why OpenWA and not evolution-go

`evolution-go` (https://github.com/evolution-foundation/evolution-go) was
the other candidate — Go, uses the `whatsmeow` (MPL-2.0) protocol library,
lower per-session RAM. It was rejected for this project because:

- v2.4+ requires a **phone-home license activation** on first boot;
  endpoints return `503` until activated. That is a runtime dependency on
  an external service we don't control, for a call-center system that
  needs to keep working if that service is slow, down, or changes terms.
- GitHub classifies its license as `NOASSERTION` — Apache 2.0 base plus
  added brand-protection clauses (logo/copyright preservation, a mandatory
  "usage notification"). Legally forkable, but not a clean MIT-style base
  to build production infrastructure on.
- 102 open issues, no push since 2026-07-03 at the time this was evaluated.

OpenWA is MIT, has no activation gate, and is materially better maintained.
If evolution-go's NATS/RabbitMQ event fan-out (instead of HTTP webhooks)
ever becomes worth having, that's an architectural pattern we can adopt
independently — see `src/lib/messaging/provider.ts`'s `MessageProvider`
interface, which is deliberately transport-agnostic for exactly this
reason.

## How this is built

OpenWA is a full NestJS application with its own bundled dashboard SPA,
its own Postgres/SQLite schema, and a real multi-stage Dockerfile (Chromium
for the whatsapp-web.js engine, ffmpeg, a pinned Postgres client for its
backup/restore scripts, several backport patches applied at image-build
time). Re-deriving that by hand in a from-scratch Dockerfile is exactly
what the previous version of this directory did — and it was wrong: it
called invented API paths, dropped the entrypoint script, and never
actually built. Reimplementing upstream's own build is the wrong tradeoff
for the same reason it was the first time: it goes stale the moment
anything about that build changes upstream.

Instead:

- **`prepare.sh`** clones upstream at the **pinned commit** into
  `vendor/openwa/upstream/` (gitignored — this is a fetch step, not
  something committed). Run it before the first build, and again whenever
  the pinned commit changes:
  ```
  bash vendor/openwa/prepare.sh
  ```
  It refuses to silently drift: it verifies the checked-out `HEAD` matches
  the pinned SHA exactly and fails loudly otherwise.
- `docker-compose.yml`'s `openwa` service builds `context: ./vendor/openwa/upstream`
  directly — i.e. **upstream's own `Dockerfile`**, unmodified. All of the
  configuration this deployment needs (database, engine, session storage,
  SSRF allowlist) is supplied as environment variables and a named volume
  on the compose service, not by patching the image.
- **`initdb/01-create-openwa-db.sql`** — mounted into the `postgres`
  service's `/docker-entrypoint-initdb.d/`, gives OpenWA its own database
  (`openwa`) on first Postgres init, since upstream takes a whole
  `DATABASE_NAME`, not a `?schema=` URL fragment.

Everything Algo PBX-specific — pairing UI, per-agent conversation
assignment, the OTP-lock/admin-approval workflow, provider fallback to
Meta Cloud API — lives in `algo-pbx-frontend/src/lib/messaging/` and talks
to this container **only** over its REST API (`/api/sessions/...`,
`X-API-Key` auth) and per-session webhooks it registers at pairing time.
We do not modify OpenWA's own source. If a change to OpenWA itself is ever
needed, fork it properly (a real fork on GitHub, re-point `prepare.sh` at
our fork + our own pinned commit) rather than patching the cloned tree
in-place — keeps upstream security updates mergeable.

## Capacity — one sidecar holds all four SIMs

This deployment pairs one WhatsApp number per Dinstar GSM port (up to
four `WaInstance`s). They all live as separate sessions inside **one**
OpenWA container — that is its native multi-session design, not a
workaround:

- With the default `ENGINE_TYPE=baileys`, each session costs roughly
  **30–80 MB RAM** (no browser process; baileys speaks the WhatsApp
  protocol directly over WebSocket). Four sessions ≈ 120–320 MB, well
  inside the compose service's 1 GB limit.
- The heavier `whatsapp-web.js` engine (~300–500 MB/session, runs
  headless Chromium per session) would NOT fit four sessions on a modest
  VM comfortably — one more reason baileys is the default here.

**Do not add Kubernetes, a second sidecar, or per-SIM containers for
capacity reasons.** Docker Compose restart policies + healthchecks already
cover recovery on this single-VM deployment; an orchestrator would add
operational surface for zero gain at this scale.

The one legitimate reason to run a *second* OpenWA service later is ban-
risk isolation (e.g. dedicating a separate engine instance to OTP traffic).
That would require giving `WaInstance` a per-instance sidecar URL (today
`OPENWA_BASE_URL` points the whole app at one sidecar). Cross that bridge
only if ban rates in practice demand it.

## Before first build

1. Run `bash vendor/openwa/prepare.sh`.
2. Generate `OPENWA_API_MASTER_KEY` and `OPENWA_WEBHOOK_SECRET`
   (`openssl rand -hex 32` each, both >= 32 chars — OpenWA refuses to boot
   in production with a shorter or default `API_MASTER_KEY`) and set them
   in `.env`. `OPENWA_API_MASTER_KEY` is shared: `web`'s `OPENWA_API_KEY`
   and the `openwa` service's `API_MASTER_KEY` are both set from it, so
   the app and the sidecar always agree on the key.
3. `docker compose build openwa && docker compose up -d openwa`.
4. Verify from inside `web`:
   ```
   docker compose exec web sh -c 'curl -s -H "X-API-Key: $OPENWA_API_KEY" http://openwa:2785/api/sessions'
   docker compose exec web sh -c 'curl -sf http://openwa:2785/api/health/ready'
   ```
5. Re-pinning later: edit `OPENWA_COMMIT` in `prepare.sh`, re-run it, then
   `docker compose build openwa`. Re-review and re-pin deliberately, not
   automatically.
