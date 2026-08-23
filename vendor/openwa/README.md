# OpenWA — vendored WhatsApp engine

Upstream: https://github.com/rmyndharis/OpenWA (MIT license, ~13k stars,
actively maintained — pushed within the last day as of this writing).

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

## Why this directory is (almost) empty

OpenWA is a full NestJS application (~18MB source, its own `node_modules`,
its own Postgres schema, a bundled React dashboard). Vendoring the entire
upstream source tree into this repo's git history is the wrong tradeoff —
it would need to track upstream security fixes forever, and 99% of it is
code we never touch. Instead this directory holds only the integration
surface:

- `Dockerfile` — builds the actual OpenWA image by cloning the upstream
  repo at a **pinned commit** (not `main` — pin it explicitly so a
  `docker compose build` next month doesn't silently pull in unreviewed
  upstream changes) and layering our config on top.
- This README.

Everything Algo PBX-specific — pairing UI, per-agent conversation
assignment, the OTP-lock/admin-approval workflow, provider fallback to
Meta Cloud API — lives in `algo-pbx-frontend/src/lib/messaging/` and talks
to this container **only** over its REST API and webhooks
(`docker-compose.yml`'s `openwa` service, reached at `OPENWA_BASE_URL`
from inside `algo-net`; never published to a host port). We do not modify
OpenWA's own source. If a change to OpenWA itself is ever needed, fork it
properly (a real fork on GitHub, our own pinned commit here) rather than
patching in-place — keeps upstream security updates mergeable.

## Before first build

1. Pick and record the upstream commit SHA to pin (`git ls-remote
   https://github.com/rmyndharis/OpenWA main` and copy the SHA into the
   `Dockerfile`'s `OPENWA_COMMIT` build arg default below). Re-review and
   re-pin deliberately, not automatically, when bumping.
2. Confirm OpenWA's current Postgres schema requirements against the
   `openwa` schema created for it in the shared `algopbx_db` database (see
   `docker-compose.yml`'s `DATABASE_URL` for the `openwa` service) — it may
   expect its own dedicated database/user instead; check upstream docs at
   build time, this was not verified against a live OpenWA instance.
3. Generate `OPENWA_API_KEY` and `OPENWA_WEBHOOK_SECRET` (`openssl rand
   -hex 32` each) and set them in `.env` — see `.env.example`.
