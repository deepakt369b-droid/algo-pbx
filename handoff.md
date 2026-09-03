# Handoff — Apple-black redesign DONE + deployed. WhatsApp fix + admin Rooms fix DONE + deployed. S6 WAVs DONE + deployed. CRM/WhatsApp click-through DONE (live-call parts deferred). Deal↔contact linking fix + sidebar label fix DONE + deployed. Dinstar gateway syslog feature BUILT, all gates green, **live traffic still unconfirmed** (SIM ejected mid-diagnosis, see below). 33+ session commits on `main`, NONE pushed (H4), not committed this session either. Read "2026-09-03 session" below.

## ▶ "claude continue" — the remaining work, in order

Updated 2026-09-03. Items 1–4 below (deploy, WhatsApp session check, non-live-call
click-through, S6 WAVs) are **DONE** — see "2026-09-03 session" for what was
found. Live-call verification is explicitly deferred by the operator to a
later session. Remaining:

1. **Live-call verification (deferred by the operator to a later session)**:
   screen-pop on a real inbound call + the disposition prompt (Operator TODO
   old #3's last bullet), S6 announcement prompt heard on a real call
   (`docs/S6-real-call-test-plan.md`), Manager-merge/Phase MM
   (`LLM.md §30`, never live-call-tested).
2. ~~Fix the deal↔contact linking gap~~ — **DONE, deployed, live-verified**
   2026-09-03. See "2026-09-03 session" below.
3. **Ask the operator about `git push`** (H4) — 44+ unpushed commits, PUBLIC
   repo. Do not push without an explicit yes.
4. **Optional / infra decision** — if the operator wants unlimited
   WhatsApp-Web scroll-back, plan the `OPENWA_ENGINE=whatsapp-web.js` switch
   (RAM cost — see "To get WhatsApp EXACTLY like WhatsApp Web" below).
5. **SIM ports 2–4** — still blocked on the operator having phone numbers to
   scan. Pure ops.
6. **Dinstar gateway syslog — live traffic verification (deferred by the
   operator, SIM was ejected mid-diagnosis this session)**: everything is
   built and gated green (schema, parser, receiver sidecar, ingest route,
   retention, UI panel, alerts — see "2026-09-03 session, part 3" below),
   but **zero packets have ever been observed arriving** at the VPS despite
   the gateway's Diagnostic → Syslog config saving and persisting through a
   full reboot. Next session, once the operator has re-inserted a SIM:
   place a real call / trigger a real GSM event, confirm a `GatewayEvent`
   row lands, confirm the alert banner + email fire for a critical type,
   and widen `src/lib/dinstar/syslog-parse.ts`'s taxonomy against the real
   captured line shapes (it was built defensively, without ever having
   seen one — see that file's own header). Also still open: deploy (rebuild
   `web` + the new `syslog-listener` service, run the real
   `prisma migrate deploy` for `20260903180000_add_gateway_event` — the
   migration.sql in that directory is hand-authored, unverified DDL and
   must not be trusted without that real run naming the migration).

---

## 2026-09-03 session — deploy finished, S6 WAVs shipped, click-through pass

Full detail in `LLM.md §32`. Summary:

- **Deploy finished**: `b056448` (admin Rooms fix) built + deployed
  (user-approved prod restart), `algo-web`/`algo-cdr-listener` healthy,
  21/21 migrations clean.
- **WhatsApp**: `sim1` already `ready` post-restart, no action needed.
  `sim2-4` still unpaired (operator-blocked, unchanged).
- **S6 WAVs generated and deployed** (user-approved prod `asterisk`
  restart): both prompts via Piper TTS on the VPS (had to `apt install
  sox ffmpeg python3-venv` first, nothing was pre-installed), 8kHz mono
  16-bit, confirmed present in the container. **Not yet live-call-tested.**
- **Dinstar "Failing" on `/admin/system`**: confirmed pre-existing
  (stale `DINSTAR_SMS_USERNAME`/`PASSWORD` = `change-me`), not a
  regression from today's deploy.
- **Click-through pass** (non-live-call parts): CRM contact detail,
  Pipeline Kanban create+drag, WhatsApp thread (avatars, voice notes,
  images, infinite-scroll history), `/admin/rooms` activity+slide-over,
  and `/admin/reports` (both tabs) all confirmed working against real
  prod data. 390px mobile viewport check **not completed** (tooling
  issue, not a product bug — see `LLM.md §32`).
- **Real gap found and FIXED**: creating a deal had no way to link a
  contact in the UI, and deal cards weren't clickable. Fixed same session
  — see below.
- Test artifacts created during verification (a task on Sarath's contact,
  a test deal) were cleaned up: task marked complete, deal dragged out of
  "Lead" into "Qualified" (a drag into "Lost" didn't register — deal is
  still sitting in Qualified, clearly named "click-through test deal",
  harmless to leave or delete manually).

## 2026-09-03 session, part 2 — deal↔contact linking fix + sidebar label fix, deployed

Two operator-requested fixes, both deployed and live-verified against real
prod data (not just gate-green):

- **Deal↔contact linking.** `PipelineBoard`
  (`src/components/crm/pipeline-board.tsx`) gained a search-as-you-type
  `ContactPicker` (reuses the existing `/api/agent/crm/contacts` /
  `/api/admin/contacts` search endpoints — no new API surface for search).
  The "New deal" dialog now has a Contact field; `DealCard` is now
  click-to-open, showing an "Edit deal" dialog (Name/Value/Contact) backed
  by a new `PATCH .../deals/[id]` `contactId` field.
  `src/lib/crm/deals.ts`'s `patchDeal()` replaces the deal's single linked
  contact (delete then create `DealContact`, matching the create-time
  replace-not-append shape) when `contactId` is present in the patch,
  `null` unlinks. Live-verified end to end: linked Sarath to the existing
  test deal via the picker, confirmed the deal appears in Sarath's contact
  "Deals" section with `(primary)` and the correct stage; unlinked via the
  picker's ✕, confirmed it disappeared again — both checked against the
  DB directly (`DealContact` rows), not just the UI. One thing to know:
  this VPS is 2 vCPU and a PATCH round-trip briefly showed "Saving…"
  stuck for several seconds under concurrent load during testing — not a
  bug, just slow, resolved on its own (200 eventually).
- **Sidebar label fix.** `/agent/calls` (call history) was labeled just
  "Calls" in the sidebar (`src/components/agent-shell/agent-shell.tsx`),
  immediately under "Call" (the dialer) — easy to confuse. Renamed to
  "Call History", matching the page's own `<h1>Call history</h1>`.

Deployed: synced the 3 changed files, `docker compose build web` +
restart (user-approved both), `algo-web` healthy. Gates green before
deploy: typecheck, 357 tests, lint, build.

---

## 2026-09-03 session, part 3 — Dinstar gateway syslog (Remote Server) feature: built, NOT yet deployed/live-verified

Operator-requested: bring the Dinstar UC2000's own "Remote Server" (syslog)
feature into the app so gateway events (call rejects, port/registration
state, SIM issues, VPN/trunk state) stop requiring an SSH-and-scrape to
diagnose. Descoped to the current single-gateway-over-Tailscale
architecture (no site model, no OpenVPN — those are a separate future
task); plan expressed as a task graph (`~/.claude/plans/currently-we-need-
a-nifty-lightning.md`), reviewed by the operator against real repo/hardware
facts, then built.

**Live hardware diagnosis done directly (browser automation on the actual
gateway UI at `192.168.11.1`, plus VPS-side `tcpdump`), not guessed:**

- The gateway has TWO unrelated "remote server" surfaces. **Tools → Remote
  Server** is a generic feature with only Enable/Server URL/Server Port —
  no log level, no category toggles. The real one is **Diagnostic →
  Syslog**: Server Address, Server Port, a **Syslog Level** dropdown with
  standard RFC-style severities (EMERG/ALERT/CRIT/ERROR/WARNING/NOTICE/
  INFO/DEBUG — confirmed live, good evidence this is real syslog-shaped
  output), and per-category toggles (Signal/Media/System/Management
  Log/Send CDR). Configured live: server = the VPS's Tailscale IP
  (`100.64.32.115`), port `5514` (a custom port, not privileged 514 —
  confirmed the gateway accepts an arbitrary port, avoiding
  `CAP_NET_BIND_SERVICE`), level INFO, Signal+System+Management Log
  enabled. **Saved successfully and confirmed to persist through a full
  gateway reboot.**
- **No NTP on the gateway** — its System Time showed `2025-12-17` while
  the real date was 2026-09-03. `GatewayEvent.receivedAt` (the receiver's
  own clock) is therefore canonical everywhere; `deviceTime` is stored
  as display-only evidence, never used for ordering.
- **All 8 GSM ports showed "No SIM Card"/"Power Off"** at diagnosis time —
  no real call could be placed. Tried every non-destructive trigger
  available: a full device restart (operator-approved — briefly dropped
  the SIP trunk to Asterisk, ~36s downtime, `07:41:59`–`07:42:35`), a
  config re-save, a port block/unblock toggle (`Mobile Configuration`'s
  per-port Call/SMS/Module Block/Unblock — confirmed this does NOT
  generate any local event, reverted cleanly), and a "Mobile Call Test"
  attempt (`Diagnostic → Mobile Call Test`, confirmed via the on-box **Web
  Operation Log** — `/goform/MobileNetworkTestGoStart` — that the request
  really reached the module). **Zero UDP or TCP traffic was ever observed
  arriving at the VPS**, across all of the above, checked with `tcpdump`
  on both a narrow (tailscale0-only, ports 514+5514) and a wide (any
  interface, TCP+UDP, both ports) capture. The operator's SIM was ejected
  mid-diagnosis, which is what would let a real GSM/call event be tried
  next — **explicitly deferred to a later session**, not resolved.
- Found and confirmed useful along the way: the gateway's own **Web
  Operation Log** (`Diagnostic → Web Operation Log`) is a clean, real-time,
  on-box admin-action log (`TIMESTAMP SOURCE_IP ACTION /goform/Endpoint`)
  — every config change and restart this session showed up there
  correctly, which is what let each dead-end be confirmed as "the device
  did receive this action" rather than "the click didn't register." Also
  confirmed the gateway's own **GSM Event** taxonomy (Register/Call in/
  Call out/Send SMS/Receive SMS/Send USSD/Receive USSD/Lock BCCH/Unlock
  BCCH/Set IMEI/Abnormal/GSM NET) — informed `syslog-parse.ts`'s starting
  classification rules but is a different subsystem from Diagnostic →
  Syslog and was never itself observed to transmit either.

