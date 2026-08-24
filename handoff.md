# Handoff — WhatsApp/Dinstar/agent-provisioning remediation + MUI shell

Last updated: 2026-08-23, latest session. This file tracks what was done and
what still needs a human decision. Supersedes the prior "trial readiness"
handoff — see `LLM.md` §11 for the full changelog this summarizes.

## What was asked

Live testing found WhatsApp pairing completely non-functional (stale,
undeletable, no QR ever shown), Rooms static, Dinstar setup entirely manual
and non-technical-operator-hostile, admin account creation invite-only with
no working password path, and the UI "looking basic/vibe-coded." Asked for a
full production-readiness pass: fix WhatsApp pairing, add admin-created
agents with password+extension+SIM-port in one step, a Dinstar setup
wizard, a system-readiness page, and a SaaSable-styled MUI UI overhaul with
a ShaderGradient landing page — executed continuously across all phases,
flags reserved for the end.

## Done — verified live (Docker build → running container → real browser/HTTP session, not just typechecked)

- **WhatsApp/OpenWA pairing rebuilt from scratch.** The entire previous
  adapter (`openwa-provider.ts`) called an invented REST API
  (`/api/instances/...`) that never matched any real OpenWA server. Rewrote
  against the real upstream (github.com/rmyndharis/OpenWA, MIT, pinned SHA
  `99874630c9d386340d71f191b310c8bd8aa52ee3`): new `openwa-client.ts`/
  `openwa-types.ts` against `/api/sessions/...`, `X-API-Key` auth.
  **Verified end-to-end through the real running stack**: created an
  instance → real OpenWA session → requested a pairing code → got back a
  real 8-character code (`71JPMZMB`) and a real base64 QR PNG from the
  live sidecar → deleted the instance, sidecar session cleaned up.
- **OpenWA sidecar itself rebuilt.** `vendor/openwa/prepare.sh` fetches the
  pinned commit (was never actually building before — old Dockerfile
  cloned unpinned `main` and called the wrong image entrypoint). New
  `docker-compose.yml` `openwa` service: correct env vars, a persistent
  data volume (previously absent — every pairing was destroyed on
  restart), `SSRF_ALLOWED_HOSTS` so webhook registration to `web` isn't
  blocked by the sidecar's own SSRF guard.
- **Agent provisioning.** `POST /api/admin/users` now supports a direct
  password + phone + extension (auto or manual) + SIM-port path, not just
  email invite. One agent per SIM port (`WaInstance.assignedUserId`).
  Queue membership is now dynamic (`src/lib/queue-membership.ts`, AMI
  `QueueAdd`/`QueueRemove`/`QueuePause`) — `queues.conf` no longer
  hardcodes a static member, which meant a newly provisioned agent could
  never receive an inbound call. Admin-verified phones exempt login 2FA
  (an agent created this way can log in before any WhatsApp instance is
  connected). **Verified**: created a dummy agent through the real API,
  it got a real generated PJSIP secret and config file, and could log in
  immediately.
- **Rooms** — create/rename/delete with real error handling (409 on
  duplicate name, was a raw 500), plus a live `/api/admin/rooms/[id]/activity`
  endpoint (member presence, live call state, WhatsApp identity,
  conversation previews). Verified via browser.
- **`/admin/system`** — new readiness page, 9 live checks (Postgres,
  settings encryption, Asterisk AMI, OpenWA, WhatsApp instances, Dinstar,
  queue membership, TURN, email, OTP), each with a hint and a link to the
  page that fixes it. Verified live — correctly shows AMI/Dinstar red in
  this dev environment (no Asterisk here) and OpenWA/Postgres green.
- **Dinstar setup wizard** (`/admin/dinstar`) — subnet discovery hard-bounded
  to RFC1918 + CGNAT/Tailscale ranges (refuses public CIDRs outright),
  credential probing tries both known firmware auth styles and persists
  which one worked (`DINSTAR_AUTH_STYLE`), writes `pbx_configs/pjsip_dinstar.conf`
  (previously the IP was hardcoded in a read-only-mounted file, requiring
  SSH to change) and verifies the AMI reload actually took effect rather
  than assuming it did.
- **MUI v9 + Emotion theme, admin shell, landing page.** Sidebar (grouped
  Operations/Messaging/Configuration/Audit, active-route highlight),
  topbar with a live system-health pill and theme toggle, and a landing
  page with a `@shadergradient/react` animated WebGL background. Verified
  via real Docker build + browser screenshots. **Not done**: the
  remaining ~14 admin pages still use the original Tailwind styling
  inside the new MUI shell — only the shell, landing, Dinstar, System,
  Rooms, Users, and WhatsApp pages got real UI attention this session.
- Assorted Phase 10 fixes: sign-ins mark-seen race condition, DNC page
  confirmation/feedback, settings page missing-catch/stale-test-result
  bugs, agent-facing WhatsApp connection badge (`GET /api/me/whatsapp`,
  three separate old comments claimed this existed and it never did),
  hardware-extension PJSIP context pointed at an undefined
  `from-internal` context (now `from-agent`).

## Non-obvious infrastructure bugs found and fixed (pre-existing, not part of the original ask — discovered because this was the first time anyone actually built and ran the Docker image end to end)