**Built, then independently re-verified at merge (not just trusting the
build's own self-report) — two real bugs caught and fixed before deploy:**

1. `web`'s own `docker-compose.yml` environment block was missing
   `GATEWAY_INGEST_SECRET` (the receiver's service block had it, `web`'s
   didn't) — `isAuthorizedIngest()` would have read `undefined` and 401'd
   every real ingest in production. Fixed: added alongside
   `CDR_INGEST_SECRET` in `web`'s block.
2. The alert gate's `resendConfigured` check was
   `Boolean(await getSetting("RESEND_API_KEY"))`, which treats the literal
   `"change-me"` placeholder as a configured key (it's a non-empty string)
   — alerts would have silently attempted a real, doomed Resend API call
   per critical event instead of cleanly no-op'ing the way the plan's "ship
   in-app alerts only, record blocked-on-secret" requirement describes.
   Fixed with a new `isConfiguredSecret()` helper in `gateway-alerts.ts`
   (4 new tests) that correctly treats the placeholder as unconfigured —
   this is what makes the "Alerts/email" bullet below actually true rather
   than just documented as intent.

Also de-duplicated a hardcoded `CRITICAL_TYPES` array in
`/api/admin/gateway-alerts` into a shared `CRITICAL_ALERT_TYPES` export
from `gateway-alerts.ts`, to avoid future taxonomy drift between the two
call sites.

**Built (all gates green after the above fixes — typecheck, 397 tests, lint, build):**

- **Schema**: additive `GatewayEvent` model + `GatewaySeverity`/
  `GatewayCategory` enums, nullable `siteId`/`sourceIp` for a future
  multi-site task. Migration `20260903180000_add_gateway_event` —
  **`migration.sql` is hand-authored, NOT generated via the documented
  `prisma migrate diff` against the real `algo-web` container (LLM.md
  §P2's pattern)**, since no live DB was reachable from this session. It
  is additive-only (2 new enums, 1 new table, no existing-table changes)
  and prominently flagged as unverified in its own header — **must be
  confirmed against a real `migrate deploy` run, naming the migration
  explicitly, before being trusted** (the §P2 lesson: "no pending
  migrations" there is a failure, not a pass).
- **Parser/classifier**: `src/lib/dinstar/syslog-parse.ts` — built
  defensively against RFC-3164-shaped syslog *without ever having seen a
  real captured line* (see above), with a prominent header caveat saying
  exactly that. `raw` is always stored so a classifier miss is never data
  loss. 28 unit tests, all synthetic fixtures.
- **Receiver**: `scripts/gateway-syslog-listener.ts` — a dumb UDP
  forwarder (no parsing, just batches + POSTs raw lines), `network_mode:
  host`, binds only `SYSLOG_BIND_IP` (refuses to start otherwise, never
  `0.0.0.0`), new `syslog-listener` Docker target + `gateway-syslog-
  listener` compose service + `ufw` rule scoped to `100.64.0.0/10`.
- **Ingest**: `POST /api/gateway-events` (bearer-secret auth, same
  `timingSafeEqual` pattern as `CDR_INGEST_SECRET`), applies the parser
  server-side, writes `GatewayEvent` rows, and — new this session —
  **triggers alerts synchronously on real-time ingestion** (not only when
  an admin has the page open) for `gsm.forbid_call` / `gsm.port_
  unregistered` / `sip.trunk_unreachable`, via
  `src/lib/dinstar/gateway-alerts.ts` (pure, unit-tested). Known
  simplification, stated in that file's own header: this first version
  alerts on the *first occurrence* of each critical type per ingest batch
  rather than the plan's burst/duration thresholds, which need historical
  state this doesn't have yet — safer to over-notify before real event
  volume is understood.
- **Retention**: folded into the existing `POST /api/admin/maintenance/
  prune` route as `pruneGatewayEvents()` — fixed 30-day retention (see
  `COMPLIANCE.md`, new file, PDPL note: gateway messages can contain phone
  numbers), runs independently of the `RECORDING_RETENTION_DAYS` setting.
- **UI**: `/admin/system` gained a "Gateway events" panel (10s poll,
  severity colors, category filter, raw/structured toggle, "last error"
  line) and a **dedicated** alert banner — deliberately **NOT** wired into
  the existing top-bar `HealthPill`, which is already pinned "fail" by an
  unrelated, pre-existing gap (`DINSTAR_SMS_USERNAME`/`PASSWORD` still
  `change-me`, see this file's own earlier notes) — a real alert routed
  through an already-red indicator would be invisible on day one.
  `/admin/dinstar` links to the panel.
- **Alerts/email**: `GATEWAY_ALERT_EMAIL` registered in the existing
  settings registry (`/admin/settings`, email section) alongside
  `RESEND_API_KEY` — **confirmed `RESEND_API_KEY` is still the `change-me`
  placeholder in `.env.example`/this deployment's `.env`**, so email
  alerts are currently blocked-on-secret by design (the ingest route
  checks both are configured before attempting to send, and records
  `emailBlockedOnSecret` in the audit row either way) — the in-app banner
  is NOT blocked on this.

**Explicitly NOT done this session:**

- **Not deployed.** Nothing has been rebuilt/restarted on the VPS for
  this feature; the real `prisma migrate deploy` has not been run.
- **Not committed to git** (same standing instruction as every other
  session this week).
- **Live traffic has never been confirmed end-to-end** — see the "claude
  continue" checklist item 6 above for exactly what's left once the
  operator's SIM is back in.

---

## RIGHT NOW — exact resume state (2026-09-01, end of session)

**Plan:** `~/.claude/plans/refer-the-handoff-and-goofy-bentley.md` (a task graph).
Phase M / MUI migration is **cancelled — MUI is fully removed.**

### Git / deploy state
- **`main` has 33 commits from this session, 44 unpushed total** (15 pre-session
  + this session). **Nothing is pushed** — H4 gate, repo is PUBLIC, needs your
  explicit OK. `git log --oneline fe3ce6f~1..HEAD`.
- **Production (`pbx.saharatechs.com`) is LIVE** and was healthy at last check.
  Everything through commit `0168f4f` (WhatsApp media/ban-safety) is deployed.
- **PENDING DEPLOY:** commit `b056448` (admin Rooms UI fix) — its `docker
  compose build web cdr-listener` was running on the VPS when the session
  ended. **First thing tomorrow:**
  ```
  ssh root@187.53.128.252 "cd /opt/algo-pbx && docker compose build web cdr-listener && docker compose up -d --no-deps web cdr-listener && sleep 15 && docker inspect algo-web --format '{{.State.Health.Status}}'"
  ```
  Then confirm migrations (should be 21, no pending):
  ```
  ssh root@187.53.128.252 "docker exec algo-web node node_modules/prisma/build/index.js migrate status 2>&1 | tail -4"
  ```
  The Rooms fix is UI-only (no migration). Source is already tar-synced to
  `/opt/algo-pbx/algo-pbx-frontend/src` (`/tmp/wa4.tgz`).

### What shipped this session (all on `main`, gate-green: typecheck + 357 vitest + lint + build)

**Apple-black redesign — DONE + DEPLOYED**
- Wave 1 (F1–F6): CSS-variable token system (`src/app/globals.css` — true-black
  dark / `#F5F5F7` light / `#0A84FF` accent, `prefers-color-scheme` default),
  Headless UI primitive kit (`src/components/ui/`, focus rings added),
  two-level collapsible shell (`src/components/shell/sidebar-nav.tsx`, admin +
  agent), theme toggle both headers, `@mui/*`+`@emotion/*` uninstalled, 866
  hardcoded colour classes swept to semantic tokens.
- Wave 2 (subagents, all merged): **S2a** CRM schema (Company/Deal/
  PipelineStage×6/DealContact/DealNote/Activity unified timeline + Contact.
  companyId + ContactTask.dealId + User.themePreference); **S2b** CRM UI
  (`/admin/crm/{companies,pipeline,tasks}`, `/agent/crm/{pipeline,tasks}`,
  Kanban via `@dnd-kit/core`); **S3** WhatsApp-Web chat UI; **S4** Reports hub
  (Telephony + CRM Insights tabs, `recharts`); **S6** telephony QA
  (`/admin/monitor` listen-only ChanSpy audit-logged, `/admin/recording`
  toggle via `func_odbc` that FAILS OPEN, no Asterisk reload; `PbxRuntimeFlag`
  table); **W** CRM↔call wiring (screen-pop, call popover, auto-disposition,
  missed-call→task — reads `sip-context.tsx`, never writes it); **S7** UX audit
  (`UX-AUDIT.md`, 24 findings / 9 fixed).
- Migrations deployed on prod: `20260901120000_add_crm_pipeline`,
  `20260901130000_add_pbx_runtime_flags` (`migrate status` clean).

**WhatsApp fix — DONE + DEPLOYED (commits `043968f`, `5178acf`, `0168f4f`)**
Diagnosed against the live OpenWA v0.23.1 (baileys engine) sidecar. Five
data-layer breakages, all fixed:
- `parseInbound` checked `m.fromMe` (OpenWA never sets it) — real field is
  `direction: "incoming"|"outgoing"`. Own outgoing messages were ingested as
  INBOUND/empty. Fixed via shared unit-tested `mapOpenWaMessage()`.
- Media (voice/image/video/doc/sticker) arrives as **base64 in
  `metadata.media.data`**, not a URL. Captured at ingest into
  `ChatMessage.mediaData` (~1 MB cap); `GET /api/messaging/media/[id]` serves
  it (auth-checked, sensitive-gated), falls back to the sidecar for over-cap.
- Webhook only pushes NEW messages. `src/lib/messaging/history-sync.ts` pulls
  backlog on thread open — first sync = recent 80 WITH media + wider 400
  text-only, later syncs = light metadata top-up. Rate-limited via
  `Conversation.historySyncedAt`, fired async (progressive fill, WhatsApp-Web
  style). "Load earlier messages" pagination in `ChatThread` (`?before=<iso>`).
- No avatars → `Contact.waAvatarUrl` + 6h TTL; `GET /api/messaging/avatar/
  [contactId]` proxies the pps.whatsapp.net pic (CSP-blocked / expiring if
  loaded direct). `ChatAvatar` component in list + thread header + Rooms.
- No voice sending → composer mic button (MediaRecorder) → `POST /api/messaging/
  conversations/[id]/voice` → OpenWA `send-audio {base64, ptt:true}`.
  `VoiceBubble` player (play/seek/duration/speed) for received + sent.
- `docker-compose.yml`: `BAILEYS_SYNC_FULL_HISTORY: "true"` (only takes effect
  on a fresh re-pair — pulls ~1yr+ instead of a few months).
- Migrations deployed on prod: `20260901140000_add_wa_media_avatar`,
  `20260901150000_add_chatmessage_mediadata`. `historySyncedAt` was reset to
  NULL for all 10 WhatsApp conversations so they re-sync with media.
- **BAN RISK:** everything here is READ-side — history pulls read OpenWA's own
  local store, not WhatsApp per message (baileys can't). `includeMedia`
  downloads media blobs from WhatsApp's CDN (normal client behaviour), capped
  to recent 80 / first sync only / one thread at a time. No send-rate change,
  no bulk, customer-service 1:1 only. Baseline OpenWA/baileys ToS risk is
  unchanged. Only zero-risk route = Meta's official Cloud API (`META_CLOUD`
  provider already exists as a fallback).

**Admin Rooms UI fix — DONE, DEPLOY PENDING (commit `b056448`)**
The `/admin/rooms` WhatsApp/SMS activity panel was a pre-redesign flat preview
("(no text)" for voice notes, text overflowing the card, no avatars).
Rebuilt to the conversation-list pattern: contact avatars, media-aware
previews ("🎤 Voice message" / "You: …"), unread pills, proper card layout,
wider page. `activity` route now returns `contact.id` for the avatar.

**Mid-session VPS incident — FIXED**
`pbx.saharatechs.com` went `ERR_SSL_PROTOCOL_ERROR`: the mounted (gitignored,
apply-route-owned) `pbx_configs/generated/Caddyfile` had regressed to
`saharatechs.com` only — no site block for `pbx.*`. Rewrote it to serve BOTH
hosts, `caddy validate` + `caddy reload` (no restart). Backup at
`/tmp/Caddyfile.bak.*` on the VPS. Pre-existing prod issue, not the redesign.

### Operator TODO tomorrow (in priority order)

1. **Finish the pending deploy** (Rooms fix) — the command block at the top.
2. **Backfills — ALREADY DONE this session.** `backfill-activity` wrote 62
   timeline rows; `backfill-caller-e164` = no-op (27 internal ext rows). If
   you re-open a contact and the timeline looks thin, re-run
   `POST /api/admin/maintenance/backfill-activity` from an admin devtools
   console — it's idempotent.
3. **Click-through the redesign + WhatsApp with the assistant:**
   - Admin + agent shells, both themes (toggle top-right), a few pages each.
   - CRM: contact → create deal → drag across the Kanban → add a task →
     confirm it all shows in the contact's unified timeline. Agent sees only
     owner-scoped; admin sees all + can reassign.
   - **WhatsApp `/agent/chat`**: open Sarath's thread — confirm history fills
     in progressively, voice notes play (`VoiceBubble`), avatars load, images
     render. Record + send a voice note. Scroll up → "Load earlier messages".
   - WhatsApp on a 390px phone viewport (single-pane + back arrow).
   - `/admin/rooms` → open Room1 → the activity list should now have avatars +
     "🎤 Voice message" previews; click a row → ChatThread slide-over.
   - Reports `/admin/reports` — both tabs, agent + date filters.
   - Screen-pop: place a real inbound call, confirm the CRM card appears for
     the agent; end the call, confirm the disposition prompt.
4. **S6 announcement WAVs** (recording declaration) — still not generated.
   Follow `pbx_configs/sounds/README.md` (Piper TTS or `asterisk-extra-sounds`
   "this call may be recorded" prompt) → `scp` to the VPS → `asterisk -rx
   "module reload res_odbc.so"` + `dialplan reload`. Recording works without
   it; the Playback of a missing prompt is a silent no-op. Also live-test the
   recording toggle per `docs/S6-real-call-test-plan.md`.
5. **After an `openwa` container restart, sessions do NOT auto-resume** — they
   sit `disconnected`. Kick them: `POST /api/admin/whatsapp/instances/<id>/`
   ... actually simplest is the "repair" button on `/admin/whatsapp`, or:
   ```
   docker exec algo-web node -e 'fetch("http://openwa:2785/api/sessions/eabd9bd2-3374-40e0-97c2-99ffc22e8667/start",{method:"POST",headers:{"X-API-Key":process.env.OPENWA_API_KEY}}).then(r=>r.text()).then(console.log)'
   ```
   (session id `eabd9bd2-3374-40e0-97c2-99ffc22e8667` = sim1 / `971502644615`.)
6. **Manager-merge (Phase MM)** still never live-call-tested — see `LLM.md §30`.
7. **H4 — `git push`.** 44 unpushed commits, PUBLIC repo. Your call.

### Deferred (safe to skip — recorded in `UX-AUDIT.md`)
Admin nav 6→4 groups + reorder + co-locate recording/monitor/DNC; `/agent/call`
split into Dial/History sections; disposition-bar Von-Restorff emphasis; 3
more raw "Loading…" → `<Skeleton>`.

### To get WhatsApp EXACTLY like WhatsApp Web (unlimited scroll-back)
The baileys engine **cannot** fetch arbitrarily-old messages on demand
(OpenWA's own capability matrix: "library-limitation"). The link-time history
sync is the whole backlog we get (~few months, ~1yr with
`BAILEYS_SYNC_FULL_HISTORY`). Unlimited scroll-back needs
`OPENWA_ENGINE=whatsapp-web.js` (drives a real Chromium) — but that's
~300–500 MB RAM per session × 4 sessions on a 1 GB-capped container. Infra
decision: bigger VM or raised container memory. Not started.

### SIM ports 2–4 (unchanged, operator-blocked)
Still `PAIRING` — need real phone numbers + QR scans. Pure ops, no code.

---
### Superseded — historical only, below this line

## RIGHT NOW: exact resume state — (SUPERSEDED — this was the 08-31 mid-deploy state, now resolved)

1. **A `docker compose build web` was running in the background when this
   session paused** (task id `b8v7kxs48` if that shell state persists,
   otherwise just re-run it). Check it, then:
   ```
   ssh root@187.53.128.252 "cd /opt/algo-pbx && docker compose build web 2>&1 | tail -25"
   ```
   If it already finished (check for the image), skip to step 2. If it
   failed, the source is already synced to `/opt/algo-pbx/algo-pbx-frontend`
   (via a full `tar` sync, not just changed files) — diagnose from there,
   the local tree in this repo is the source of truth.
2. **Deploy**: `docker compose up -d --no-deps web`, wait for
   `docker inspect algo-web --format '{{.State.Health.Status}}'` to say
   `healthy`.
3. **The DB migration is ALREADY APPLIED** — `20260831130000_add_contact_transfer_request`
   (new `ContactTransferRequest` table) ran successfully against production
   *before* this pause, confirmed via `prisma migrate deploy`'s own "applied"
   output, not just assumed. The **code** that uses it (new
   `/agent/crm/transfer-requests` routes, `/admin/contact-ownership`, the
   rebuilt `/admin/contacts`) was not live yet as of the pause — so between
   now and step 2 completing, the DB schema is ahead of the running code.
   This is safe (old code never references the new table) but don't be
   surprised if `docker ps`/logs look like nothing changed until the deploy
   above actually lands.
4. **Live-verify Features A/B/C** (see below) — none of it has been
   click-through-verified yet, only gate-checked and code-reviewed. This
   session got as far as reviewing the diffs carefully (see "A note on
   trust," below) but ran out of time before the live pass.
5. **Nothing from this session is committed to git** despite having
   standing authorization to commit per-task — the working tree got too
   large and fast-moving (multiple subagents landing overlapping work) to
   commit safely mid-flight. **Commit once the live-verify pass in step 4
   passes**, in logical groups (see "Suggested commit grouping" below), not
   as one giant commit.

## What's built (gates green, NOT yet live-verified)

**Feature A — real CRM contact form** (`/admin/contacts` full rewrite):
name/phone/email/company/tags/owner/initial-note form, CRM table with
search+owner+tag filters, a REAL merge endpoint (not a stub — reassigns
notes/tasks/dispositions/conversations, unions tags, deletes the loser),
bulk import with names (mirrors the DNC import UI exactly: drag-drop
CSV/XLSX + paste, country default IN, preview counts, chunked insert,
rejected-rows report, audit log).

**Feature B — one contact, one owner**: `Contact.ownerId` (already existed)
now actually means something — auto-assign on first answered call or chat
reply (race-guarded `updateMany`), server-side write enforcement everywhere
(`src/lib/contact-ownership.ts`'s `canWriteContact`, not just a hidden UI
button), a real transfer-request flow (new `ContactTransferRequest` model,
mirrors the existing `SmsAccessRequest` shape — request → owner or
supervisor/admin approves/declines → ownership flips, inside a
`$transaction` with its own race guard), a new `/admin/contact-ownership`
manager view (unassigned pool, reassign, per-agent counts), and deactivating
a `User` now releases their contacts back to the pool automatically.

**Feature C — caller ID that learns**: `src/lib/caller-id-format.ts` formats
an unknown caller as "Unknown — +971501234567 (United Arab Emirates ·
Mobile)" via `libphonenumber-js/max` instead of ever showing a bare number;
a skippable "Who was this?" prompt in the contact detail view writes
`displayName` after an interaction; **the CDR backfill gap flagged in an
earlier session was closed** — was 0/42, is now confirmed 15/42 (the
remaining 27 are genuinely unparseable internal/malformed CDR fields, not a
bug) — verified independently via a direct production DB query, not just
taken on the agent's word.

## A note on trust — read before assuming any of the above is safe

The subagent that built Features B+C returned its final report with **"SECURITY
WARNING: performed actions that may violate security policy... blocked by
classifier"** at the top. This was NOT ignored. Before deploying anything from
it, this session independently: re-verified the CDR backfill count live
(matched exactly), checked `.env`'s modification timestamp on the VPS
(untouched, last changed hours before this agent even ran), checked for
leftover scripts/dependencies in the `algo-web` container (none — properly
cleaned up), and read the highest-risk files by hand (`contact-ownership.ts`'s
`canWriteContact`, the transfer-approve route's transaction/race-guard, the
migration SQL itself). All of it checked out as correct, safe, and
well-reasoned. Best guess: the classifier hit the same kind of secret-adjacent
false-positive this session's own main thread hit multiple times today (e.g.
`.env`-touching shell patterns), not real misbehavior — but this is a
**best guess, not certainty**, and whoever picks this up should stay alert
for anything that doesn't check out during live verification, not just
assume the all-clear stands.

## Suggested commit grouping (once live-verified)

The working tree has accumulated most of a full session's work uncommitted.
Rough logical groups, not necessarily exact file boundaries (several files
like `call-controls.tsx`/`sip-context.tsx`/`schema.prisma` were touched
across more than one of these):
1. Dinstar TLS pinning + Caddy healthcheck fix + WhatsApp send-path recon
   (docker-compose.yml, dinstar-sms-provider.ts's pinning parts,
   settings/schema.ts, system/health/route.ts) — LLM.md §27-28.
2. P2 CRM data layer + P3 agent UI rehaul (schema migration
   `20260831120000_add_crm_data_layer`, new `components/crm/**`, new
   `api/agent/crm/**`) — LLM.md §29.
3. Phase MM manager merge (`manager-merge-picker.tsx`,
   `api/calls/manager-merge/route.ts`) — LLM.md §30, still not live-call-
   verified.
4. Sidebar + CRM integration across agent pages (`agent-shell.tsx` rewrite,
   `active-call-contact.tsx`, chat CRM links, `me/calls`/`me/missed-calls`
   `callerContactId`) — LLM.md §31.
5. Today's fixes: chat-thread error surfacing, admin Rooms scoping fix, DNC
   bulk import rebuild, Dinstar SMS root-cause documentation.
6. Today's big feature batch: Feature A (admin CRM contact form), Feature
   B+C (ownership/transfer/auto-assign + learning caller ID), migration
   `20260831130000_add_contact_transfer_request`.

## Still blocked on the operator (unchanged)

Phone numbers for the SIM-port re-pair test and pairing ports 2-4 — both
pure QR-scan operations, zero code needed, whenever the numbers exist.


Last updated: 2026-08-31, end of session. Full detail in `LLM.md §27-31`. This
supersedes every earlier section of this file below — read this one first.

## One-click task waiting on you: run the CDR backfill

`POST /api/admin/maintenance/backfill-caller-e164` (admin session, e.g. via
the browser devtools console or curl with your session cookie) — it's
built, idempotent, safe to run anytime, and was deliberately NOT run this
session because the only authenticated browser session available was a
REAL agent account with a live, `Connected` softphone registration, and
switching to admin would have signed that out. Until it's run, a
contact's Timeline in the CRM (`/agent`) will show zero historical calls
even for numbers that plainly have call history — `/agent/calls` still
shows and links them correctly in the meantime (it recomputes the match
live, doesn't depend on this backfill). See `LLM.md §31` for the full
diagnosis.

## Sidebar + CRM integration (this session, §31)

The agent nav is now a left sidebar (icon + label + badge per item,
active-page highlight) instead of the old horizontal top-bar links —
matches the admin section's own sidebar shape. Every agent page that
previously showed a bare phone number now links to the matching CRM
contact where one exists: Chat's conversation list, the Calls and Missed
lists, and — new — the active/held call view itself, which can also
one-click "Add to CRM" an unknown caller. Live-verified against real data
under both the admin test account and (accidentally, and usefully) a real
connected agent session.

## Manager merge (Phase MM) — deployed, needs a real test call before it's trusted

`ManagerMergePicker` (next to the existing escalation/blind-transfer picker
in call controls, mid-call only) + `POST /api/calls/manager-merge` bring a
manager into a live call. **Built as an auto-merge, not the originally
planned consult-first flow** — customer and agent go into the shared
ConfBridge room immediately, the manager is Originated into the same room
after; if the manager never answers, customer and agent just keep talking,
never dropped, never silent. See `LLM.md §30` for exactly why consult-first
(a private hold-and-consult step) was judged too risky to invent and ship
unverified this session.

**This has never been tried against a real call.** It's safe to have
deployed (new route, new button, unreachable unless clicked, cannot affect
any existing call flow) but the Redirect/Originate/caller-ID/answer-detection
mechanics all inherit the same "needs live testing" flag the underlying
generic conference route has carried since Phase G. First real use should be
a deliberate test: an agent on a live call clicks Merge, a manager's phone
should ring showing "Conference Call - <Agent Name>", and audio should mix
correctly with all three parties audible to each other.

**Per-participant mute/hold (MM4) was not attempted at all** — the plan
flagged this as the likely-hardest part (the manager's channel is never
captured, and mute needs an exact channel to target) and it was left
undone rather than rushed unverified. Not a bug, not partially built —
simply not started.

## Blocked on the operator, not on anything code-side

**Phone numbers for SIM ports 1's re-pair test and ports 2-4's pairing will
only be configured in a future session, not this one — explicit operator
decision 2026-08-31.** Both remaining P1-backend steps need a real phone in
hand to scan a QR code; no login level or code change substitutes for that:

- **The true re-pair test** (logout the port-1 WhatsApp session, scan a fresh
  QR, confirm all 7 real conversations survive re-attached to the same SIM
  port) — this is the direct test for the "does re-pairing detach
  conversations" hypothesis flagged as this project's #1 WhatsApp risk. It
  remains unproven either way, not disproven — see `LLM.md §27`.
- **Pairing SIM ports 2-4.** Already prepared and waiting: real OpenWA
  sessions created, webhooks registered, each showing `status: PAIRING` with
  a working "Get pairing code"/"Scan QR" UI at `/admin/whatsapp` — confirmed
  live in the database (`LLM.md §28`). Nothing further to build; this is
  purely "scan 3 more QR codes when the numbers exist."

Whoever picks this up next: both steps are pure operations, not development
— no code changes are needed, only running the existing, already-tested
`/admin/whatsapp` UI with a real phone.

## This session's actual deliverable: the CRM is live

**`/agent` is now the CRM — the operator's main interface, per their explicit
spec** — not the old two-column softphone+chat page. Contact list, contact
detail (fields, notes, tasks, a disposition bar, a merged calls+messages
timeline), Call and WhatsApp actions on every contact. Live-verified with
real production data, not fixtures: real WhatsApp-derived contacts, a real
note write that round-tripped through the database, and (after one real bug
was caught live and fixed — see `LLM.md §29`) both the "open an existing
WhatsApp thread" and "no thread yet, admin picks a SIM line to start one"
paths working end to end.

The former `/agent` (dialpad, call controls, missed calls, voicemail,
recordings) moved to `/agent/call`, unchanged in behavior — same components,
new route. `/agent/calls`, `/agent/voicemail`, `/agent/missed`,
`/agent/chat` are unchanged siblings, still separate pages (the plan's
"fold missed into calls" consolidation was not done).

**Explicitly not yet built, so a viewer landing on a different page may
reasonably say "I don't see the CRM":** CRM context is not yet integrated
into the OTHER agent pages — no call popover, no incoming-call auto-opening
the matching contact, no `<900px` responsive collapse. Those pages still
look and behave exactly as before. The CRM itself lives at `/agent` only,
today. `/admin/contacts` is also still the pre-CRM bare directory (number +
display name only) — the admin management/attribution view over notes,
tasks and dispositions is unbuilt.

## WhatsApp: root cause was "never exercised," not a bug

Zero WhatsApp messages had ever been sent successfully in this system's
history — not a partial failure, literally zero `OUTBOUND` rows ever, out of
26 total messages. Investigated by replicating the exact production send
call directly against the live sidecar (sent a real message to the
manager's WhatsApp — delivered, `HTTP 201`) and by reading the actual send
route line by line. **Conclusion: the send path was already correct** — wire
format, route logic, access guards, error handling, all fine. Only 1 of 4 SIM
ports had ever been paired, so there was structurally almost nothing to
send through, and the working UI was apparently never actually clicked
through to a real conversation. No code fix was needed or made for the send
path itself.

Two real, unrelated bugs *were* found and fixed this session, both deployed
and live-verified:
- **`algo-caddy` showed `unhealthy` in `docker ps` for 2+ days** — a
  containerd/runc-level healthcheck exec failure (confirmed not a stuck
  state: surviving a full container restart), not a real outage. Disabled
  the healthcheck rather than leave it generating permanent false alarms;
  nothing depended on it.
- **Dinstar SMS's `DEPTH_ZERO_SELF_SIGNED_CERT` block** — fixed with real
  certificate pinning (captured the device's actual cert, pinned it, not a
  blanket TLS bypass). SMS is now *reachable*; sending is still
  *unauthenticated* — `DINSTAR_SMS_PASSWORD` in `.env` is still the
  `change-me` placeholder from an earlier session, a separate, pre-existing
  gap this fix didn't touch.

## Not committed to git

Nothing from 2026-08-31's session is committed — all of it deployed directly
to the VPS (file copies + rebuilds) per the standing instruction to hold
commits until explicitly asked. Local tree and the VPS are consistent with
each other, both ahead of `git log`.

## Next

Phase MM (manager merge) is now built and deployed — see the section above.
Immediate next step is a real test call to actually verify it, then MM4
(per-participant mute/hold), then whatever the operator prioritizes next:
Phase M (MUI migration), P1 UI (WhatsApp-Web-exact redesign), P4 (DNC
import fix), or CRM integration into the non-CRM agent pages (call popover,
incoming-call auto-open — see this file's CRM section above for what's
still missing there).

---


## Everything below was confirmed against the real running system, not just a passing build

Every claim in this section was checked one of three ways: grepping the
actual deployed bundle for the new code, querying the live production
database, or reading Asterisk/the gateway's live state directly. That
discipline mattered this session — an earlier deploy silently missed a fix
because `cdr-listener` builds from a separate Docker image target than
`web` (see below), and it would have gone unnoticed without checking the
database instead of trusting the build.

**Inbound and outbound calls both work end to end, with real two-way audio.**
The Tel→IP Routing rule on the Dinstar gateway had `Destination = SIP
Server` while the gateway is in No Register mode — fixed to `sip-trunk-0
<AlgoPBX>`, mirroring the outbound direction's IP→Tel rule from an earlier
session. Verified via `queue_log`: real inbound calls now show
`ENTERQUEUE → CONNECT → COMPLETECALLER` with 30-50s conversations, and
recordings contain continuous real audio.

**Call data (CDR) is now accurate.** `direction` and `agentExtension` were
silently wrong on every call ever recorded — fixed in the mapper, backfilled
39 historical rows, and confirmed correct on a fresh live call
(`callerNumber=1002`, `direction=outbound`, `agentExtension=1002`). This
also means `/agent/calls` (new — there was no agent call-log page at all),
`/agent/missed`, `/admin/reports`, and agent recording playback all now
work, since they all filter on the fields that used to be wrong.

**Hold, attended transfer, and the ringtone are fixed.** Hold was silently
ending calls because a flag got cleared before the real outcome of the
re-INVITE was known — fixed, plus the identical bug in attended transfer.
The ringtone's autoplay-block rejection was silently swallowed (confirmed:
one real inbound call rang the full 15s window and was abandoned because
the agent never heard it) — fixed with an audio-unlock-on-first-click
pattern plus a visible "Enable call sounds" banner if it's ever still
blocked. Decline now sends a real 486 instead of 480. Dead WebRTC
registrations are now health-checked and pruned (`qualify_frequency`) —
confirmed live, both of extension 1002's contacts flipped from permanent
`NonQual` to `Avail`. Agent status ("On Break") now actually pauses the
queue member, and survives a reconnect without silently resetting to
available.

**MOH audio is fixed.** `.gitignore` deliberately excludes audio assets and
the VPS was deployed from a fresh clone, so production had none of them —
copied the operator-authorized files across; `moh show classes` now lists
`default` and the ringtone returns 200.

**All 4 real GSM ports are configured.** Ports 0-3 (the only ones with
modem hardware on this UC2000-VE unit) all have `To VOIP Hotline = 100`.
Inserting a SIM into any of them should register with no further gateway
configuration — confirmed by reading the dialplan and the gateway's own
routing rules, voice never selects a port anywhere in this codebase.

**Dinstar port config can now be applied from `/admin/dinstar`** — a real
"Apply standard SIM config" button, not a manual checklist. **Read this
limitation before trusting it blindly**: it is write-only. The gateway's
config page builds its fields with client-side JavaScript, so there is no
reliable way to read current values back server-side — this was root-caused
before writing any code, not discovered by a failure in production. The
write mechanism itself was proven against the live gateway with a
standalone test script before being wired into the app, and a browser
re-read confirmed it worked with nothing else disturbed — but every future
use of this button should be spot-checked once by reloading
`enPortList.htm` in a browser, the same way this session verified it.

**Manager escalation and the 3-way conference route are now guarded** the
same way blind/attended transfer already was against the single-GSM-port
hazard, and give a clear, specific error instead of a raw transfer-guard
message or an unguarded AMI Originate.

## Explicitly deferred — not bugs, not forgotten

- **The dynamic multi-SIM transfer guard.** External transfer/escalation on
  a GSM call is still blocked whenever only one SIM is registered (correct,
  hardware-limited behavior) — making it dynamic on "how many SIMs are
  currently registered" needs live port-state detection, which hit the same
  client-side-rendering wall as the Dinstar write feature above. Not
  started.
- **A dedicated `/admin/gsm-ports` page.** The underlying exclusive/revoke
  port-assignment logic already works correctly (verified, not assumed) via
  the existing `/admin/users` create/edit form — this would just be a nicer,
  port-centric view of the same thing.
- **`getUserMedia` audio constraints are dead code** — confirmed against the
  installed sip.js source, `echoCancellation`/`noiseSuppression`/
  `autoGainControl` sit in a field sip.js's factory never reads. No
  constraint tuning can have any effect until this is fixed. Low priority
  since default browser behavior has been fine in every test this session.
- **Extension 1002 still has two simultaneously-registered contacts** (UAE
  desktop + India mobile) — left as-is per the operator's explicit call;
  be aware it can make test results ambiguous.

## One thing to check that's outside this session's scope

`docker ps` shows **`algo-caddy` as `unhealthy`**, and has for ~26 hours —
this predates this session and nothing here touched Caddy. Worth a look;
not investigated further here.

## Deploy gotchas learned the hard way this session — read before the next deploy

- **`web` and `cdr-listener` are separate Docker build targets.** Building
  one does NOT rebuild the other — this is exactly what silently kept an
  already-committed fix out of production for hours this session. Rebuild
  both explicitly when a change touches `scripts/ami-cdr-listener.ts` or
  anything it imports.
- **A cached `docker compose build` can silently omit a brand-new file**
  (a fresh migration, a new module) even though the source was already
  copied to the VPS. Bit this session twice with new Prisma migrations that
  didn't reach the image on the first build. Use
  `docker compose build --no-cache <service>` whenever a build follows
  shortly after adding new files, not just editing existing ones.
- **`docker compose restart asterisk` silently resets `pjsip set logger on`
  and any `logger add channel`.** Re-arm them before relying on a live SIP
  trace — reading a stale trace after a restart produced a wrongly
  pessimistic "inbound still isn't arriving" conclusion mid-session this
  time. `queue_log` and the CDR table both survive a restart and are more
  trustworthy sources for "did a call actually happen".
- Always run `npm run typecheck && npm run test && npm run lint && npm run
  build` before every deploy, and after a schema change run
  `docker exec algo-web node node_modules/prisma/build/index.js migrate
  deploy` (the bundled CLI — the standalone image has no `prisma` binary on
  PATH) and confirm it reports the new migration by name, not "no pending".

`/root/rtp_rms.py` on the VPS decodes an a-law RTP flow out of a pcap and
prints per-second RMS — keep it. It's what distinguished "packets are
arriving" from "audio is arriving" on a call where Asterisk's own packet
counters looked perfectly healthy while the far end heard nothing.

---

# Previous session — Outbound one-way audio FIXED and verified with packet evidence. Remaining blockers are the agent's own mic/speakers and one Dinstar UI field. Session-takeover bug fixed in code, NOT yet deployed.

Last updated: 2026-08-29. Full technical detail in `LLM.md §24`.

## Deployed and verified live this session

**Outbound one-way audio is fixed** (commit `4aed624`, live on the VPS).
Root cause: Asterisk advertised `c=IN IP4 100.64.32.115` to the Dinstar, but
the Tailscale subnet router SNATs tailnet→LAN traffic and the gateway has no
route into `100.64.0.0/10`, so its return RTP was black-holed by the office
router. SIP survived only because `force_rport` makes replies go to the
received source; RTP follows the SDP. The universal 30s call length was
`rtp_timeout=30` firing on a leg receiving nothing.
Fix: `external_media_address=192.168.11.10` on `[transport-udp]` in
`pbx_configs/pjsip-base.conf`.
Proof, before → after: `dinstar-trunk` **0 rx / 893 tx → 1283 rx / 1287 tx**;
a 2342-packet return flow that did not exist before; call length 30s → 59s;
`CallQualitySample.packetsReceived` NULL → 2157 at MOS 4.33.
**No WebRTC regression** — SDP still shows `187.53.128.252` on the SAVPF legs,
`192.168.11.10` only on the `RTP/AVP` Dinstar leg.

**TURN relay ports opened.** `scripts/setup-firewall.sh:48-54` intends to open
`3478/tcp`, `5349/tcp`, `20001:30000/udp`; none existed on the live VPS.
coturn is `network_mode: host`, so ufw was really blocking the relay range.
Added live. Only affected agents behind symmetric NAT (direct media on
`10000:20000/udp` was always open).

## Do these next, in this order

1. **Dinstar UI → Port Group-0 → "To VOIP Hotline" = `100`.** This is the
   whole reason inbound calls ask the caller to dial an extension: with the
   field empty the UC2000 answers and plays its own DISA second-dial-tone.
   Asterisk is NOT the source — `[from-dinstar]` is `Answer()` → `Queue()`
   with no digit collection anywhere, and no `[default]` context exists to
   fall into. This field has now regressed to empty **three times**; check it
   first whenever inbound misbehaves. (`s` also works — `extensions.conf:222`
   defines it — but `100` is numeric and known to pass the firmware's
   validation.)
2. **Check the agent workstation's audio devices.** The PBX media path is
   proven healthy end to end, but the browser is sending packets containing
   pure digital silence (every a-law byte `0xD5`, peak=8, for 47 straight
   seconds) while real far-end speech arrives and decodes at MOS 4.33.
   Check: the softphone's `audioBlocked` warning, Chrome mic permission for
   `pbx.saharatechs.com`, and the selected Windows input/output devices.
   The mic worked at 09:03 and was silent at 10:19 — if the browser, tab,
   headset or machine changed between those, that is the whole story.
3. **Deploy the auth fixes** (commit `d1ef7b9`, code only, not on the VPS):
   `docker compose up -d --build web` — never a plain `restart`.
4. **Re-test outbound from a real agent in India.** Today's test agent was in
   the UAE office, and ICE selected the LAN path
   (`192.168.11.10 ↔ 100.64.32.115`), i.e. media went over Tailscale. A
   remote agent will use the public path (`187.53.128.252`), which is open
   and correctly advertised but has **not** carried verified media yet.

## Fixed in code, awaiting deploy

**The agent→admin account switch** (commit `d1ef7b9`). Not a broken
permission check — all 35 `/api/admin/**` routes independently call
`requireAdminSession()`. The app had no notion of per-tab identity: one
`authjs.session-token` at `path=/` shared by every tab, a login page that
never checked for an existing session, and `signIn()` overwriting that cookie
in place. The agent tab then re-rendered against the admin cookie and drew
`agent-shell.tsx:185-189`'s ADMIN-only "Admin" link, which genuinely worked.
Also fixed: `sip-context` kept the previous user's extension and **plaintext
SIP secret** registered to Asterisk after a swap (its effect was keyed on
`sessionStatus`, which never changes on an account switch); a `callbackUrl`
open redirect; and `admin/layout.tsx` now checks the role itself rather than
relying solely on middleware.
typecheck clean, 294/294 tests, zero lint, clean build.

## Diagnostics left running on the VPS (clean these up)

- `pjsip set logger on` + a `logger add channel` writing
  `/var/log/asterisk/sipdebug*.log` — **turn off before this fills the disk**
  (`asterisk -rx "pjsip set logger off"`).
- `/root/capture-call.sh` + `/root/callcap/` (tcpdump pcaps, channelstats).
- `/root/rtp_rms.py` — decodes an a-law RTP flow from a pcap and prints
  per-second RMS. Genuinely useful: it is what separated "packets are
  arriving" from "audio is arriving". Worth keeping.
- `/root/pjsip-base.conf.bak-*` — pre-change backup.

---

# Previous session — Production VPS is LIVE on real HTTPS. Inbound voice paused mid-diagnosis: carrier barring RULED OUT, now looks like a SIM/antenna seating issue on the gateway.

Last updated: 2026-08-28, end of session (production deploy day). Full
detail in `LLM.md §19`/`§20`/`§21`/`§22` and the plan file
`~/.claude/plans/the-navbar-voicemail-missed-chat-cheeky-pinwheel.md`.

## STOP HERE FIRST TOMORROW — exact state the session was left in

**The production stack is live and healthy. Nothing here is broken except
inbound GSM voice, which is mid-diagnosis, not mid-outage.**

### How to get back in (no new credentials needed)

- **VPS**: `ssh root@187.53.128.252` — key-based auth already works from
  this Windows PC (`~/.ssh/id_ed25519`, already trusted by the VPS). No
  password exists or is needed. Repo is at `/opt/algo-pbx` on `main`
  (GitHub's default branch is still the stale `master` — always
  `git checkout main` after a fresh clone, never trust the default).
- **App**: `https://pbx.saharatechs.com` — real Let's Encrypt cert, valid
  through 2026-11-26. Admin account was created by the user directly
  through `/setup` this session; this assistant never saw the password.
- **Tailscale**: this Windows PC (`desktop-9k5i239`, `100.96.38.18`) is the
  subnet router for the Dinstar's office LAN (advertises
  `192.168.11.0/24`, approved in the Tailscale admin console already).
  The VPS (`srv1936994`, `100.64.32.115`) reaches the gateway through it
  — confirmed working (`ping 192.168.11.1` from the VPS succeeds,
  ~150ms). If this PC is off or Tailscale isn't running on it, the VPS
  loses the route to the gateway entirely — check that first if anything
  Dinstar-related seems newly broken tomorrow.
- **Dinstar gateway**: `https://192.168.11.1` (reachable directly from
  this PC, which sits on that LAN via its `Ethernet` interface at
  `192.168.11.50`/`.10`). Admin credentials were entered by the user
  directly; not recorded here. This is a **UC2000-VE Business, 8 ports**,
  not 4 — only port 0/1 (see below) has ever had a live SIM; ports 2–3
  have modems but no SIM; ports 4–7 have no modem hardware
  installed/powered.

### Where the inbound-voice diagnosis actually landed (read this before
### touching the Dinstar again)

The chain of theories today, in order, each overturned by the next by
**live testing against the real hardware**, not by re-reading docs:

1. Carrier-side incoming-call barring (`§19`'s original conclusion).
2. DISA/empty-hotline (`§20`'s correction) — overturned: fixed the
   hotline on all 8 ports and the stale SIP trunk IP, live-retested twice,
   still `FORBID CALL` both times with zero SIP traffic reaching Asterisk.
3. Carrier barring again, re-confirmed (`§21`) — **overturned by the
   single most useful test all day**: the user put the physical SIM into
   an ordinary mobile phone and it received incoming calls normally, on
   the same carrier, same number, even when the phone was forced onto
   2G-only. A number that's actually barred by the carrier fails
   everywhere, on every device — it did not. **Carrier-side barring is
   ruled out, permanently, don't re-chase it.**
4. Current leading theory, untested: **something specific to the Dinstar
   module/antenna/SIM-seating**, not the carrier and not GSM config. When
   the SIM went back into the gateway (now sitting in **port 1**, not
   port 0 — the physical tray apparently got swapped), it took over 4
   minutes to go from "searching network" to outright **"Mobile
   Unregistered"**, with a visibly weak/near-empty signal-bar icon the
   whole time — markedly worse than port 0's earlier "Mobile Registered,
   full bars" reading before any of today's SIM-swapping happened. This
   was never resolved — the session ended here.

**Tomorrow, in this order:**
1. Physically check the SIM card is fully seated in whichever port it's
   now in, and that port's antenna cable is firmly connected — the user
   was about to do this when the session ended. A loose antenna
   connector is a completely mundane, very common cause of exactly this
   symptom (weak signal, slow/failed registration) and costs nothing to
   rule out before suspecting the module itself.
2. Once registration shows **"Mobile Registered"** with real signal bars
   again (whichever port), re-run the same live test from today: place a
   real call to the SIM while watching `docker exec algo-asterisk
   asterisk -rx 'pjsip set logger on'` + `ssh root@187.53.128.252 "docker
   logs -f algo-asterisk"` on one side and the gateway's **GSM Event**
   log + **Current Call Status** page on the other. `FORBID CALL` again
   under a clean registration would newly implicate the module/firmware
   itself (worth Dinstar support at that point); a real SIP INVITE
   reaching Asterisk would mean today's hotline/trunk-IP fix was right
   all along and this was purely a signal/registration problem the whole
   time.
3. If the SIM is now permanently in port 1 rather than port 0, no config
   change is needed for that — confirmed this session that
   `Port Group-0 <default>` already covers all 8 ports
   (`0,1,2,3,4,5,6,7`), so the existing hotline/Tel→IP-routing/SIP-trunk
   config applies to whichever port the SIM ends up in.

### Also still open from today, lower priority than the above

- Phase 4 (SMS: the undici/self-signed-cert bypass code change, and the
  poller service) and Phase 5 (fail2ban, `ss -tulnp` audit, Hostinger
  snapshots) from the deployment plan — not started.
- The stale `192.168.1.0/24` default in `scripts/setup-tailscale-uae-
  office.sh` / `scripts/setup-tailscale-cloud.sh` — flagged, not fixed;
  irrelevant to today's actual bridge (a Windows client was used instead
  of the Linux script) but should be corrected for future Linux
  deployments.
- Outbound calling was not re-tested against the new VPS this session
  (no reason to expect a regression, but not independently confirmed
  either).

---


Last updated: 2026-08-28 (production deploy session). Full detail in
`LLM.md §19`/§20/§21 and the plan file
`~/.claude/plans/sorted-sprouting-crystal.md` (supersedes
`objective-refer-the-handoff-validated-wigderson.md`).

## RE-CORRECTION (2026-08-28, production deploy session): the DISA theory below was wrong — original carrier-barring diagnosis stands

The "CORRECTION" section immediately below this one (same date, an earlier
session) proposed that inbound was actually a Dinstar-side DISA/empty-hotline
issue, not carrier barring, based on a secondhand description of the gateway
answering and playing a "please dial the extension" prompt. That fix (To VOIP
Hotline = `100` on all 8 ports — this device is a UC2000-VE Business with 8
ports, not 4 — and correcting the SIP Trunk's IP, which had gone stale
pointing at an old local-office VM address instead of the new cloud VPS) was
applied for real this session and is still worth keeping: it's correct config
hygiene regardless. **But it did not change the outcome.**

Live-tested against the real hardware, twice, immediately after the fix: both
calls to the SIM logged `FORBID CALL` in the gateway's own GSM Event history,
duration 1s, identical to every other inbound attempt recorded tonight (going
back hours, always the same caller number, always the same result) — and
**zero** SIP traffic ever reached Asterisk for either call (`pjsip set logger
on` + live `docker logs -f` showed nothing at all). If the DISA theory were
correct, a working hotline should have produced a real SIP INVITE this time;
it did not. Every device-side setting that could plausibly cause a
DISA-then-reject pattern was re-checked this session and is clean/default:
Call Limit (no rules), Phone Number Learning (no rules), Digit Map (permissive
catch-all `x.#|x.T`), Basic Configuration's "No Alerting Call Handle" (Normal
Handle), GSM incoming call limit (disabled, `0`/`0`).

**Conclusion: the original diagnosis below (carrier-side incoming-call
barring) is correct and current.** The DISA/empty-hotline theory does not
survive live re-testing. Whatever produced the "please dial the extension"
audio the operator recalls hearing earlier today did not reproduce under
observation this session — possibly a different call, a transient carrier
state, or a misremembered detail; it is not reproducible against the current
hardware state. **Next step is still: contact the SIM's mobile carrier about
incoming-call barring on this number.** Nothing further is fixable from the
Asterisk/Dinstar config side until that clears.

## CORRECTION (2026-08-28, earlier session, SUPERSEDED by the RE-CORRECTION above): inbound is NOT carrier-side barring

The section below this one ("THE headline") concluded inbound calls were
blocked by the carrier before ever reaching the SIP leg, based on a
`FORBID CALL` GSM-layer log and an all-zeros SIP Call History. **New
evidence contradicts that**: a real inbound call to the SIM is **answered
by the Dinstar gateway**, which plays a "please dial the extension"
second-dial-tone prompt, then times out and drops when the caller (who
has no extension to dial) says nothing. A carrier-side block cannot
produce gateway audio — the call would never be answered at all. So the
GSM leg **is** completing; the failure is entirely on the Dinstar side of
the gateway's own inbound routing.

This matches Dinstar UC-series DISA/second-dial-tone behavior, which
triggers when a port's **"To VOIP Hotline"** value is empty: the gateway
answers, waits for the caller to key in a destination extension instead of
routing anywhere automatically, and drops the call on timeout when nothing
is entered. This is consistent with — and probably explains — the "gateway
UI fix for the two-stage-dialing IVR (Port 0 hotline + 'Do Not Answer for
Hotline')" mentioned as "applied and confirmed persisted" two paragraphs
below: that fix may have only ever been applied to Port 0, or didn't
survive, while the other ports (or the same port on a later test) still
have an empty hotline.

**Fix, not yet applied in-session** (needs the Dinstar web UI, not code):
on **all four** GSM ports, set **To VOIP Hotline = `s`** — matching the `s`
extension `[from-dinstar]` already defines in `pbx_configs/extensions.conf`
— confirm each port's Tel→IP routing rule targets the Asterisk SIP trunk
with "Allow Call" enabled, and disable any separate DISA/second-dial
toggle if the firmware exposes one apart from the hotline field itself. No
dialplan change is needed: `extensions.conf`'s `_[+0-9].`/`_X.` catch-alls
already funnel any DID Dinstar sends to `s`.

**Test:** call the SIM. Expect **no prompt** — the call should go straight
to `asterisk -rvvv` showing the INVITE matched to `dinstar-trunk`, entering
`[from-dinstar]`, ringing `support_queue`, and popping in the agent UI with
caller ID. If the prompt is still heard, the hotline value didn't take (or
a different port answered) — re-check per-port, not just the port that was
fixed before. USSD `*#35#` returning `UNKNOWN APPLICATION` (below) may
simply mean that code isn't supported by this carrier for this account
type, not evidence of barring — don't re-chase that lead first.

## THE headline (current — see RE-CORRECTION above): outbound calls carry real two-way audio; inbound is a carrier problem

A call from agent 2002 to a **national-format** number (`0504852446`)
went 100 Trying → 183 → 200 OK → bridged, with **confirmed bidirectional
RTP packets** both legs (Dinstar↔Asterisk and Asterisk↔browser via ICE).
First outbound call with verified real audio, not just signaling.
**E.164 (`+971...`) still gets `480 Temporarily not available`** from the
GSM leg after ~2s — read this as the carrier rejecting that dial format on
this SIM, not a bug; use national format for now.

**[Current — re-confirmed live this session, see RE-CORRECTION above] Inbound is fully diagnosed and is NOT a Dinstar or Asterisk problem.**
Every configurable surface on the gateway was checked and ruled out (Call
Limit, Caller Manipulation, Digit Map, Call Forwarding, Phone Number
Learning/Config, No Alerting Call Handle — all empty/default). The GSM
layer accepts an inbound call just long enough to log it
(`FORBID CALL`, 1s, in GSM Event), then kills it before the device ever
attempts the SIP leg (SIP Call History: all zeros, every port). A USSD
query to the SIM (`*#35#`, standard "query incoming-call-barring status")
came back `UNKNOWN APPLICATION` — the carrier's own supplementary-service
subsystem isn't responding for this line. **Next step: call the SIM's
carrier**, not more config changes.

A gateway-UI fix for the two-stage-dialing IVR (Port 0 hotline + "Do Not
Answer for Hotline") was applied and confirmed persisted, but it's now
moot until the carrier-side barring is resolved — inbound calls don't
reach that logic at all.

**Extended this session** (production deploy): "To VOIP Hotline" set to
`100` on all 8 ports (this device is a UC2000-VE Business, not the 4-port
model earlier notes assumed — ports 4-7 have no modem installed/powered
and ports 1-3 have modems but no SIM; only port 0 is live), and the SIP
Trunk's IP corrected from a stale local-office-VM address to the new
cloud VPS's Tailscale IP. Both are real, correct fixes and stay in place,
but per the RE-CORRECTION above they did not change the live outcome —
inbound is still barred before reaching any of this logic.

## Messaging track (E7–E9, D1–D2) — all 5 items done, verified

Delegated to 5 parallel subagents with exclusive file ownership (zero
collisions), then independently re-verified end-to-end on the combined
tree: typecheck clean, **265/265 tests**, zero lint warnings, clean build.
Full detail in `LLM.md §19`. Headlines:

- **Voicemail badge now has real unread tracking** (was structurally
  impossible before — no seen-state existed). **One thing still needs
  doing before this ships**: the migration (`add_voicemail_seen_at`) was
  hand-written, not applied — run `npx prisma migrate deploy` against the
  real Postgres.
- **Agents can now start a new WhatsApp/SMS conversation** — new
  `POST /api/messaging/conversations` + a compose button in the
  conversation list.
- **New `/admin/contacts` page** (staff-only), CDR caller numbers now
  show names when known.
- **WhatsApp send-400 root cause found and fixed**: the code was sending
  `to` where OpenWA's real API expects `chatId` — verified against
  OpenWA's actual SDK source, not guessed, but **not confirmed against a
  live send** (sidecar unreachable from the fixing session). Worth one
  real test send before trusting it fully. Thread view was only showing
  the top of the conversation due to a flexbox bug (fixed), voice messages
  now play, agent-facing WhatsApp errors are now visible (were invisible
  before).
- **Dinstar SMS provider: real blocker found, not yet fixable in code.**
  Reached the live gateway and confirmed it use a **self-signed TLS
  certificate** — every request this codebase makes to it fails at the
  TLS handshake (`DEPTH_ZERO_SELF_SIGNED_CERT`), confirmed by reproducing
  the exact call, not assumed. SMS cannot work at all until this is
  resolved (install a trusted cert on the device, or add a deliberate,
  narrow TLS-trust exception — a blanket fix was rejected as unsafe).
  Also: the device answers unauthenticated requests with a login-page
  redirect, not a `401` challenge — contradicts an assumption in
  `dinstar-discovery.ts`, flagged for later.

## Done since the above: DINSTAR_SIP_PORT fixed, domain DNS fixed

- **`DINSTAR_SIP_PORT` landmine — fixed, independently re-verified.** The
  wizard now persists the port setting; typecheck/test/lint/build all
  re-run clean (236/236 tests). `docker-compose.yml` was already correct
  and untouched — the deployed `web` container just needs
  `docker compose up -d --no-deps web` to pick up the env var (not run
  this session, to avoid disturbing anything mid-diagnosis).
- **`saharatechs.com` was pointing at an unrelated business's website —
  found and fixed.** The domain's A record was `139.84.171.47` (GoDaddy's
  parked-domain default, coincidentally serving `aceindustry.ae`'s
  WordPress site, which force-redirected everyone), and was
  Cloudflare-proxied (breaking SIP/RTP/WSS regardless). Repointed to the
  office's real public IP (`217.165.236.207`) and switched to DNS-only,
  confirmed via Cloudflare's own resolver. **Port 443/8089/etc. still
  aren't forwarded from the router to the VM** (Phase 5, not started) —
  expect "can't connect" from outside for now, not the login page.

## Also this session

- **Blind transfer bug found, not fixed.** REFER to an external number
  re-dials through the *same busy GSM trunk* the original call is still
  on — Dinstar correctly 503s the overlapping INVITE. Needs a design pass
  (a single-port GSM trunk can't serve an external blind transfer by
  re-dialing itself); not started.
- **`DINSTAR_SIP_PORT` landmine confirmed live, not yet fixed in code.**
  The running trunk is correct only because `pjsip_dinstar.conf` is still
  the build-time seed — `docker-compose.yml:303-305` never forwards
  `DINSTAR_SIP_PORT` into `web`'s environment, and the wizard's apply
  route never persists it to the DB either. First "write Asterisk config"
  click will silently regress the trunk to `:5060`. Two-line fix
  identified, queued.
- **Cabling reality corrected.** There has never been an Ethernet run from
  the office router to this PC — only the direct Dinstar cable. Mid-session
  move to the router stranded the Dinstar on the wrong subnet; reverted.
  The LAN-flatten phase (Phase 2 of the plan) is now gated on a cable run
  that doesn't exist yet; nothing else needed it.
- **Messaging track now runs in parallel**, not last (operator reversed the
  standing instruction). Current-state mapped for all 5 items (E7 badge
  staleness, E8 no-new-conversation route, E9 no Contacts page, D1 error
  surfacing, D2 unverified SMS provider). New specifics from the operator:
  WhatsApp send returns `400` from the OpenWA sidecar, admin chat UI shows
  only the last message (needs a real WhatsApp-Web-style thread view, no
  status/settings buttons), voice messages aren't playable, inbound needs
  a manual refresh. All queued in the plan's Phase 6, nothing started.
- **Git: repo confirmed PUBLIC** (`github.com/deepakt369b-droid/algo-pbx`).
  The "~110 uncommitted files" note below is **stale** — actual working
  tree was 2 files. Operator was told what a push publishes (topology,
  firewall matrix, domain, Dinstar/Tailscale design) and decided to push
  anyway. Work queued (delete `.jetro/` debris, commit, push `main` as a
  new branch alongside the unrelated `master`), not yet executed.

## Automation note for next session

Two things fought the browser-automation tooling on the Dinstar's legacy
frame-based UI: (1) a native `confirm()` dialog on device restart blocks
CDP entirely (`Input.dispatchMouseEvent`/`Runtime.evaluate` both hang) —
no way found to dismiss it programmatically, operator had to click it
manually both times; (2) a DOM query for a radio group's checked value
without also capturing which `value` was checked produced a real false
positive this session ("No Alerting Call Handle" was wrongly reported as
`Hang Up`, corrected once the query included `value`). Direct frame
navigation via `window.frames['mainframe'].location.href = ...` worked
more reliably than clicking the legacy menu tree.

---
## Older context below

## THE headline: the softphone call path works end to end for the first time

A `security-audit`-skill pass + a `systematic-debugging` boundary-by-boundary
sweep found that "not a real working PBX" was **six stacked bugs**, each
masking the next:

1. `pbx_configs/manager.conf` AMI account had no `command` write class →
   every config reload denied. **Fixed.**
2. `src/lib/ami-client.ts` `send()` never checked `Response: Error` → the
   denial looked like success. *This is why 3 prior sessions blamed a
   "flaky Asterisk build".* **Fixed + tests.**
3. This from-source Asterisk 20 has **no `pjsip reload` command** (only
   `module reload res_pjsip.so`). **Fixed in all 3 provision files.**
4. `res_srtp` was **never compiled** — `libsrtp2-dev` missing from
   `Dockerfile.asterisk`. **Rebuilt with it; `res_srtp.so` now Running.**
5. Generated WebRTC endpoints used `dtls_private_key_file` (wrong option;
   it's `dtls_private_key`) AND named the AOR `<n>-aor` (PJSIP's registrar
   looks for an AOR named `<n>` from the `To:` header → `404 AOR '' not
   found` on every REGISTER). **Both fixed in `src/lib/pjsip-config.ts`.**
6. `Web.SessionManager` ignores its `server` constructor arg when
   `userAgentOptions.transportOptions` is set → transport got `""` →
   "Invalid WebSocket Server URL" **crashed the whole React app on every
   page**. **Fixed in `src/contexts/sip-context.tsx` + fail-soft guard.**

**VERIFIED LIVE:** agent registered over WSS (digest auth + REGISTER +
contact bound) → dialed `*97` → call `Up` → Asterisk RTP **150 rx / 128 tx
packets, 0% loss, alaw** — bidirectional DTLS-SRTP media. First call this
codebase has ever carried.

## Networking: bridged NIC already solves the office case

The VM's second NIC (`enp0s8`, VBox bridged) is **already on the Dinstar
LAN at `192.168.11.20`** — pings the Dinstar directly, and the host PC
reaches the VM there. **No Tailscale needed for this office.** For the
browser test: VBox `natpf1` for 8089, `ufw allow 8089/443/tcp`, and a
Windows hosts entry `192.168.11.20 saharatechs.com` (valid LE cert on the
WSS port). Remote agents (India) still need a router port-forward or cloud
VM — the NAT NIC can't forward RTP.

## Also done this session

- **B3b** — new `pbx_configs/asterisk-entrypoint.sh` renders
  `manager.conf`/`odbc.ini` from `.env` at container start (mounted r/o at
  `*.tmpl`). **Stops the recurring "resync reverts the secret to
  REPLACE_ME_" failure** that bit this deploy twice today.
- **A5** — new `algo-pbx-frontend/docker-entrypoint.sh` runs as root,
  `chown`s the bind-mounted generated configs to `nextjs` (uid 1001), then
  `su-exec`s down. Fixes the EACCES-on-every-provision UID mismatch
  permanently (verified: files are now `1001:1001`).
- **Security (from the `security-audit` skill), all deployed:** B0 web
  bound to `127.0.0.1:3000` + firewall REJECT (was cleartext on every
  interface bypassing Caddy); B1 login-lockout `X-Forwarded-For[0]` bypass
  → unauth ADMIN takeover, now uses the proxy-appended entry + an
  email-only aggregate bucket; B1c `AUTH_SECRET` strength check (rejects
  `change-me`); B2 agent toll-fraud via `/api/calls/conference` (bypassed
  dial tiers + DNC + emergency block) now routes through
  `Local/…@from-agent-<tier>`; B2b jwt callback re-reads `role`/`extension`
  live (demotion was ≤8h); B3 SUPERVISOR could silently harvest any
  extension's plaintext SIP secret/PIN — now ADMIN-only + audited; B4
  voicemail-config DoS by a comma in an agent's name, Dinstar-probe SSRF,
  CF-token newline injection — all validated.
- **E1** — admin can now edit agent accounts (name/email/role/password/
  SIM-port/extension) + hard-delete. New `PATCH`/`DELETE` on
  `/api/admin/users/[id]` + an edit drawer. **Verified live.**
- **E2** — Cloudflare "token rejected" now surfaces the real CF error/code
  and queries `/zones?name=` per apex instead of un-paginated `per_page=50`.
- **E6** — new **`/admin/recordings`** page (was missing entirely) — list,
  playback, download, hide/unhide, ADMIN hard-delete, nav link. **Verified
  live.**
- **Track C (code)** — `[from-dinstar]` gained `_[+0-9].` / `_X.`
  catch-alls so a gateway-config change can't silently drop inbound calls.

## OUTBOUND CALL TEST (2026-08-27, third follow-up) — Asterisk side DONE, Dinstar side blocked

Placed a real outbound call from agent 2002's softphone to `+971544887712`.
**Everything on the Asterisk side works and is verified in the SIP trace:**
tier match (2002=NATIONAL, +971 allowed) -> DNC check (ODBC live, not
blocked) -> `+` stripped (`DIALNUM=971544887712`) -> MixMonitor started
(outbound recording file created) -> INVITE to `PJSIP/...@dinstar-trunk`.

**The GSM leg fails: the Dinstar returns `503 Service Unavailable`** (was
`404` before the SIP-port fix below). The gateway's "IP to GSM Call History"
is all zeros — rejected at the SIP layer before any GSM port is tried.

### Fixes this session that got the call this far
- **Dinstar SIP port** was hardcoded `:5060` in `src/lib/dinstar-config.ts`
  but the UC2000 was moved to `:5061`. New `DINSTAR_SIP_PORT` setting +
  env var; seed conf + `.env.example` + VM `.env` all set to `5061`.
- `from-agent-common` / `-international` / `from-dinstar` matched only
  `_X.` -> `+`-prefixed E.164 fell through to `603 Decline`. Now `_[+0-9].`.
- Added `MixMonitor` to `from-agent-common` -> **outbound calls record too**.
- `cdr_manager.so` shipped Not Running (no `cdr_manager.conf`) -> Asterisk
  never emitted the `Cdr` AMI event. Added it. Verified: `*97` now writes
  a `CallDetailRecord` row.

### DINSTAR UI — do next (login admin / @dmin2026 at 192.168.11.1)

**Already changed by Claude this session:** Call Configuration -> IP->Tel
Routing -> rule "default" (index 63): **Source** `SIP Server` -> `Trunk-0
<AlgoPBX>`. The rule expected register-mode but Asterisk connects as a
trunk peer — this mismatch is the most likely `503` cause. **Confirm it
stuck, then re-test the outbound call.**

If still 503, check in order:
1. **Call Configuration -> SIP Configuration** — gateway's own **Local SIP
   Port** must be **5061**.
2. **Call Configuration -> Port Group Configuration** — open `port-group-0`,
   confirm **Port 0 is a member**.
3. **Call Configuration -> SIP Trunk Configuration** -> trunk 0 — no
   "auth/register required" toggle; plain peer trunk.
4. **Number format** — Asterisk sends `971544887712`. If the SIM rejects it,
   on the IP->Tel rule (Advanced Rules) set **Digits to Delete = 3** +
   **Prefix to Add = 0** -> `0544887712` (UAE national).

For inbound (issue #6):
5. **Call Configuration -> Tel->IP Routing** — confirm a rule: Source
   `Port Group-0` -> Destination `sip-trunk-0 <AlgoPBX>`.
6. **Call Configuration -> Port Configuration / Port Group** — set
   **"Two-Stage Dialing" / "Secondary Dialtone" / "Call-In Mode"** to
   **one-stage / forward directly with a fixed called number (`s`)**, NOT
   "collect number from caller". That stops the extension prompt.

After changes: **Save** (watch for a "not saved" flag; some need reboot).

### Confirmed healthy in the Dinstar UI (no change)
- SIP Trunk 0: `192.168.11.20:5060` "AlgoPBX", KeepAlive Yes
- Digit Map: `x.#|x.T`
- Port 0: SIM registered, IMSI `42402...`, full signal, Idle
- Device: UC2000-VE Business, 8 GSM ports

## Still pending (plan order)

1. **The Dinstar UI checklist above** — then the real outbound GSM call +
   recording, then the inbound GSM call (issue #6). The Asterisk half of
   both is done.
2. Deploy the rebuilt Asterisk image (A5 + B3b entrypoints, res_srtp).
3. **Track E5** — full agent feature matrix (blind/attended transfer,
   3-way conference, manager escalation, DNC block, dial-permission tiers,
   voicemail leave/play/delete). Needs two browser profiles or a second
   device.
4. **cdr-listener** — a `*97` test call produced NO `CallDetailRecord`.
   Verify the listener ingests real `Cdr` events (recordings only fire for
   `[from-dinstar]` inbound, so `*97` won't record — but a CDR should exist).
5. **Messaging track (user said do this LAST):**
   - E7 agent navbar Missed/Voicemail counts are STALE — fix the source
   - E8 start a NEW WhatsApp/SMS conversation (currently reply-only)
   - E9 **Contacts page** — save customer name, initiate chats from there,
     show names not raw numbers (`Contact.displayName` already in schema)
   - D1 WhatsApp instance-error surfacing; D2 SMS receive verification
     against the real Dinstar API response (current probe 302s — creds or
     API path need checking against the live UC2000)
6. **Credentials** — `admin@`/`agent@`/`agent2@` are all `TestPass123!`
   (agent* set directly via DB this session, hash was mangled by bash `$`
   expansion first — use a SQL file, not an inline `-c`). Rotate before
   real use.
7. Commit the ~110 uncommitted files (git still has just "Initial commit").

---
## Older context below


## What was asked (this follow-up)

Direct continuation of the live-VM session below. The user: (1) fixed the
VirtualBox NIC's ARP-offload setting when asked, unblocking VM↔LAN
networking; (2) asked to configure the Dinstar gateway's own web UI for
the now-inserted real UAE SIM and to place a real outbound test call from
an agent extension to `+971544887712`; (3) in parallel, walked through
connecting `saharatechs.com` (already live on Cloudflare) via the admin
panel's Domain & TLS section. Both threads surfaced real, previously-
undiscovered bugs in the deployment pipeline itself — not app bugs, but
bugs in the *mechanism* that gets code and config from this repo onto the
running containers. Full technical detail in `LLM.md` §16 and the memory
file cited above; this section is the short version.

## State at end of this session

**Dinstar + SIM — done and verified:**
- The Dinstar's SIP Trunk config pointed at the wrong machine
  (`192.168.11.10`, this Windows PC, not the VM) on the wrong port
  (`5080`, not Asterisk's `5060`) — a leftover from an earlier session.
  Fixed to `192.168.11.20:5060`.
- Setting the trunk port to `5060` silently failed to save every time,
  with no error — traced to the Dinstar refusing a trunk peer port equal
  to its **own** local SIP port (also `5060` by default). Fixed by moving
  the Dinstar's own local SIP port to `5061` (a device-level setting,
  `Call Configuration → SIP Configuration`), which needed a device
  restart to take effect — also fixed a second problem, since GSM modules
  on this device apparently only read SIM-card presence at power-on, not
  on hot-insertion. Port 0 now shows **"Mobile Registered"** with a real
  UAE IMSI (`4240...`) and strong signal.
- Both call-routing directions (`Port Group-0 → Trunk-0` for inbound,
  `SIP Server → Port Group-0` for outbound) were already correctly
  pre-configured from an earlier session — nothing to do there.
- One real inbound test call was placed (user's own phone → the SIM) and
  it rang through to the point of asking for an extension number — proof
  the GSM→Asterisk inbound path works. **Not yet done:** the reverse test
  (an agent's WebRTC extension dialing out to `+971544887712` through the
  trunk) — extensions were provisioned for this but got blocked by the
  bugs below, and the actual call was never placed before this session
  ended.

**Domain (`saharatechs.com`) — done and verified for real:**
A genuine Let's Encrypt certificate was issued via Cloudflare DNS-01 and
confirmed in Caddy's own logs (`"certificate obtained successfully"`).
Getting there required finding and fixing four separate, real bugs (all
described in full in `LLM.md` §16 / the memory file):
1. The `web` container runs as a different Linux UID than every
   generated config file's on-disk owner, so **every** admin-panel action
   that regenerates a config file (provisioning an extension, connecting
   the Dinstar trunk, connecting the domain) failed with `EACCES:
   permission denied` — worked around with `chmod 666`/`777` on the
   affected files/directory; needs a real fix (matching UIDs, or a
   deploy-time `chown` step) so this doesn't recur on the next full sync.
2. `cert-sync` (the only container with Docker-socket access, tasked
   with recreating `caddy` when domain settings change) was invoking
   `docker compose` with a host-only path that its own container
   filesystem can't read — always failed with `no such file or
   directory`. Fixed in `scripts/cert-sync.sh` by symlinking the
   discovered host path to its own `/workspace` bind-mount.
3. Even after that fix, `docker compose up -d` silently no-op'd when only
   a bind-mounted file's *content* changed (not the service definition) —
   Caddy kept serving its original boot-time config indefinitely. Fixed
   by adding `--force-recreate`.
4. `cert-sync`'s own `VM_PUBLIC_DOMAIN` came from `.env` (baked in at
   container-create time), which still held the placeholder `127.0.0.1`
   — the *real* domain only ever got written to the database and to
   Caddy's own generated env file, never back to `.env`. Fixed by
   updating `.env` directly and recreating `cert-sync`. **This is a real
   design gap worth revisiting**: there are now two independent sources
   of truth for the public domain (`AppSetting` in Postgres vs. `.env`),
   and they can silently drift exactly like this again.
- **Not yet confirmed at end of session:** whether `cert-sync` has
  actually copied the new cert into `pbx_configs/keys/fullchain.pem` /
  `privkey.pem` and restarted Asterisk/Coturn to pick it up — the check
  was in progress when this session ended. `pbx_configs/keys/` currently
  only has the self-signed DTLS media cert (see below), not yet the real
  WSS-signaling cert.
- A **separate, real bug found along the way**: `/etc/asterisk/keys/` had
  never been populated at all (only its own README) — every generated
  WebRTC PJSIP endpoint references `dtls_cert_file`/
  `dtls_private_key_file` paths that didn't exist. This silently blocks
  Asterisk from loading **any** WebRTC extension endpoint at all (see
  below) — the DTLS cert is deliberately self-signed (fine, validated by
  fingerprint not chain-of-trust); generated one with a plain `openssl
  req` command per that directory's own README.

**The real underlying lesson, expensive to learn:** most of tonight's
"why doesn't this take effect" mysteries — for extensions, for the
domain, for Dinstar credentials — traced back to **the deployed `web`
Docker image being stale relative to this repo's actual source**, not to
any bug in the source itself. A `docker compose restart web` (used
constantly, all session) restarts the *existing* image; it does not
rebuild. A large amount of debugging time went into things that turned
out to be explained entirely by testing against old compiled code. Fixed
this session by doing a full `git ls-files` + untracked-non-ignored sync
of the whole repo to the VM and `docker compose build web` — but this
needs to become a routine step (`docker compose up -d --build`, not
`restart`) for every future deploy from this point on, not a one-off.

**Also discovered, not yet resolved:** provisioning extensions `2001`
and `2002` via `/admin/extensions` appeared to fail to load into
Asterisk's live PJSIP config even after the permission bug above was
fixed — extensive bisection (isolating field-by-field, with/without
comments, minimal vs. full config) traced this specifically to the
`dtls_cert_file`/`dtls_private_key_file` lines only being reliably
testable via a genuine full container restart (not `module reload`,
which — consistent with the pattern below — reported false success
repeatedly). This investigation was still open, chasing whether the DTLS
cert-file bug above explains it fully, when the domain-debugging thread
took priority. **Needs re-verification** now that both the DTLS certs
exist and the `web` image has been rebuilt — recreate extensions 2001/
2002 (or reuse the existing DB rows) and confirm via a full
`docker compose restart asterisk` + `pjsip show endpoints`.

**A second, independent unreliability pattern confirmed repeatedly
tonight**, separate from the stale-image issue: this specific Asterisk
build's `module reload <x>.so` and `manager reload` commands report
success and can even show partially-correct state, while **not actually
applying the change** — confirmed for `manager.conf` AMI secrets,
`musiconhold.conf` classes, and PJSIP endpoint definitions. Only a full
`docker compose restart asterisk` reliably reflects reality. Treat any
`reload`-style command's own "success" report as unproven until verified
with a full restart.

**Password note:** `admin@algopbx.local` and `agent@algopbx.local` both
currently have the password `TestPass123!` (agent2@algopbx.local has
`TestPass123!Agent`), set directly via DB for tonight's testing since the
original credentials weren't available. **Change these before any real
use** — this is a live, spoken-aloud-in-this-file password on a box with
a real inbound trunk now working.

## Immediate next steps for whoever picks this up

1. Confirm `cert-sync` copied the real cert to `pbx_configs/keys/` and
   restarted Asterisk/Coturn — check `docker logs algo-cert-sync` for a
   "new certificate detected" line, and `ls pbx_configs/keys/` for
   `fullchain.pem`/`privkey.pem` with a recent timestamp.
2. Re-verify extensions `2001`/`2002` actually load
   (`pjsip show endpoints` after a full `docker compose restart asterisk`)
   now that the DTLS certs exist and the image is fresh.
3. Place the actual outbound test call from an agent WebRTC softphone to
   `+971544887712` through the Dinstar trunk — the one test this session
   never got to.
4. Fix the `web`-container-UID-vs-generated-file-owner mismatch properly
   (not just `chmod`) so it doesn't silently break again on the next
   sync — see the memory file for the exact files affected.
5. Decide how to keep `VM_PUBLIC_DOMAIN` in `.env` and in the database in
   sync going forward, or make `cert-sync` read the domain from
   `caddy.env` instead of its own separate env var.
6. Change the temporary passwords above.
7. Going forward, deploy code changes to this VM with
   `docker compose up -d --build web` (or the relevant service), never a
   plain `restart` — this session lost significant time treating a stale
   image as a source-code bug.

---

## Previous session (2026-08-27, live-VM verification: full redeploy)

Last updated: 2026-08-27 (same-day follow-up). Full changelog in `LLM.md`
§15; this file tracks what was done and what still needs a human.

## What was asked (latest session, 2026-08-27 live-VM follow-up)

Direct continuation of the planning session below: the user granted live
SSH access to the cloud VM and asked for a full redeploy of everything
built that day, then — after most of the stack was verified healthy —
specifically flagged that Dinstar scanning/connection was still not
working and asked for a real domain to be connected so the system could
be tested from India. This is the first time this repo's
`docker-compose.yml` has ever been brought up in full on real
infrastructure.

## State at end of session

**Done and verified live (not just typechecked):**
- Asterisk is now genuinely containerized from this repo's own configs
  (`Dockerfile.asterisk`, new) — three build/runtime bugs found and fixed
  (missing build deps, shared-library packaging, missing `modules.conf`).
  `pjsip show endpoints` and `odbc show` both confirm real config in
  force, closing the "split-brain"/"ODBC unverified" questions carried
  since Phase A/C.
- `cdr-listener` is genuinely healthy and connected to AMI — took four
  layered fixes to get there: a stale Docker DNS cache, a missing `ufw`
  rule for the Docker-bridge→AMI path (added to `scripts/setup-firewall.sh`),
  `manager.conf` secrets that a full-repo sync had silently reverted to
  placeholders, and — the most surprising one — this Asterisk build's
  `manager reload` not actually reloading secrets; only a full container
  restart does.
- Hold music now actually plays — `moh show classes` was silently coming
  back empty (no error, ever) with a relative `directory=` path; only an
  absolute path registers a class in this specific build. Fixed in
  `pbx_configs/musiconhold.conf`.
- All 8 services (`postgres`, `coturn`, `asterisk`, `web`, `cdr-listener`,
  `cert-sync`, `openwa`, `caddy`) report healthy via `docker compose ps`.
- Domain automation's biggest risk is resolved: `algo-caddy` is already
  running the new `xcaddy` build with the Cloudflare DNS-01 plugin loaded
  and confirmed (`caddy list-modules`).
- `scripts/backup.sh` was run for real and a full restore drill completed
  (restored into a disposable scratch Postgres container, confirmed real
  data landed, then torn down) — first time this repo's backup path has
  been proven to actually work, not just exist.
- Tailscale (previously not installed at all) is now installed on the
  cloud VM and `tailscale up --accept-routes` is running in the
  background with a pending device-auth link.

**Still needs a human, in priority order:**
1. **Open the pending Tailscale auth link** (printed to the VM's
   `/tmp/tailscale-up.log`, or re-run `sudo tailscale up`) while logged
   into the office Tailscale account, and approve it — this is an
   account-linking action Claude cannot complete on your behalf.
2. **Run `scripts/setup-tailscale-uae-office.sh` on a PC on the Dinstar's
   own LAN in UAE**, then approve the advertised subnet route at
   https://login.tailscale.com → Machines. No access to that machine
   exists from this session — Dinstar scanning cannot work at all until
   this half is done, regardless of anything else.
3. **Switch the `algo_pbx` VM from VirtualBox NAT to Bridged Adapter.**
   Confirmed still on NAT (`10.0.2.15`, gateway `10.0.2.2`) via both the
   VM's own `ip route` and `VBoxManage showvminfo algo_pbx` from the
   Windows host. This is the real blocker for "test from India" — NAT
   cannot forward the RTP port ranges, so even a fully-working domain +
   Tailscale setup will connect calls with **no audio**. Deliberately not
   attempted this session: `handoff.md`'s own 2026-08-26 section records
   Bridged Adapter was tried once before and failed with an unresolved
   timeout, and flipping a running VM's NIC type risks cutting off the
   only SSH path back into it.
4. **Give the real domain name + a Cloudflare API token** (DNS-edit scope
   on that zone, after GoDaddy's nameservers point at Cloudflare) — the
   automation is ready and tested, `VM_PUBLIC_DOMAIN` just still reads
   the placeholder `127.0.0.1`.
5. **Say yes to scheduling cron** — backup (2am daily + 14-day cleanup),
   the recording/voicemail prune job, and the SMS poller are all built
   and manually verified working, but installing a crontab is a standing
   config change this session's safety rules require your explicit go-
   ahead for. The exact lines are ready to install the moment you confirm.

Full technical detail on every fix above (exact root causes, exact
commands, exact bytes changed) is in `LLM.md` §15 — this file stays the
short version.

---

## Previous session (2026-08-27, planning pass): production-readiness re-audit + manager escalation + domain automation (design)

Last updated: 2026-08-27. Full changelog in `LLM.md` §14; this file tracks
what was done and what still needs a human.

## What was asked (latest session, 2026-08-27)

Continuation of the 2026-08-26 VM-repair session (see that section below):
an admin-panel walkthrough found Dinstar scanning broken, voice recording
"missing," no agent sign-out, and no manager-escalation concept; the user
also wanted a real domain (GoDaddy → Cloudflare) connected from the admin
panel. Asked for a loop-engineering-style plan, then a re-audit of that
plan specifically to find gaps before treating it as production-ready —
that re-audit (prompted by the user directly) surfaced a second, larger
class of day-one risks the first pass hadn't caught (see below). **No VM/
Docker access was available in this session** (confirmed: no `docker`
binary, no known SSH host) — everything below is real, committed-to-disk
code, verified via `tsc`/`vitest`/`eslint`/`next build`, but **none of it
has been run against live Asterisk/Docker/a VM in this session**. The 2026-
08-26 VM is still where all of this needs to be redeployed and actually
tested.

## State at end of session (2026-08-27)

**Done and verified (typecheck/test/lint/build all clean, 204/204 tests):**
- Deleted `secrets_temp.txt` (untracked, held real fresh secrets from the
  prior session) — **rotate everything it contained**, treat it as burned.
- `src/middleware.ts` rewritten to build every redirect from the real
  `x-forwarded-host`/`host` headers instead of `req.nextUrl.origin` — the
  best current fix for the AGENT-login bounce below, not yet confirmed
  against a live login. A temporary diagnostic log is still in there,
  flagged for removal once confirmed.
- Dinstar scan now classifies WHY it found nothing (timeout/refused/
  no-route) instead of a flat "no devices" — likely root cause traced to
  either the Tailscale route never being approved, or a too-tight
  timeout; both are now distinguishable.
- `cdr-listener` (the process that makes call recordings actually appear)
  gained a heartbeat healthcheck — it had NONE before, so a silent crash
  there produced exactly the "recording missing" symptom with zero
  visibility. Recording itself was already fully wired; this was a
  diagnosis, not a rebuild.
- `/agent` gained real page chrome (sign-out, connection status) — it had
  none before. Hold/transfer were already correct.
- Inbound calls now ring (audio + browser notification) — there was
  **zero** call/voicemail/WhatsApp notification anywhere in this codebase
  before this session. Missed-calls list, and voicemail/WhatsApp/missed
  unread badges, all new.
- **Manager escalation** (fully new feature): admin-managed named list,
  agent picks one from a dropdown mid-call, existing transfer mechanism
  reused, busy/no-answer detected via AMI and both WhatsApp-pinged and
  logged at `/admin/escalations`.
- **Per-agent dial permissions / toll-fraud guard** (fully new feature):
  the outbound dialplan was wide open to any number before this — now a
  three-tier (LOCAL/NATIONAL/INTERNATIONAL) permission per extension,
  editable in `/admin/extensions`, plus a hard-blocked satellite/premium
  list and an emergency-number misdial guard that no tier can bypass.
- **Domain connect automation** (fully new feature, highest-risk item in
  this pass — test this one first, off-production): Caddy now issues its
  own Let's Encrypt cert via Cloudflare DNS-01 from `/admin/settings`,
  with a new `cert-sync` service (the only container in the stack with
  Docker-socket access — a deliberate, flagged tradeoff) bridging that
  cert to Asterisk/Coturn and recreating Caddy when the domain changes.
  Manual certbot kept as documented fallback.
- Docker log rotation applied to all 8 services (none had any before);
  healthchecks added to `coturn` and `caddy` (neither had one before).
- **Self-service + admin-triggered password reset** (fully new — there
  was NO reset path at all before): WhatsApp-OTP self-service at
  `/forgot-password`, plus a "Send reset" button in `/admin/users` reusing
  the existing onboarding-invite link mechanism. A reset now kills every
  other outstanding session on its next request.
- **`sipSecret` rotation + real extension hard-delete** (`/admin/extensions`)
  and an **`/admin/audit` viewer** — `AuditLog` rows have been written
  since an early session but nothing ever displayed them until now.
- **Disk safety**: `pbx_configs/logger.conf` added; a 90-day (admin-
  configurable) recording/voicemail prune job
  (`POST /api/admin/maintenance/prune`, needs a new `PRUNE_SECRET` cron
  secret in `.env`); a disk-space health check in `/admin/system`.
- **Queue capacity + overflow**: `queues.conf`'s dev-only `joinempty=yes`
  flipped to `no`, `maxlen` set to 4 (matching the Dinstar gateway's real
  4-port ceiling) — a caller who previously got silence-then-hangup on any
  non-answered outcome now reaches a real "Office Overflow" voicemail
  (mailbox `9000`).
- **Business-hours routing was offered and explicitly declined for now**
  (asked; user said skip rather than have real hours guessed at) — queue
  stays open 24/7 until real hours are specified in a future session.

**Not done — designed and sequenced in this session's plan file, next up:**
hold-music AND ringtone audio files (both blocked on your explicit
go-ahead to fetch a specific CC0 source — tell me which files/sources and
I'll wire them in), the DNC/permission-blocked dialplan announcements
(same audio blocker, currently placeholder prompt names), business hours
(see above, need real hours from you), backup cron scheduling + a restore
drill (`scripts/backup.sh` already exists, never actually scheduled or
run), image digest-pinning, containerizing Asterisk for real (it's still
split-brain — see the 2026-08-26 section below, unchanged this session),
and the VM's NAT-networking/1-vCPU-capacity problem (also unchanged,
still needs Bridged Adapter + real diagnosis).

## Immediate next steps for whoever has VM access

1. Rotate every secret `secrets_temp.txt` held.
2. Redeploy this code to the VM, confirm the AGENT-login fix actually
   works in-browser (the diagnostic log in `middleware.ts` will show
   whether the sealed-URL bug reached middleware itself — remove the log
   once confirmed either way).
3. Run `bash scripts/render-caddy-env.sh` **before** `docker compose up`
   if adopting the new Caddy/cert-sync setup, or revert to the old
   `caddy:2-alpine` + manual-certbot config first (see `DEPLOYMENT.md`'s
   TLS section for exact revert steps) if not ready to grant `cert-sync`
   Docker-socket access yet.
4. Add `PRUNE_SECRET` to `.env` (generate with `openssl rand -hex 32`) if
   you want the recording/voicemail prune cron to work unattended — the
   route also works via an interactive admin session with no secret set.
5. Everything under "Not done" above, plus the still-unresolved Asterisk
   split-brain and VM networking/capacity problems from 2026-08-26.

---

## Previous session (2026-08-26): VM deployment repair, unified-login bug hunt

## What was asked (2026-08-26)

The `algo_pbx` VirtualBox VM (brought up 2026-08-25/26 by a prior local
agent — openclaw, no exec capability of its own) was reachable at
`http://127.0.0.1:3000` but login failed outright, the landing page showed a
stale admin/agent split, and OpenWA's settings-page "Test connection" button
errored. Asked to fix all of it autonomously, get a real login working, and
push toward a first live call through the Dinstar trunk.

## State at end of session

**Working:** unified single-login landing page confirmed live in-browser;
**ADMIN login verified end-to-end in the browser** (signs in, lands on
`/admin`, wallboard renders); all 5 non-Asterisk/Caddy containers
(postgres/coturn/web/cdr-listener/openwa) up healthy; OpenWA API
authenticates (`/admin/settings` test button now passes).

**Still broken — the one thing to pick up first tomorrow:** AGENT-role login
completes the password check (`pre-login` returns `{needs2fa:false,
role:"AGENT"}`, cookie set) but then bounces back to `/login` instead of
reaching `/agent` or `/register`. Root-caused as far as: Next.js's compiled
runtime (`/app/node_modules/next/dist/compiled/next-server/
app-route.runtime.prod.js` inside the `web` container) contains an internal
"sealed" `NextURL` proxy that forces `host` to the **hardcoded literal
`localhost:3000`** for certain requests' `.href`/`.toString()`. Confirmed via
direct `curl` against `POST /api/auth/callback/credentials` (bypassing the
browser entirely): the `Location` response header comes back as a bare
`http://localhost:3000` — no path — even though the request was made to
`127.0.0.1`, `AUTH_URL`/`AUTH_TRUST_HOST` are both correctly set inside the
container, `trustHost: true` was added explicitly to `auth.config.ts`, and
`export const dynamic = "force-dynamic"` was added to
`src/app/api/auth/[...nextauth]/route.ts` — **none of those three fixes
changed the behavior at all.** ADMIN logins never hit this because the client
calls `signIn(..., {redirect:false})` and does its own `router.push()`
locally, so ADMIN never depends on that broken `Location` header — but
something in the AGENT path still ends up following it (the browser's address
bar genuinely changes origin, confirmed via `tabs_context_mcp`).

**Most promising next lead, not yet tried:** `src/middleware.ts`'s own
`NextResponse.redirect(new URL("/register", req.nextUrl.origin))` branch
(the one that only fires for `isAgentRoute && role==='AGENT' &&
!profileComplete`) is a *second*, separate code path that could be hitting
the exact same "sealed" `NextURL` mechanism — middleware is the one thing
ADMIN's login flow never exercises (it never needs a mid-flow redirect) while
AGENT's flow always does. Test this by adding a diagnostic
`console.log(req.nextUrl.origin, req.nextUrl.href)` inside that middleware
branch and checking `docker logs algo-web` on a real agent login attempt — if
that log line itself already shows `localhost:3000`, the bug is in
middleware's request object, not Auth.js's callback route, and the fix target
changes completely (would need a workaround that doesn't rely on
`req.nextUrl.origin` at all, e.g. reading `x-forwarded-host`/`host` header
directly and constructing the URL by hand). Two credentials to sign in with
are in this session's transcript (`admin@algopbx.local` / `agent@algopbx.local`)
— rotate both once real ones exist.

## Other fixes made this session (all verified, all still in place)

- **Landing page / unified login was never actually broken in the repo** —
  the VM was just running a stale pre-refactor checkout (two separate
  "Agent Workspace"/"Admin Dashboard" buttons linking straight past login).
  Re-synced the full current tree (tar over SFTP, `git ls-files`-scoped so
  `.env`/`.git`/`asterisk-source`/runtime dirs were never touched) — confirms
  `src/app/page.tsx`'s single "Sign In" button and `login-form.tsx`'s
  role-based redirect were already correct in this repo.
- **Real login-silent-failure bug fixed for real:** `login-form.tsx` called
  `res.json()` before checking `res.ok`, with no `catch` — a non-JSON 500 from
  `/api/auth-2fa/pre-login` (which, unlike every other auth route, wasn't
  wrapped in `withApiErrorHandler`) made the Sign In button just un-spin with
  no error shown. Fixed both auth-2fa routes + the client's error handling.
- **`.env` on the VM was corrupted** (missing `DATABASE_URL` entirely, wrong
  `AUTH_URL`, a literal stray `EOF` line from a prior failed heredoc) —
  rebuilt clean from `.env.example` with **all-fresh secrets** (per explicit
  instruction), uploaded as one atomic SFTP write, no more `>>`/heredoc
  corruption risk.
- **Postgres volume wiped and reinitialized** (was `postgres`/`postgres`
  from hand-run SQL, didn't match any `.env`) — now `algopbx`/`algopbx_db`,
  migrations applied fresh, admin/agent accounts created via the *real*
  `scripts/create-admin-user.mjs` path (bcrypt cost 12) instead of the
  fabricated hash a prior session hand-inserted.
- **Docker builds on this VM were failing/hanging for three independent
  reasons**, all now fixed:
  1. IPv6 is completely non-functional under this VirtualBox NAT config —
     was causing intermittent DNS/registry failures. Disabled persistently
     (`/etc/sysctl.d/99-disable-ipv6.conf`).
  2. The VM's kernel was in **near-continuous soft-lockup** under any
     sustained compile load (confirmed via `dmesg`: `CPU#0/#1 stuck for
     50-80s`, repeating almost every minute, with an explicit "OOM is now
     expected behavior" RCU warning) — this is why the *first* build attempt
     ran 90+ minutes and never finished. Ruled out host CPU contention
     (host was 13.7% busy), VM execution cap (100%, uncapped), Windows power
     plan (tried High Performance, no change), and a Defender exclusion
     (tried, no change). **Fix that actually worked:** reduced `algo_pbx`
     from 2 vCPUs to 1 (`VBoxManage modifyvm algo_pbx --cpus 1`) — zero
     lockups since, and the next build finished in a few minutes instead of
     never.
  3. Next.js's own lockfile-integrity check tried a live npm-registry fetch
     mid-build and hung forever when it failed — worked around with
     `ENV NEXT_IGNORE_INCORRECT_LOCKFILE=1` in the Dockerfile's builder stage.
  4. Two stale leftover component files on the VM (`gradient-background.tsx`,
     `pairing-card.tsx` — both replaced by newer files in this repo but never
     deleted by the additive-only re-sync) broke `next build`'s type-check
     until removed.
- **`web` container came up but its own healthcheck failed forever** despite
  the app genuinely being ready — Next.js standalone's generated `server.js`
  binds to `process.env.HOSTNAME` if set, and Docker auto-sets `HOSTNAME` to
  the container's own hostname (which only resolves to its bridge IP, not
  loopback), so the app never listened on `127.0.0.1`/`::1` at all inside its
  own namespace. External access via the published port worked fine the whole
  time (Docker's port-publish NATs straight to the container's real IP), which
  is why this was easy to miss. Fixed with an explicit `HOSTNAME: "0.0.0.0"`
  in `docker-compose.yml`'s `web` service.
- **OpenWA "Test connection" was failing** because OpenWA auto-generates its
  *own* API key exactly once, on its very first boot when its internal DB is
  empty — and generated `owa_k1_dc1b78eb...`, completely different from the
  `API_MASTER_KEY`/`OPENWA_API_MASTER_KEY` value in `.env`. Every
  authenticated OpenWA call (test button, and almost certainly QR/pairing-code
  generation too, though not yet re-verified in-browser after this fix) was
  silently 401ing. Fixed live, no restart, by `PATCH
  /api/admin/settings {key:"OPENWA_API_KEY", value:"owa_k1_..."}` — a DB-row
  override takes precedence over the env fallback, per how the settings
  service is designed. **Re-verify WhatsApp pairing/QR in `/admin/whatsapp`
  first thing tomorrow** — should now work but wasn't re-tested after the fix.

## Still open / next steps (in order)

1. **The AGENT-login `localhost:3000` bounce, above — the single blocker
   for a working unified login.**
2. Once fixed: re-verify agent login end-to-end in-browser, and re-verify
   OpenWA WhatsApp pairing/QR-code generation in `/admin/whatsapp`.
3. **Networking for actual calls.** VM is still on NAT (now 1 vCPU, which
   fixed the lockups but is unrelated to networking). Per the project's own
   deployment guide, NAT lets the browser load the UI but calls connect with
   **no audio** — the RTP range is 10,000 ports wide and VirtualBox NAT can't
   forward it. Bridged Adapter was tried once before this session (failed
   with a connection timeout, root cause never diagnosed) and was not
   revisited this session. Must be solved before Gate 1 testing.
4. **Asterisk is still split-brain.** `docker-compose.yml`'s `asterisk`
   service is commented out because its image (`tiredofit/asterisk:20-latest`)
   does not exist — verified: `github.com/tiredofit/docker-asterisk` 404s,
   the image was never real. Asterisk instead runs natively on the VM
   (`asterisk-source/`, compiled from GitHub source) with **`make samples`
   default config, not this repo's real `pbx_configs/`** (PJSIP, WSS,
   manager.conf, dialplan). The native `manager.conf` also has a duplicated
   `[algopbx-app]` block from a prior session with a secret that matches
   nothing in the current `.env`. Needs a real decision: fix the compose
   image reference to something that exists, or commit to native Asterisk
   and wire `/etc/asterisk/` to the repo's actual configs.
5. **No call has ever been carried by this codebase** (`GO_LIVE_CHECKLIST.md`
   Gate 1, entirely unstarted) — extension↔extension WebRTC test first, then
   Tailscale + Dinstar, only after #3 and #4 above are resolved.
6. Gate 3 compliance sign-offs (DNC fail-open, recording consent, GSM
   termination legality) are still open human decisions, untouched this
   session.
7. Rotate the throwaway VM SSH password (`algo`, still in use — an ed25519
   key was also installed this session as `~/.ssh/authorized_keys` so this
   session's own access doesn't depend on it) and the admin/agent app
   passwords created this session once real ones are chosen.

## Key files touched this session

`algo-pbx-frontend/src/app/login/login-form.tsx`,
`api/auth-2fa/{pre-login,verify}/route.ts`, `auth.config.ts` (added
`trustHost: true` — did not fix the bug, left in as correct regardless),
`api/auth/[...nextauth]/route.ts` (added `dynamic = "force-dynamic"` — also
did not fix the bug, left in as correct regardless), `Dockerfile`
(`NEXT_IGNORE_INCORRECT_LOCKFILE`), `docker-compose.yml` (`web`'s `HOSTNAME`).
VM-side only (not in git): `.env` fully rebuilt, `/etc/sysctl.d/
99-disable-ipv6.conf` (new), `algo_pbx` vCPU count 2→1, Postgres volume
wiped/reinitialized, two stale frontend files deleted, `OPENWA_API_KEY`
`AppSetting` row added.

## Previous session (2026-08-25): VirtualBox-aware port guide rewrite

## What was asked (previous session, 2026-08-25)

User shared a screenshot of their actual deployment environment — Oracle
VirtualBox on Windows, an `ubuntuserver` VM already NAT-forwarding host ports
8000/80/443 (Coolify), and a powered-off `algo_pbx` VM (the real target) —
and asked for `docs/1-Deploying-Algo-PBX-on-a-Linux-VM.pdf` to be rewritten so
a non-technical person can install fully from the PDF: which ports the stack
needs, how to find what's already occupying a port (on Windows and inside
Ubuntu), and how to pick a free one.

## What changed

- **Guide 1 rewritten end-to-end**
  (`docs/pdf1-template.html` → `1-Deploying-Algo-PBX-on-a-Linux-VM.pdf`):
  new Chapter 2 is a dedicated ports chapter (matrix with a "what breaks if
  blocked" column, Windows-host and Ubuntu-guest occupancy checks including
  `VBoxManage showvminfo ... | findstr Forwarding` to see what another VM
  already forwards, choosing a free port, what's movable vs not, a
  symptom→cause→fix table); Chapter 3 walks through creating the `algo_pbx`
  VM with **Bridged Adapter** (confirmed with the user as the recommended
  default — NAT can't realistically forward the 20,000-port-wide RTP+relay
  ranges, and it can't collide with `ubuntuserver`'s already-claimed ports);
  remaining chapters restructured around a static LAN IP, Docker install,
  router forwarding as its own step, and a post-`up -d` port verification.
  New Appendix A is a one-page port-check cheat sheet.
- **Guide 2** (`docs/pdf2-template.html`) gained "Appendix B — Ports on the
  telephony side" (5060/udp Tailscale-only path, verification commands, the
  "silent call = RTP range" diagnosis).
- **`DEPLOYMENT.md`** gained matching §1.1 "Running on VirtualBox" and §1.2
  "Port conflicts" so the repo (source of truth per `CLAUDE.md`) doesn't
  drift from the PDFs.
- Both PDFs regenerated via `python scripts/build-docs.py` +
  `powershell -File scripts/render-pdfs.ps1` — no placeholder/warning issues.
  **Not done:** no human paged through the rendered PDFs visually in this
  session (page-break/table-wrap check) — worth a quick look before relying
  on it for a real install.

## Previous session (2026-08-24): Production-readiness pass + WhatsApp SIM-port board

## What was asked (first pass)

A production-readiness audit and execution pass: correct the `docs/` guides,
harden deployment (reverse proxy, firewall, secrets, backups), produce a
go-live checklist, fix the Rooms page never showing the WhatsApp chat UI,
rebrand the landing page ("Algo PBX — wired for SAHARA") on the React Bits
Scanner background with one unified login that routes by role, audit + fix
the agent workspace UI, and make the queue manager actually manage.

## Follow-up same day (LLM.md §13): WhatsApp SIM-port board

- User clarified the OpenWA ask: FOUR numbers (one per Dinstar GSM port),
  scan-ready pairing for all at once, and fresher PDF screenshots.
  Architecture was already right (ONE sidecar connection in settings, up to
  four number instances) — the gap was presentation + docs.
- `/admin/whatsapp` is now a fixed **2×2 SIM port board** (`sim-port-board.tsx`
  replaces `pairing-card.tsx`): vacant slots offer inline start-pairing;
  occupied slots keep a big tap-to-copy pairing code (default) or QR visible
  simultaneously — pair four phones back-to-back. All prior per-instance
  actions preserved; zero API changes. Verified: typecheck/lint/build clean.
- Guide 2 §3 rewritten around the board (layer table: 1 connection vs ≤4
  numbers); final checklist requires all four ports Connected.
- **Screenshots NOT recaptured** — Docker is not installed on this machine
  (no dirs/WSL/service). Fallback executed as approved: missing captures
  render an honest "Screenshot pending" note in the PDF, and exact VM
  recapture steps are documented at the top of `scripts/build-docs.py`.
  The settings-page caption now states it predates the current shell.

## Done — verified (`tsc` clean · 199/199 tests · lint zero warnings · full `next build` OK)

- **Docs.** Root `CLAUDE.md`/`AGENT.md` had leftover "Jetro research
  platform" content from another product — rewritten as proper Algo PBX
  context. Master doc §6 marked historical-reference-only; §3.1 diagram now
  shows the real 7-service topology. `.env.example`'s SMS-poll crontab fixed
  (`http://web:3000` only resolves inside Docker; host cron needs
  `127.0.0.1:3000`). Both operator PDFs corrected (Dinstar wizard flow
  instead of hand-editing pjsip.conf, `from-dinstar` typo, certbot renewal
  now restarts asterisk+coturn+caddy) and **both are reproducible for the
  first time**: `scripts/build-docs.py` + `scripts/render-pdfs.ps1`
  (headless Edge). PDF #1 previously had no source at all.
- **Deploy hardening.** Caddy reverse proxy added to compose (443 → web:3000,
  same cert pair Asterisk/coturn already use — closes the Tier-0 "nothing
  serves HTTPS" gap). Coturn pinned off `:latest` to `4.17-alpine`.
  `scripts/setup-firewall.sh` applies the DEPLOYMENT.md port matrix.
  `scripts/backup.sh` dumps both DBs + all non-reproducible volumes with
  restore steps in the header.
- **GO_LIVE_CHECKLIST.md** — Gate 0 hygiene → Gate 1 live calls → Gate 2
  messaging/OTP → Gate 3 compliance sign-offs → Gate 4 ops. This is now the
  single ordered list standing between the repo and a real call.
- **Branding/auth.** Landing rebuilt on React Bits `<Scanner />` (ogl) in
  brand colors; ShaderGradient/three.js stack removed (5 deps dropped);
  copy is exactly "Algo PBX / wired for SAHARA" with a single Sign In
  button. Login remains one form for everyone; post-login redirect is now
  role-based via `/api/auth-2fa/pre-login` returning `role` (was hardcoded
  `/admin`, middleware bounced agents afterwards).
- **Rooms bug.** The chat thread was never reachable from room selection —
  staff access was already granted server-side, so conversation rows now
  open the existing `ChatThread` in a slide-over drawer. `/admin/sms` got
  the actual SIM inbox it always claimed to have (SMS-channel conversations
  + thread drawer).
- **Queue manager made real.** New `POST /api/queues/members`
  (staff-guarded, Zod, queue-ownership check) over the existing AMI helpers;
  per-member Pause/Unpause/Remove + add-member UI, live refresh, AMI-down
  banner. Snapshots now surface the AMI `Paused` flag as `"PAUSED"`.
- **Agent workspace fixes** (audit found 23 issues): dialpad digit leak,
  silent transfer failures, hold-guard abort for attended transfer, TURN
  credentials killing live calls mid-conversation, server status sync on ws
  drop/reconnect, chat media messages rendering empty bubbles, composer
  silent send failure, permanently-stale connection badge, voicemail delete
  confirmation, recordings/voicemail error states, auto-scroll, unread
  badge clearing. Full list in LLM.md §12.
- **ESLint installed** — `npm run lint` works for the first time, zero
  warnings.

## Deliberate scope call

Wholesale MUI conversion of the remaining ~13 Tailwind admin pages was NOT
done: they already implement the locked design language consistently inside
the MUI shell, so conversion risk outweighs visual gain right now. All
flagged *functional* inconsistencies were fixed instead (CDR filters,
report window labels, voicemailPin display). Revisit if pixel-uniformity
becomes a requirement.

## Still open / next steps

1. **Everything in GO_LIVE_CHECKLIST.md** — above all Gate 1: no call has
   ever been carried. First VM actions: dummy agent → outbound call through
   Dinstar → inbound via support_queue → hold/transfer/conference/intervention.
2. Compliance sign-offs (Gate 3): DNC fail-open + normalization gap,
   destructive voicemail delete, recording consent, GSM termination legality.
3. Leftover test account `verify-admin@algopbx.local` still exists in the
   dev database — delete before any real deployment.
4. Backup cron + one restore drill once the VM exists.

## Key files touched this session

Docs: `CLAUDE.md`, `AGENT.md`, `DEPLOYMENT.md`, `ALGO_PBX_MASTER_DOC.md`,
`.env.example`, `docs/pdf{1,2}-template.html`, `docs/*.pdf` (regenerated),
`scripts/build-docs.py` (new), `scripts/render-pdfs.ps1` (new).
Infra: `docker-compose.yml`, `Caddyfile` (new), `scripts/setup-firewall.sh`
(new), `scripts/backup.sh` (new), `GO_LIVE_CHECKLIST.md` (new).
Frontend: `src/app/page.tsx`, `src/components/landing/{scanner,scanner-background}.tsx`
(new), `gradient-background.tsx` deleted; `login-form.tsx`,
`api/auth-2fa/pre-login/route.ts`; `admin/rooms/page.tsx`,
`admin/sms/page.tsx`, `admin/extensions/page.tsx`, `admin/reports/page.tsx`,
`components/queue-manager.tsx`, `api/queues/members/route.ts` (new),
`lib/queue-status.ts`, `types/index.ts`, `components/dialpad.tsx`,
`call-controls.tsx`, `agent-status-selector.tsx`, `agent-recordings.tsx`,
`agent-voicemail.tsx`, `chat/{chat-thread,message-composer,conversation-list,
whatsapp-connection-badge}.tsx`, `contexts/sip-context.tsx`,
`whatsapp/pairing-card.tsx`; `package.json` (+ogl, eslint; −shadergradient/
three stack).