- **`algo-pbx-frontend/package-lock.json` never existed.** `docker compose
  build web` had never succeeded, ever, before this session — `npm ci`
  requires a lockfile. Generated one (now committed).
- **`prisma migrate deploy` was broken in the runner image** — the
  standalone Next.js output never copies `node_modules/.bin`, so `npx
  prisma` resolved to nothing. Fixed by invoking the CLI's entry file
  directly with `node`.
- **Prisma's OpenSSL auto-detection is broken on Alpine 3.23** (the
  current `node:20-alpine` base) — both the schema engine (migrations)
  and the query engine (every DB call the app makes) silently picked an
  `openssl-1.1.x` binary that can't load on an OpenSSL-3-only image.
  Fixed with three explicit pins in the Dockerfile/schema
  (`PRISMA_CLI_BINARY_TARGETS`, `binaryTargets` in `schema.prisma`,
  `PRISMA_SCHEMA_ENGINE_BINARY`, `PRISMA_QUERY_ENGINE_LIBRARY`) — without
  this, **every single database call in the deployed app would have
  failed**, not just migrations.
- **`@mui/material-nextjs`'s `AppRouterCacheProvider` is broken against
  `@mui/material@9.x`** — crashes SSR page-data collection with
  `unstable_createUseMediaQuery is not a function`. Replaced with a
  hand-written Emotion cache provider (MUI's own documented manual
  pattern) — do not reintroduce that package.
- `next/dynamic({ssr:false})` does **not** work inside a Next 14 App
  Router Server Component — it silently still traces the module into the
  server bundle. The landing page (and any future page using a
  client-only heavy dependency like three.js) must be `"use client"`
  itself, not rely on `ssr:false` alone.
- Confirmed while debugging: **piping `docker compose build` through
  `tail` masks the real exit code** (`tail` always exits 0) — several
  rebuilds during this session were incorrectly reported as successful.
  Always capture with `> file 2>&1; echo $?` or grep the log for `ERROR:`/
  `failed to solve`.

## Still open / next steps

1. **Full MUI conversion of the remaining ~14 admin routes** (CDR,
   Extensions, Queues, Reports, Sign-Ins, DNC, SMS, Settings still use the
   original Tailwind glass-card styling).
2. **The exhaustive per-page functional gaps from this session's own
   audit are mostly still open**: `/admin/queues` has zero mutations
   (titled "Queue & Ring Group Manager", manages nothing); CDR has no
   filter UI despite the API supporting it; `voicemailPin` is generated on
   both provisioning paths and displayed on neither; `/admin/sms`
   advertises an inbox that doesn't exist; `/admin/reports` labels rolling
   24h/7d/30d windows as "Today/This week/This month"; 9 API routes (API
   keys, webhook subscriptions, MCP approvals) have no admin UI at all.
   Full inventory available on request — not re-listed here to keep this
   file scannable.
3. **ESLint is scaffolded but not installed** — `.eslintrc.json` exists,
   `npm install --save-dev eslint eslint-config-next` was never run.
4. **Live call functionality was not verified.** Asterisk requires
   `network_mode: host`, which does not work on this Windows/Docker
   Desktop machine. All call-related code (queue membership, PJSIP
   context fix, dummy-agent creation) was built and typecheck/build
   verified, but never exercised against a real Asterisk. This is the
   single most important thing to verify next, on the real Linux
   deployment VM: create a dummy agent, place an outbound call through
   the Dinstar trunk, receive an inbound call via `support_queue`, and
   confirm hold/transfer/supervisor-intervention all work.
5. **`alibaba/open-code-review` was not actually run** — it needs a
   global npm install plus either an LLM API key or its delegation mode
   set up interactively. This session's own repeated codebase audits
   (via Explore subagents) served as a substitute; a real `ocr scan` pass
   is still worth running once the tool is set up.
6. Secrets still `change-me` placeholders: `RESEND_API_KEY`,
   `DINSTAR_SMS_PASSWORD` (real device credentials, can't be generated),
   `CRM_WEBHOOK_SECRET` (optional, not on the critical path).
7. A `verify-admin@algopbx.local` test account (password `VerifyPass123!`)
   was created for this session's verification and left in place —
   delete it if not wanted, or keep it as a working spare admin login.

## Key files touched this session

Very broad — 74 files changed/added. Highlights not already covered by
LLM.md's own detailed per-file logs in prior sections:
`vendor/openwa/{prepare.sh,README.md,initdb/}` (Dockerfile deleted, now
builds from upstream's own via `prepare.sh`), `algo-pbx-frontend/Dockerfile`
(Prisma engine pins), `algo-pbx-frontend/prisma/schema.prisma` +new migration,
`src/lib/{messaging/openwa-client,messaging/openwa-types,messaging/openwa-webhook-auth,
queue-membership,dinstar-discovery,dinstar-config,dinstar-provision,client/api}.ts`,
`src/theme/*`, `src/components/{admin-shell,landing,whatsapp}/*`,
`src/app/admin/{dinstar,system}/page.tsx`, `src/app/api/admin/{dinstar,system}/**`,
`pbx_configs/{pjsip_dinstar.conf,pjsip.conf,pjsip-base.conf,queues.conf,pjsip_dynamic.conf}`.

Full technical changelog: `LLM.md` §11.
