# LLM.md — Algo PBX Build Context (Universal, Tool-Agnostic)

> **Read this file first, in full, before writing or changing anything in this repo.**
> This file exists so that *any* LLM coding tool (Claude Code, Cursor, Windsurf, Copilot, Codex, etc.) picking up this project — in this session or a future one — has the same shared understanding of what has been decided, what has been built, and what comes next. Do not re-derive architecture decisions already recorded here; treat them as locked unless the user explicitly reopens them.
>
> **Source of truth for architecture/specs:** [`ALGO_PBX_MASTER_DOC.md`](./ALGO_PBX_MASTER_DOC.md) — PRD, diagrams, tech stack, and reference config files. This file (`LLM.md`) tracks *build state and process*, not specs. If the two ever disagree, the master doc wins for "what to build"; this file wins for "what's already been done."
>
> **After every work session that changes build state**, update the Build Log and Phase Checklist sections below before ending the session. Keep entries terse — one line per change.

---

## 1. What Algo PBX Is

A self-hosted, cloud-based 3CX alternative for an inbound/outbound call center:
- **Core PBX:** Asterisk 20 (PJSIP), Docker, host networking.
- **WebRTC client:** Next.js 14 (App Router) + SIP.js + Tailwind + Shadcn UI.
- **NAT/media relay:** Coturn (STUN/TURN).
- **GSM trunk:** Dinstar 4-port gateway in a UAE office, bridged to the cloud VM over a Tailscale subnet route.
- **DB:** PostgreSQL 16 for auth, extensions, queues, CDRs.
- **Agents:** remote, in India, connecting over WebRTC to place/receive calls that egress/ingress through the UAE Dinstar GSM lines.

Full detail lives in `ALGO_PBX_MASTER_DOC.md` §§1–4 (master prompt, PRD, architecture diagrams, stack table).

## 2. Non-Negotiable Constraints (do not relitigate)

- Asterisk runs with `network_mode: host` — required for direct RTP handling. Don't containerize-network it "for cleanliness."
- WebRTC media must be DTLS-SRTP; signaling over WSS only for agents.
- Dinstar gateway is reached only via the Tailscale WireGuard subnet route (`192.168.1.0/24`), never a public port on the UAE router.
- Design language: dark slate `#0B0F19` background, electric cyan `#06B6D4` + blue `#2563EB` accents, glassmorphic cards — no generic AI-template UI.
- Codecs: Opus/G.711(a/u) for WebRTC agents; alaw/ulaw/g729 acceptable toward the Dinstar trunk.

## 3. Repo Layout (current — reflects what's actually built, keep in sync)

```
algo-pbx/
├── ALGO_PBX_MASTER_DOC.md       # spec source of truth
├── LLM.md                       # this file — build state tracker
├── docker-compose.yml
├── .env.example                 # copy to .env (gitignored) and fill in
├── pbx_configs/
│   ├── pjsip.conf                # now just `#include pjsip-base.conf` + `#include pjsip_dynamic.conf` (Phase A)
│   ├── pjsip-base.conf           # static: transports + Dinstar trunk only (Phase A split)
│   ├── pjsip_dynamic.conf        # GENERATED — do not hand-edit, see src/lib/pjsip-config.ts (Phase A)
│   ├── rtp.conf
│   ├── extensions.conf          # MixMonitor() (Foundation) + DNC_CHECK guard on outbound (Phase C)
│   ├── manager.conf             # AMI — added beyond the master doc's original file list, needed by Phase 4
│   ├── queues.conf              # was MISSING entirely — every inbound call failed without it (Foundation phase)
│   ├── musiconhold.conf         # [default] MOH class (Phase B)
│   ├── res_odbc.conf            # registers the Postgres DSN with Asterisk (Phase C, DNC lookup)
│   ├── func_odbc.conf           # DNC_CHECK() dialplan function (Phase C) — unverified against live Asterisk
│   ├── odbc.ini                 # unixODBC system DSN (Phase C) — mounted to /etc/odbc.ini
│   ├── odbcinst.ini             # unixODBC driver registration (Phase C) — mounted to /etc/odbcinst.ini
│   ├── voicemail.conf           # static [general] + #include voicemail_dynamic.conf inside [default] (Phase E)
│   ├── voicemail_dynamic.conf   # GENERATED — do not hand-edit, see src/lib/voicemail-config.ts (Phase E)
│   └── confbridge.conf          # [default_bridge]/[default_user] ConfBridge profiles (Phase G)
├── moh/default/                 # MOH audio files go here — ships empty by design, see its README.md (Phase B)
├── recordings/                  # Asterisk call recordings volume — MixMonitor writes here, api/recordings/[uniqueid] serves it
├── voicemail/                   # Asterisk voicemail spool — Asterisk writes, api/voicemail reads (Phase E)
├── scripts/
│   ├── setup-tailscale-uae-office.sh
│   └── setup-tailscale-cloud.sh
├── algo-pbx-frontend/           # Next.js 14.2.35 App Router app
│   ├── prisma/schema.prisma     # User, Extension (+sipSecret/voicemailPin, Phase A/E), Queue, QueueMember, CallDetailRecord, DoNotCallEntry (Phase C), Recording + AuditLog (Phase D)
│   ├── vitest.config.mts        # test runner introduced in Foundation phase — the only genuinely executed logic in this repo
│   ├── scripts/
│   │   ├── create-admin-user.mjs    # bootstrap the first login — no signup flow exists
│   │   └── ami-cdr-listener.ts      # standalone AMI Cdr-event listener, run via tsx — its own compose service, not part of `web`
│   └── src/
│       ├── middleware.ts        # MUST live here, not at the frontend root — see Phase note below
│       ├── auth.config.ts       # edge-safe Auth.js config (no Prisma/bcrypt) — used by middleware
│       ├── auth.ts              # full Auth.js config (Credentials + Prisma/bcrypt) — used by route handlers/server components
│       ├── app/
│       │   ├── page.tsx, agent/page.tsx, login/{page,login-form,actions}.tsx
│       │   ├── admin/{page,queues/page,cdr/page,extensions/page,users/page,dnc/page}.tsx
│       │   └── api/{auth/[...nextauth],admin/users,admin/recordings/[id],ami/status,cdr,channels,queues,extensions,extensions/[number],me/sip-credentials,wallboard,intervention,recordings,recordings/[uniqueid],recordings/hide,dnc,dnc/[id],dnc/check,dnc/bulk-import,voicemail,voicemail/[id],voicemail/[id]/audio,calls/conference}/route.ts
│       ├── components/          # dialpad (+DNC dialError, Phase C), call-controls (+Blind/Attended/Conference, Phase F/G), agent-status-selector, agent-recordings (Phase D), agent-voicemail (Phase E), wallboard, queue-manager, cdr-table, intervention-controls
│       ├── contexts/sip-context.tsx   # Phase F: rewritten onto Web.SessionManager (was Web.SimpleUser) — see Phase F checklist for why
│       └── lib/{db,ami-client,ami-client.test,queue-status,queue-status.test,cdr-mapper,cdr-mapper.test,pjsip-config,pjsip-config.test,pjsip-provision,phone-normalize,phone-normalize.test,recording-access,recording-access.test,voicemail-config,voicemail-config.test,voicemail-provision,voicemail-spool,voicemail-spool.test,conference-orchestration,conference-orchestration.test,auth-guard,utils}.ts
└── graphify-out/                 # generated by Graphify — do not hand-edit, re-run instead
```

**Additions as of §11 (2026-08-23), not yet folded into the tree above —
see §11 for the full list:** `vendor/openwa/{Dockerfile deleted,
prepare.sh, initdb/}` (builds from upstream's own Dockerfile via a pinned
fetch script now, not a hand-rolled one); `pbx_configs/pjsip_dinstar.conf`
(generated, mirrors `pjsip_dynamic.conf`'s pattern); new
`src/lib/{messaging/openwa-client,messaging/openwa-types,
messaging/openwa-webhook-auth,queue-membership,dinstar-discovery,
dinstar-config,dinstar-provision,client/api}.ts`; new
`src/theme/*`, `src/components/{admin-shell,landing,whatsapp}/*`; new
routes `src/app/admin/{dinstar,system}/page.tsx` and
`src/app/api/admin/{dinstar,system}/**`, `src/app/api/admin/whatsapp/
instances/[id]/{pairing,pairing-code}/route.ts`, `src/app/api/me/
whatsapp/route.ts`, `src/app/api/admin/rooms/[id]/activity/route.ts`. Git
itself is new as of this session (`git init` — the repo had none before).

## 4. Phase Checklist

Mirrors the 4 phases in the master prompt (`ALGO_PBX_MASTER_DOC.md` §1). Check items only when actually done and verified (built/run/tested), not just written.

- [x] **Phase 1 — Docker infrastructure (scaffolded, not yet run)**
  - [x] `docker-compose.yml` created at repo root (env-var driven, not hardcoded secrets)
  - [x] `pbx_configs/pjsip.conf`, `rtp.conf`, `extensions.conf`, `manager.conf` created
  - [x] Postgres, Coturn, Asterisk containers start cleanly — **verified 2026-08-27 on the live VM: all 8 services (postgres, coturn, asterisk, web, cdr-listener, cert-sync, openwa, caddy) report healthy via `docker compose ps`. See §15.**
  - [ ] Secrets/placeholders (`YOUR_VM_PUBLIC_DOMAIN`, `REPLACE_ME_*` in `pbx_configs/*.conf`) replaced with real values before deployment — **never commit real secrets**. `.env.example` added; copy to `.env` (gitignored) and fill in.
  - [x] `web` service build context `algo-pbx-frontend/` now exists
- [x] **Phase 2 — Next.js WebRTC softphone (scaffolded + builds clean, not run against live Asterisk)**
  - [x] `algo-pbx-frontend` scaffolded — Next.js 14.2.35 (bumped from the master doc's 14.2.13 reference: that version has a known CVE, see npm advisory shown on install), App Router, Tailwind (dark-slate/cyan/blue theme wired into `tailwind.config.ts`), hand-rolled glass-card components instead of pulling in full Shadcn (no network-installed component generator available in this session — swap in real Shadcn components later if wanted, they'd slot into the same className hooks)
  - [x] `src/contexts/sip-context.tsx` implemented — rewritten from the master doc's reference version, which mixed the raw `UserAgent` and `Web.SimpleUser` APIs inconsistently. Rebuilt entirely on `SimpleUser`: register/call/answer/hangup/mute
  - [x] Hold, blind transfer, DTMF keypad added. **Caveat:** `SimpleUser` doesn't publicly expose incoming caller ID or a transfer method — both reach into its private `session` field as a documented best-effort workaround (search `sip-context.tsx` for "private `session` field"); revisit if a sip.js upgrade breaks this. Attended transfer (REFER w/ Replaces) is NOT implemented, only blind transfer.
  - [x] Agent status selector (Available/Busy/Break/Offline) — UI + context state only; not yet persisted server-side (needs auth first, see §6)
  - [x] `npx tsc --noEmit` clean; `npm run build` (Next production build) succeeds
  - [ ] Never run against a real Asterisk WSS endpoint — no cloud VM available in this session
  - [x] **(2026-08-28, §20)** Hold/attended-transfer no longer collapse the call window to "No active call" on a failed re-INVITE/REFER while the far end is still up; agent-visible callError added; MOH class selection pinned explicitly (moh_suggest/moh_passthrough) instead of relying on PJSIP's implicit default — see §20 for full detail. Still not run against live Asterisk/Dinstar.
- [x] **Phase 3 — Manager/Admin dashboard (scaffolded, data flows untested end-to-end)**
  - [x] Live wallboard (`/admin`, `GET /api/wallboard`) — active calls via AMI `CoreShowChannels`, agents online via Postgres
  - [x] Eavesdrop/Whisper/Barge controls (`InterventionControls` → `POST /api/intervention` → AMI `Originate` + `ChanSpy`) — **channel picker now backed by `GET /api/channels`** (Foundation phase), no more manual CLI lookup, with graceful fallback to manual text entry if AMI is unreachable
  - [x] Queue & ring-group manager (`/admin/queues`) — reads `Queue`/`QueueMember` from Postgres; **waiting/longestWaitSec/member status are now real** (Foundation phase, see below), not placeholders
  - [x] CDR view with filtering + audio playback (`/admin/cdr`, `GET /api/cdr?agent=&from=&to=`) — **recordings now actually get created and are servable**, see Foundation phase
  - [x] Extension/trunk provisioning UI (`/admin/extensions`) — **now actually provisions Asterisk**, see Phase A below (was DB-only until this session)
- [x] **Foundation repair (2026-08-23 — prompted by an audit against 3CX-as-product; see Build Log)**
  - [x] `pbx_configs/queues.conf` created — was **missing entirely**. `extensions.conf`'s `Queue(support_queue,...)` had no queue definition to route into, so every inbound call failed outright. Mounted in `docker-compose.yml`. `joinempty=yes` for dev, flagged in-file as a production decision to revisit (real call centers usually want `joinempty=no`).
  - [x] **AMI multi-event collector** — `AmiClient.sendAndCollect()` (`src/lib/ami-client.ts`), TDD'd with vitest (`dev:test-driven-development` skill, invoked per user request): accumulates every event sharing an action's `ActionID` up to a named terminator event, fixing the root cause `send()` couldn't: multi-event AMI actions (`QueueStatus`, `CoreShowChannels`) were only ever correlated on their initial ack, which for `CoreShowChannels` doesn't even carry the `ListItems` count (that's only on the terminating `CoreShowChannelsComplete` — confirmed against docs.asterisk.org, not assumed). 5 tests cover: full collection, TCP-chunk-split blocks, cross-ActionID filtering, timeout + listener cleanup, and Error short-circuit. Required making the socket connection injectable (`socketFactory` constructor param) and exporting the `AmiClient` class, both previously private/unexported.
  - [x] **Semantic bug fixed in the same pass:** `CoreShowChannels` enumerates *channels*, not *calls* — a two-party call is two channels, so a raw count (or the old `ListItems` read) roughly doubles the true call count. `wallboard/route.ts` now counts distinct `Linkedid` values instead. ⚠️ Whether `CoreShowChannel` actually carries a `Linkedid` field is **unverified** against live Asterisk (falls back to per-channel counting if absent).
  - [x] `queues/route.ts` rewritten on the collector: `waiting` = `QueueEntry` event count, `longestWaitSec` = `max(Wait)`, member status mapped from `QueueMember`'s `Status` device-state enum via new pure/tested helpers in `src/lib/queue-status.ts` (`mapQueueMemberStatus`, `extensionFromInterface`) — Postgres stays the authority for *which* extensions belong to a queue, AMI supplies their *live* status.
  - [x] New `GET /api/channels` (staff-guarded) + `intervention-controls.tsx` now offers a live channel dropdown instead of requiring manual `asterisk -rx "core show channels"` entry.
  - [x] **Call recording now actually happens:** `MixMonitor(${UNIQUEID}.wav)` added to `extensions.conf`'s `[from-dinstar]`, after `Answer()` and before `Queue()` (so hold time is captured). New authenticated `GET /api/recordings/[uniqueid]` (staff-only for now; path-traversal-guarded, streams from `RECORDINGS_DIR`, never `public/`). Required adding a read-only `./recordings` mount to the `web` service (previously only `asterisk` had one).
  - [x] **CDR ingestion is now live:** standalone `scripts/ami-cdr-listener.ts` (run via `tsx`, own `cdr-listener` compose service/Dockerfile target — deliberately **not** a Next.js `instrumentation.ts` hook, since an AMI subscription needs one durable connection with reconnect/backoff and instrumentation hooks have no single-execution guarantee across workers/dev-restarts/redeploys) subscribes to AMI `Cdr` events and POSTs to `/api/cdr`. Event→payload mapping extracted as a pure, tested function (`src/lib/cdr-mapper.ts`, 6 tests) since that's the only part of this that's exercisable without live Asterisk.
  - [x] **Real bug fixed in passing:** `POST /api/cdr`'s `recordingUrl` field was `z.string().url()`, which would have rejected the relative `/api/recordings/<uniqueid>` path the listener actually sends — caught while wiring the listener, not before. Relaxed to `z.string()`; recording playback is same-origin, so a relative path is correct, not a shortcut.
  - [x] Test framework introduced: **vitest** (single devDependency, TS-native). `npm run test` — 18 tests across 3 files, all pure/mockable logic (the only kind of logic actually exercisable with no live Docker/Postgres/Asterisk in this environment).
  - [ ] **Still unverified, unavoidably:** exact `QueueMember`/`Cdr` field names, `QueueStatusComplete`'s exact spelling, `Linkedid` presence on `CoreShowChannel`, and whether any of this survives contact with a real Asterisk instance. Config files (`queues.conf`, the `MixMonitor` line, compose mounts) are syntax-reviewed only, never run.
- [x] **Phase A — Admin-created agents + PJSIP provisioning (2026-08-23, from the 3CX-audit plan; closes the §7 blocker it raised)**
  - [x] **Decision executed: config-generation + AMI `pjsip reload`, not PJSIP realtime/ODBC** — per the plan's rationale (ODBC/sorcery/second-schema complexity, zero testability here). `src/lib/pjsip-config.ts`'s `renderPjsipConf()` is pure and TDD'd (`dev:test-driven-development` skill, RED confirmed as `Cannot find module` before the file existed, then GREEN, 7/7 passing): renders `[n]`/`[n-auth]`/`[n-aor]` stanzas for `webrtc`/`hardware` extensions, byte-identical to the original hand-written `1001`/`2001` templates (confirmed by literally running the function to generate the seed file rather than hand-transcribing it), plus a DO-NOT-HAND-EDIT banner and defense-in-depth rejection of bracket/newline injection in `number`/`sipSecret`.
  - [x] `pbx_configs/pjsip.conf` split: `pjsip-base.conf` (static transports + Dinstar trunk, `:ro` mount) `#include`s into it alongside `pjsip_dynamic.conf` (generated, read-write, **shared bind mount between the `asterisk` and `web` compose services** — `web` writes it, `asterisk` reads it and gets told to reload).
  - [x] **Per-agent SIP credentials — fixes the confirmed hard blocker.** New `Extension.sipSecret` (crypto-random via `node:crypto`'s `randomBytes`, explicitly NOT the same value/mechanism as `User.passwordHash` — bcrypt is one-way and useless for SIP digest auth). New `GET /api/me/sip-credentials` (any signed-in user, returns only the caller's own extension+secret). `sip-context.tsx` rewritten to fetch this once per sign-in instead of reading `NEXT_PUBLIC_SIP_EXTENSION`/`NEXT_PUBLIC_SIP_PASSWORD` — those vars are now fully unused and their `.env.example` entries removed (they were vestigial even before, never actually read by any code).
  - [x] `POST /api/extensions` extended: generates the secret, creates the DB row, calls `regeneratePjsipConfigAndReload()` (`src/lib/pjsip-provision.ts` — orchestration glue over DB read + file write + AMI `Command: pjsip reload`, deliberately not unit tested since none of its three side effects are available here; the decision logic lives in the already-tested `renderPjsipConf`). Returns the secret **once**, in the creation response only — never again via any GET.
  - [x] New `POST /api/admin/users` + `/admin/users` UI: creates a `User` and, in the same request, optionally a linked `Extension` — promotes `create-admin-user.mjs` from a CLI-only bootstrap path into an in-product flow. Authorization is stricter than plain staff access: a SUPERVISOR may only create AGENT accounts; only ADMIN may create SUPERVISOR/ADMIN accounts.
  - [x] **Secret exposure minimized throughout:** `GET /api/extensions` and `GET /api/admin/users` both explicitly `select` fields rather than returning the full row, so `sipSecret` never appears in a listing response, only in the one-time creation response. (Tried Prisma's `omit` API first — its generated types reject it with `never` in this client generation, apparently needing a preview flag not enabled here; switched to explicit `select`, which needs none. Caught by `tsc`, not assumed.)
  - [x] Real bug caught while implementing, not before: same `z.string().url()` class of mistake as the Foundation phase's `recordingUrl` — none here, but worth noting the pattern held: every new relative-path/secret field was deliberately typed loosely (plain `z.string()`/`string | null`) rather than over-constrained.
  - [ ] **Still open, deliberately out of scope for Phase A:** queue membership is still static (`queues.conf`'s hardcoded `member => PJSIP/1001`) — dynamic `AddQueueMember`/`RemoveQueueMember` over AMI as agents are provisioned is not built. Whether Asterisk actually picks up `#include`d dynamic config on a plain `pjsip reload` (vs. needing a full module unload/load) is **unverified** against live Asterisk.
  - [ ] Not verified against a live Postgres/Asterisk — the file-write, AMI reload, and the whole provisioning flow are compile/typecheck confidence only, same constraint as everything else in this repo.
- [x] **Phase B — Music on Hold (2026-08-23, from the 3CX-audit plan)**
  - [x] `pbx_configs/musiconhold.conf`'s `[default]` class → `moh/default/` (mounted `:ro`); `queues.conf` already referenced `musicclass=default` from the Foundation phase, so no change needed there.
  - [x] No softphone change needed — sip.js's `hold()` already re-INVITEs `a=sendonly` on the agent's own leg (pre-existing Phase 2 behavior); this phase is entirely about what plays to the *other* party.
  - [x] Ships with **zero audio files** by design (`moh/default/README.md` explains why — licensing is an operator decision) — Asterisk will log a warning and play silence, not error, until an operator drops files in. `moh/default/*` gitignored except the README.
  - [ ] Not verified against live Asterisk — whether the `directory=default` config actually resolves to `/var/lib/asterisk/moh/default` as intended, unconfirmed.
- [x] **Phase C — Do Not Call blocklist (2026-08-23, from the 3CX-audit plan)**
  - [x] New `DoNotCallEntry` Prisma model (`numberE164` unique, `reason`, `source`, `addedBy`) plus `src/lib/phone-normalize.ts`'s `normalizeToE164()` (wraps `libphonenumber-js`, defaults to AE/UAE country context since that's where the Dinstar trunk dials out through) — 7 tests, all passed on the first run.
  - [x] **Defense in depth, both layers built:** (1) App layer — `GET /api/dnc/check` called from `sip-context.tsx`'s `makeCall()` before dialing, fails **open** on a network error (a DNC-check hiccup shouldn't block legitimate calls), surfaces a new `dialError` context field the Dialpad now renders. (2) Dialplan layer (the one that actually matters for compliance, since a hardware phone bypasses the app entirely) — `pbx_configs/func_odbc.conf`'s `DNC_CHECK()` function, wired into `extensions.conf`'s `[from-agent]` context before the `Dial()` to `dinstar-trunk`, routing hits to a new `dnc-blocked` extension.
  - [x] CRUD: `GET/POST /api/dnc` (staff), `DELETE /api/dnc/[id]` (staff, real hard delete — no soft-remove concept for DNC, unlike the planned recording-retention feature), `POST /api/dnc/bulk-import` (staff, per-line normalize-or-skip reporting), plus `/admin/dnc` UI. Nav link added.
  - [x] **Real networking bug caught before it shipped, same class as the Foundation phase's `manager.conf` fix:** `pbx_configs/odbc.ini` initially pointed `Servername` at `postgres` (the compose service's DNS name) — but `asterisk` runs with `network_mode: host` and has no bridge-network DNS at all, so that name would never resolve. Fixed to `127.0.0.1`, since `postgres`'s published port lands on the host's own loopback, which a host-networked container shares directly.
  - [x] **Security hardening done in passing:** noticed while wiring ODBC that `postgres`'s port was published as `"5432:5432"` (all interfaces) — tightened to `"127.0.0.1:5432:5432"` since the only same-host consumers (asterisk via ODBC, a local dev DB client) don't need it exposed beyond loopback, and `web` never needed the published port at all (it reaches Postgres via the internal bridge DNS name). Publishing a DB port to every interface on a real cloud VM would have been a real exposure.
  - [x] New `pbx_configs/{odbc.ini,odbcinst.ini,res_odbc.conf,func_odbc.conf}`, all mounted in `docker-compose.yml`.
  - [ ] **Two things flagged as genuinely unresolved, not swept under a "done" checkbox:** (a) `func_odbc.conf`'s dialplan-side match is a **raw string comparison** against whatever the agent dialed (plus a same-with-leading-"+" fallback) — it does NOT run the same normalization as the TS side, since the dialplan can't call a TypeScript function. A DNC entry stored as `+971501234567` will not match if an agent dials `0501234567`. This is a real compliance gap requiring either dialing-convention discipline or a future AGI-based check that proxies through the app's own normalizer — flagged for whoever owns compliance sign-off, not silently accepted. (b) Whether `tiredofit/asterisk:20-latest` even ships `unixODBC` + a PostgreSQL driver at all is **unverified** — `odbc.ini`'s header comment documents the AGI-fallback alternative if it doesn't. The dialplan fails *open* (allows the call) if the ODBC lookup errors, a deliberate availability-over-blocking tradeoff also flagged for compliance sign-off, not assumed correct forever.
- [x] **Phase D — Recording retention, asymmetric deletion (2026-08-23, from the 3CX-audit plan; compliance-sensitive)**
  - [x] Requirement, verbatim: *"the voice recording will be on admin side also but the agent side deletion will not delete the recording."* New `Recording` model (`cdrId`, `filePath`, `fileSizeBytes`, `hiddenFromAgentAt`, `hiddenByUserId`) plus a small `AuditLog` model — a dedicated model, not more `CallDetailRecord` fields, since a call may have several recordings in a future phase (transfer/conference consult legs, Phases F/G).
  - [x] **Re-grounded the design against actual current code before implementing, not the original sketch verbatim:** confirmed `CallDetailRecord.agentExtension` has no FK to `Extension`/`User` — it's a bare string, so "ownership" is `cdr.agentExtension === session.user.extension` string equality, the same mechanism `PATCH /api/extensions/[number]` already uses. Confirmed the byte-serving route (`api/recordings/[uniqueid]`) was still `requireStaffSession()`-only with zero DB awareness, and that **no agent-facing recordings UI existed anywhere** (`src/components/` had 8 files, none of them this).
  - [x] **Single source of truth for the access decision, TDD'd** (`dev:test-driven-development` skill, RED confirmed as `Cannot find module`, then GREEN, 7/7 passing on the first implementation — no refactor needed): `src/lib/recording-access.ts`'s `canAccessRecording()`. ADMIN/SUPERVISOR always allowed; AGENT allowed only if they own the call **and** it isn't hidden. Explicitly tested that two `null`s (an unlinked agent vs. a call with no agent assigned) do **not** count as a match — a real edge case a naive `===` check would get wrong.
  - [x] **This same function is called from both** `GET /api/recordings` (listing) and the rewritten `GET /api/recordings/[uniqueid]` (byte-serving, now `requireSession()` instead of staff-only) — the exact property the original design called critical: a hidden recording is unreachable by direct URL, not merely absent from a list.
  - [x] `POST /api/recordings/hide` (any signed-in user, ownership-checked) — stamps `hiddenFromAgentAt`/`hiddenByUserId`, **never** calls `db.recording.delete`. New `DELETE /api/admin/recordings/[id]` — new `requireAdminSession()` guard (ADMIN only, not SUPERVISOR, mirroring the same principle already used for `/api/admin/users`) — the one place in this whole feature that actually deletes data (DB row + best-effort file unlink), writes its `AuditLog` row *before* deleting so the trail survives a partial failure.
  - [x] New agent-facing `src/components/agent-recordings.tsx` (added to `agent/page.tsx`) — offers only a "Hide" button, deliberately not "Delete," matching the requirement's own wording so the UI itself can't be mistaken for doing the wrong thing. No admin UI added for the hard-delete route (out of scope per the plan — route exists and is callable directly; adding a whole admin recordings-management page wasn't asked for).
  - [x] `POST /api/cdr` extended to create the `Recording` row at ingestion time (find-then-create, not upsert — `cdrId` isn't unique on `Recording` by design, since a future phase could add a second recording per call).
  - **Real bug caught by `next build`, not `tsc` — a genuine routing conflict, not a style nitpick:** `/api/recordings/[uniqueid]` (byte-serving, keyed by CDR `uniqueId`) and an originally-planned `/api/recordings/[id]/hide` (keyed by `Recording.id`) collided — Next.js requires every dynamic segment at the same path position to share one param name across sibling routes, and these are genuinely different identifier types. Fixed by moving to `POST /api/recordings/hide` with `{ id }` in the request body instead of the URL. Worth remembering before adding more nested dynamic routes under `/api/recordings/`.
  - [ ] **Flagged limitation, not fixed:** the byte-serving route is still keyed by CDR `uniqueid` (one recording per call, today's reality). If Phases F/G later produce multiple recordings per call, that route's URL shape needs to change to `Recording.id` instead — noted for whoever builds those phases.
  - [ ] Not verified against a live Postgres — the `Recording`/`AuditLog` tables, the ingestion side-effect, and the whole access-decision wiring are compile/typecheck/unit-test confidence only.
- [x] **Phase E — Voicemail (2026-08-23, from the 3CX-audit plan)**
  - [x] New `Extension.voicemailPin` (crypto-random 4-digit, generated alongside `sipSecret` in both `POST /api/extensions` and `POST /api/admin/users`, same one-time-disclosure treatment) plus `src/lib/voicemail-config.ts`'s `renderVoicemailConf()` — pure, TDD'd, 7/7 first try — generating `voicemail_dynamic.conf` mailbox lines, mirroring `pjsip-config.ts`'s split-file pattern exactly (`voicemail.conf` static `[general]`, `#include`s the generated file inside `[default]`).
  - [x] **Real dialplan gotcha caught and worked around, not just discovered:** `Goto(vm-${DIALSTATUS},1)` (the standard Asterisk no-answer-to-voicemail idiom) jumps to a *named* extension, which resets `${EXTEN}` to that literal name (`"vm-NOANSWER"` etc) — using `${EXTEN}` inside the `vm-` handlers would reach the wrong mailbox. Worked around with `Set(VMBOX=${EXTEN})` captured before the `Dial()`/`Goto()`. Documented inline in `extensions.conf` since this is exactly the kind of thing that looks correct, compiles (Asterisk configs don't "compile"), and silently misroutes voicemail in production.
  - [x] `*97` dialplan extension for `VoicemailMain()` self-service access, keyed off `CALLERID(num)` (works for the generated WebRTC/hardware endpoint templates; falls back to Asterisk's own mailbox/PIN prompt otherwise).
  - [x] `GET /api/voicemail` (own mailbox for AGENT, `?mailbox=` required for staff), `GET /api/voicemail/[id]/audio` (streaming, same never-`public/`-principle as call recordings), `DELETE /api/voicemail/[id]` — new `src/lib/voicemail-spool.ts` (`parseVoicemailMessageMetadata`, `canAccessMailbox`, `parseVoicemailId` — 13 tests total across two files) parses Asterisk's `.txt` sidecar format and validates the `<mailbox>-<msgBase>` id scheme against path traversal.
  - [x] New agent-facing `agent-voicemail.tsx`, added to `agent/page.tsx`.
  - **Flagged, not silently decided — per the original plan's own explicit callout:** `DELETE /api/voicemail/[id]` is **genuinely destructive** (real file deletion), unlike Phase D's recording "hide." The plan named this asymmetry as needing confirmation before building; proceeded with destructive delete as the more literal reading of the user's requirement (which named recordings specifically, not voicemail) — but this is a judgment call, not a certainty. Revisit if voicemail should behave like recordings instead.
  - [ ] **Confidence caveats, explicit:** the `.txt` sidecar key set (`origtime`, `duration`, `callerid`, `context`) is MEDIUM confidence, not verified against a live-generated file. `voicemail.conf`'s mailbox line format is HIGH confidence (long-stable Asterisk convention). Whether `module reload app_voicemail.so` actually picks up the `#include`d dynamic file is unverified, same class of gap as `pjsip reload`.
  - [ ] Not built (scope boundary, not an oversight): unread-count/MWI badge via AMI `MailboxCount`/`MailboxStatus` — the plan mentioned this as a nice-to-have, not a requirement.
- [x] **Phase F — Attended transfer (2026-08-23, from the 3CX-audit plan) ⚠️ the "large, rewrite not a patch" item — completed, smaller than the plan anticipated**
  - [x] **Design changed for the better after re-checking sip.js's actual API surface before writing code, not assuming the plan's original sketch was final.** The plan called for migrating onto raw `UserAgent`/`Inviter`/`Invitation`/`Session` and hand-rolling multi-session bookkeeping. Reading `node_modules/sip.js/lib/platform/web/session-manager/*.d.ts` directly turned up `Web.SessionManager` — an **official, publicly exported** sip.js class purpose-built for multiple concurrent sessions (`maxSimultaneousSessions` defaults to **2**, exactly what attended transfer needs) with a first-class `transfer(session, target)` that does attended transfer (REFER w/ Replaces) when `target` is a `Session` and blind transfer (REFER) when it's a string — no manual SIP plumbing needed at all. This is a materially smaller, safer migration than the plan's own estimate, while satisfying its rejected-alternative concern ("a second parallel UserAgent... would fight over the same WebSocket/registration/media device") by design, since `SessionManager` manages multiple sessions on one connection natively.
  - [x] `src/contexts/sip-context.tsx` fully rewritten onto `Web.SessionManager`. **Both of the old private-`session`-field hacks are gone**, not just relocated: incoming caller ID now reads the public `Session.remoteIdentity.displayName`/`.uri`, and blind transfer now calls the public `SessionManager.transfer()` instead of reaching into `su.session?.refer()`.
  - [x] New context state/methods for attended transfer: `consultState` ("idle"/"calling"/"active"), `startAttendedTransfer`, `completeAttendedTransfer`, `cancelAttendedTransfer`. Flow: hold the primary call → dial the target as a second ("consult") session → once answered, either `transfer(primary, consult)` (merges the transferee in, drops the transferor) or hang up the consult and resume the primary.
  - [x] **Real correctness improvement caught in the same pass, not a separate bug:** the old `makeCall` set `callState("active")` immediately once `SimpleUser.call()` resolved — but that promise only resolves when the INVITE is *sent*, not when it's *answered* (documented explicitly on both `SimpleUser.call()` and `SessionManager.call()`). The rewrite now waits for the `onCallAnswered` delegate callback instead, same as it already correctly did for incoming calls.
  - [x] `call-controls.tsx` gained a Blind/Attended toggle and a consult-call sub-panel (Complete Transfer / Cancel), gated on `consultState`.
  - [x] `npx tsc --noEmit` passed clean on the **first attempt** after the full rewrite — a direct result of reading the actual `.d.ts` files (`session.d.ts`, `inviter.d.ts`, `invitation.d.ts`, `user-agent.d.ts`, `session-manager.d.ts`, `session-manager-delegate.d.ts`) before writing any code, not after.
  - [ ] **Scope boundary, not a gap:** call waiting is explicitly unsupported — a second incoming call while one is already active/ringing is auto-declined (`onCallReceived` checks `primarySessionRef.current` first). The UI has exactly one "current call" slot; this wasn't asked for and wasn't retrofitted speculatively.
  - [ ] Not verified against a live Asterisk/WSS endpoint — REFER-with-Replaces semantics, multi-session media handling, and the actual on-the-wire behavior of `SessionManager` are compile/typecheck confidence only, the same constraint as every other AMI/SIP code path in this repo.
- [x] **Phase G — Ad-hoc 3-way conference (2026-08-23, from the 3CX-audit plan)**
  - [x] `pbx_configs/confbridge.conf` (`[default_bridge]`/`[default_user]` profiles) + a new `[conference]` dialplan context in `extensions.conf` — the conference id IS the dialplan extension number, joined via `ConfBridge(${EXTEN},...)`.
  - [x] New `POST /api/calls/conference` — entirely server-side AMI orchestration (Redirect + Originate), not something the softphone does itself; browser WebRTC can't mix three parties, only Asterisk's ConfBridge can. Uses the Foundation phase's `sendAndCollect` collector to find the agent's live channel.
  - [x] **Pure decision logic extracted and TDD'd** (`src/lib/conference-orchestration.ts`'s `findChannelsToRedirect()`, 4/4 passing): given a channel snapshot + the agent's extension, decides which channels need to be Redirected into the new conference room — the agent's own leg **and** its bridged peer (grouped by `BridgeId`), not just the agent's leg alone, since redirecting only the agent's channel would strand the original other party rather than merging them in.
  - [x] `call-controls.tsx` gained a third transfer-mode option (Conference icon) reusing the existing transfer-target input.
  - [ ] **Two confidence caveats flagged explicitly, matching the plan's own risk callout — not resolved, not silently ignored:** (a) whether `CoreShowChannel` events actually carry a `BridgeId` field is MEDIUM-LOW confidence (same open question as the wallboard's `Linkedid` dedup) — if absent, the orchestration degrades to redirecting only the agent's channel, very likely stranding the original party rather than conferencing them in. (b) Redirecting a live DTLS-SRTP WebRTC channel into ConfBridge risks a media renegotiation glitch — the plan flagged this as needing live testing, and nothing in this session could provide that.
  - [ ] Not verified against a live Asterisk instance — this is the least-tested of all seven phases, by nature (it depends on both the AMI collector's unverified fields AND live WebRTC media behavior).
- [x] **Auth (added after Phase 4, not in the original master doc — closes the §7 gap it raised)**
  - [x] Auth.js v5 (`next-auth@5.0.0-beta.32`) Credentials provider, `src/auth.ts` — email/password against `User.passwordHash` (bcrypt), JWT session strategy (no adapter/DB session tables — deliberate, see `prisma/schema.prisma` comment)
  - [x] `src/middleware.ts` protects `/admin/*` (ADMIN/SUPERVISOR only, redirects AGENT to `/agent`) and `/agent` (any signed-in user), redirecting to `/login` otherwise
  - [x] **Every admin-facing API route also checks the session itself** (`src/lib/auth-guard.ts`'s `requireStaffSession()`, applied to `wallboard`, `queues`, `extensions`, `intervention`, `cdr` GET, `ami/status`) — this is not redundant with the middleware: `middleware.ts`'s matcher excludes `/api` (matches the reference pattern from nextauthjs/next-auth-example, which needs that exclusion for its own auth routes/Server Actions to work), so without a per-route check, e.g. `curl POST /api/intervention` would originate calls from anyone with network access, unauthenticated. Caught this in review before it shipped — worth remembering if new API routes get added.
  - [x] `POST /api/cdr` (the ingestion endpoint) uses a **separate** mechanism — a `CDR_INGEST_SECRET` bearer token, constant-time compared — because its caller is a server-to-server AMI listener process, not a browser with a session cookie
  - [x] `scripts/create-admin-user.mjs` (`npm run create-admin -- <email> <password> <name> [role]`) — bootstraps the first account; no self-service signup exists by design
  - [x] `/admin`'s hardcoded `supervisorExtension="9000"` replaced with `session.user.extension` from `auth()`
  - **Real bug, later root-caused properly with the `dev:systematic-debugging` skill (see the second 2026-08-23 log entry below):** `middleware.ts` at the frontend root was silently never loaded. Confirmed root cause in Next.js's own source (`node_modules/next/dist/build/index.js`): `next build` computes `rootDir = path.join(pagesDir || appDir, "..")` and does **one non-recursive scan of that single directory** for `middleware.*` — there is no dual root+src fallback check, contrary to what's commonly assumed. Since this app's `appDir` is `src/app`, `rootDir` resolves to `src/`, so a `middleware.ts` at the package root is structurally unreachable, not flaky. Fully explained in `src/middleware.ts`'s file-header comment — read that before ever moving `src/app` back to a top-level `app/`, since this file would need to move with it and nothing would error if you forgot.
  - **Real bug caught by `next build`, not `tsc`:** the "@auth/core/jwt" module (which declares the actual `JWT` type used by `NextAuthConfig`'s callbacks) isn't hoisted to top-level `node_modules` — it's nested at `next-auth/node_modules/@auth/core`. A `declare module "next-auth/jwt"` augmentation (the pattern most tutorials show) silently fails to merge because of this, leaving `token.role`/`token.extension` typed `unknown` in the `session` callback. Fixed with explicit `as` casts in `src/auth.config.ts` instead of fighting the augmentation — see that file's and `src/types/next-auth.d.ts`'s comments.
  - [ ] Not verified against a live Postgres — `create-admin-user.mjs` and the Credentials `authorize` DB lookup are unexercised beyond `tsc`/`next build`
  - [ ] Password reset, rate-limiting on login attempts, and self-service signup are all explicitly out of scope for now (per Auth.js's own credentials docs: "implement your own... rate-limiting and password reset")
- [x] **Agent status persistence (closes the §7 gap it raised)**
  - [x] `PATCH /api/extensions/[number]` — validates `{ status }` against the `AgentStatus` enum, writes `Extension.status` + `lastSeenAt`. Authorization: an AGENT may only patch their own extension (`session.user.extension === params.number`); ADMIN/SUPERVISOR may patch any (e.g. forcing a stuck agent OFFLINE) — via a new `requireSession()` in `auth-guard.ts` (weaker than `requireStaffSession()`, any signed-in user) plus a manual ownership check in the route itself
  - [x] `src/contexts/sip-context.tsx`'s `setAgentStatus` now actually calls the PATCH route — optimistic local update, reverts on failure, reads the target extension from `useSession()` (new `AuthSessionProvider` wrapper added to `layout.tsx` so client components can call `next-auth/react`'s `useSession`)
  - [ ] If a user has no linked `Extension` row (provisioning gap, not a bug), the status change stays local-only with a console warning — nothing routes around that gap yet
  - [ ] Not verified against a live Postgres, same as the rest of auth
- [x] **Phase 4 — REST API / AMI/ARI integration (scaffolded, not run against live Asterisk)**
  - [x] Asterisk AMI connection from backend — `src/lib/ami-client.ts`, hand-rolled TCP client (not a third-party AMI package), singleton across route invocations like the Prisma client. ARI was not used (see §6, this was a discretionary call — AMI covers everything the PRD asks for and needs no separate HTTP server)
  - [x] CDR ingestion contract — `POST /api/cdr` (Zod-validated, upserts by Asterisk `uniqueId`). **Now wired to a live feed** — `scripts/ami-cdr-listener.ts` calls it (see Foundation repair above)
  - [x] Extension/trunk provisioning endpoints — `GET/POST /api/extensions` (DB only, see Phase 3 gap above)
  - [ ] Never run against a live Asterisk instance — connection code (including the new collector and the CDR listener) is unexercised beyond `npm run build`/`npm run test`
- [ ] **Networking**
  - [x] `scripts/setup-tailscale-uae-office.sh` and `scripts/setup-tailscale-cloud.sh` written, wrapping the master doc §6.3 commands
  - [ ] Tailscale subnet router set up on UAE office PC — **not run, no physical office PC/Dinstar hardware in this session**
  - [ ] Route approved in Tailscale admin console — manual step, cannot be scripted
  - [ ] Cloud VM accepts routes and reaches Dinstar — **not run, no cloud VM in this session**
- [x] **Production-readiness pass (2026-08-24 — see §12 for the full changelog)**
  - [x] Docs: CLAUDE/AGENT.md decontaminated, master-doc §6 banner + live topology diagram, DEPLOYMENT.md rewritten (ports/certs/backups), both operator PDFs corrected and made reproducible (`docs/pdf1-template.html`, `scripts/build-docs.py`, `scripts/render-pdfs.ps1`)
  - [x] Deploy: Caddy reverse proxy shipped (`Caddyfile` + compose service; closes the no-TLS-for-web-ui Tier-0 gap), coturn pinned to `4.17-alpine`, `scripts/setup-firewall.sh`, `scripts/backup.sh`
  - [x] `GO_LIVE_CHECKLIST.md` created — Gate 0–4 ordered verification runbook
  - [x] Branding/auth: Scanner landing ("Algo PBX / wired for SAHARA", single Sign In), ShaderGradient/three stack removed, role-based post-login redirect
  - [x] Rooms chat UI wired (user-reported bug); `/admin/sms` gets a real inbox list; queue manager gains real AMI-backed mutations; CDR filters, report labels, voicemailPin display fixed
  - [x] Agent workspace: all audit-tier bugs fixed (dialpad leak, transfer failure feedback, hold-guard abort, TURN mid-call teardown, status sync, media rendering) + ESLint installed
  - [ ] Still open: every Gate in GO_LIVE_CHECKLIST.md requires the real VM (live calls first); wholesale MUI conversion of remaining admin pages deliberately deferred (see §12 scope call)
- [x] **WhatsApp SIM-port board + Guide 2 refresh (2026-08-24 — see §13)**
  - [x] `/admin/whatsapp` rebuilt as a fixed 2×2 board of SIM Port 1–4 slots, all scan-ready simultaneously (`sim-port-board.tsx` replaces `pairing-card.tsx`; zero API changes)
  - [x] Guide 2 §3 rewritten for the one-sidecar + four-numbers reality; checklist requires all four ports Connected; `{whatsapp_img}` slot added
  - [x] Screenshot pipeline: missing captures render an honest pending-note; VM recapture steps documented in `scripts/build-docs.py` (Docker absent on this machine — fallback executed per user approval)
- [x] **Structure graph**
  - [x] Re-run after every major structural change (see Build Log for the running node/edge/community counts) — **due again after the Foundation repair work**, see Build Log's newest entry
  - [ ] Re-check whether the Asterisk `.conf` out-of-scope issue (#1895/#1666) still drops those files

## 5. Build Log

Append one line per session/change, newest last. Format: `YYYY-MM-DD — what changed`.

- 2026-08-22 — Created `LLM.md` build-context tracker. No runtime code exists yet; repo currently holds only `ALGO_PBX_MASTER_DOC.md` and editor/agent tool scaffolding (`.claude`, `.cursor`, `.github`, `.jetro`, `.reticle`, `.agents`). Graphify (v0.9.39) confirmed installed but not yet run — nothing to graph until Phase 1 source files exist.
- 2026-08-22 — Scaffolded Phase 1: `docker-compose.yml`, `pbx_configs/{pjsip,rtp,extensions}.conf`, `.env.example`, `.gitignore`, `recordings/.gitkeep`. Compose file rewritten to pull secrets from env vars instead of the master doc's hardcoded values; Asterisk conf files use `REPLACE_ME_*` placeholders (Asterisk doesn't read `.env` directly, so these need a real templating/config-gen step later, or manual edit before deploy). YAML syntax validated (`yaml.safe_load`); `docker compose up` NOT run — no Docker on this Windows dev machine. Next: run and verify on the actual Ubuntu cloud VM.
- 2026-08-22 — Ran `graphify .` then `graphify cluster-only .`. Output in `graphify-out/`: 63 nodes, 56 edges, 21 communities across the doc/config scaffolding. The 3 Asterisk `.conf` files were dropped as out-of-scope by the extractor (upstream Graphify limitation, not a repo problem — see GRAPH_REPORT.md caveats). Re-run once Phase 2 frontend code exists for a graph that actually reflects application structure, not just docs/tooling.
- 2026-08-23 — Scaffolded Phases 2–4 in one pass (user asked to continue through all phases without stopping): `algo-pbx-frontend/` (Next.js 14.2.35 App Router, Tailwind, Prisma), `src/contexts/sip-context.tsx` (rewritten on `Web.SimpleUser`, adds hold/blind-transfer/DTMF/agent-status the master doc's reference version lacked), agent workspace UI (`/agent`), admin dashboard UI (`/admin`, `/admin/queues`, `/admin/cdr`, `/admin/extensions`), `src/lib/ami-client.ts` (hand-rolled AMI TCP client), and 6 API routes (`ami/status`, `cdr`, `queues`, `extensions`, `wallboard`, `intervention`). Added `pbx_configs/manager.conf` (not in the original master doc file list — needed for AMI) and fixed a networking inconsistency: `manager.conf` originally bound to `127.0.0.1`, which the bridged `web` container can't reach — rebound to `0.0.0.0` with an ACL restricted to the Docker bridge range, and added `extra_hosts: host.docker.internal:host-gateway` to `docker-compose.yml`. Also wrote `scripts/setup-tailscale-{uae-office,cloud}.sh` for the Networking phase (scripted the master doc §6.3 steps; the actual route-approval step and hardware are outside this session's reach).
  - **Verified:** `npx tsc --noEmit` clean; `npm run build` (Next production build) succeeds end-to-end after fixing one real bug it caught — `/api/wallboard` and `/api/queues` were being statically prerendered at build time and failing because they hit Prisma/AMI; fixed by adding `export const dynamic = "force-dynamic"` to every DB/AMI-backed route.
  - **Not verified:** nothing was run against a live Postgres, live Asterisk, or a real WSS/AMI endpoint — no Docker, cloud VM, or Asterisk instance available in this session. Treat all AMI/SIP code paths as "compiles and typechecks," not "confirmed working."
  - **Resolved open questions from §6 (previous revision):** ORM → Prisma; AMI vs ARI → AMI. **New open question raised:** no auth exists yet — see current §7.
- 2026-08-23 — Re-ran `graphify .` (incremental) + `graphify cluster-only .` + `graphify label .` now that Phases 1–4 have real code. Output: 252 nodes, 279 edges, 35 communities. Graphify flagged 3 files with tree-sitter syntax-parse warnings (`page.tsx` x2, `queue-manager.tsx`) — likely a JSX-parsing quirk in Graphify's extractor, not a real error, since `tsc --noEmit` and `next build` both pass clean on those files; not investigated further. `.env.example`/`.gitignore`/`Dockerfile` and similar are still skipped as "not classified" — expected, Graphify targets source/docs, not tooling config.
- 2026-08-23 — Added Auth.js v5 Credentials auth for `/admin/*` (and `/agent`), on user request. Grounded the implementation against the actual upstream repo/docs rather than from memory, per the user's explicit ask: fetched `nextauthjs/next-auth-example`'s `auth.ts`/`middleware.ts` for the App Router export shape, and `nextauthjs/next-auth`'s own `docs/pages/getting-started/authentication/credentials.mdx` for the `authorize` callback pattern, and `docs/pages/guides/edge-compatibility.mdx` for the auth.config.ts/auth.ts split (Prisma+bcrypt can't run in the Edge middleware runtime). New/changed: `src/auth.config.ts`, `src/auth.ts`, `src/middleware.ts`, `src/lib/auth-guard.ts`, `src/app/api/auth/[...nextauth]/route.ts`, `src/app/login/{page,login-form,actions}.tsx`, `src/types/next-auth.d.ts`, `algo-pbx-frontend/scripts/create-admin-user.mjs`. Added `next-auth@5.0.0-beta.32` + `bcryptjs@^3.0.3` to `package.json`, `AUTH_SECRET`/`AUTH_URL`/`AUTH_TRUST_HOST`/`CDR_INGEST_SECRET` to `.env.example` and `docker-compose.yml`'s `web` env.
  - **Two real bugs found and fixed via actually building** (not just typechecking) — see the Auth checklist item in §4 for details: (1) `middleware.ts` silently not loading because it was at the frontend root instead of `src/`, confirmed via the empty `middleware-manifest.json`; (2) the standard `declare module "next-auth/jwt"` type-augmentation pattern silently failing to merge due to `@auth/core` being nested under `next-auth`'s own `node_modules` rather than hoisted — worked around with explicit casts.
  - **Verified:** `npx tsc --noEmit` clean; `npm run build` succeeds with `Middleware  78.3 kB` actually present in the route output (the tell that it's loaded — its prior absence was bug (1) above). **Not verified:** no live Postgres to test the Credentials `authorize` DB lookup or `create-admin-user.mjs` end-to-end.
  - Re-ran `graphify .` + `graphify cluster-only .` + `graphify label .` afterward: 281 nodes, 329 edges, 38 communities.
- 2026-08-23 — Wired agent status persistence: `PATCH /api/extensions/[number]`, `requireSession()` added to `auth-guard.ts`, `AuthSessionProvider` (`next-auth/react`'s `SessionProvider`) added to `layout.tsx`, and `sip-context.tsx`'s `setAgentStatus` now calls the route with optimistic UI + rollback. Closes the §7 gap raised in the previous session.
  - On request, ran the previous session's two "real bugs" through the `dev:systematic-debugging` skill for a proper root-cause pass rather than leaving them as empirical fixes. The JWT-augmentation one held up as already correctly explained. The middleware one got a full root cause: read `node_modules/next/dist/build/index.js` directly and confirmed `next build` computes `rootDir = path.join(pagesDir || appDir, "..")` and does a single non-recursive scan of only that directory for `middleware.*` — there is no root+src dual-check, so a `src/app`-based project structurally cannot have its middleware picked up from the package root, full stop. Not a flake, not something that could regress silently *unless* the app directory itself moves. Rewrote `src/middleware.ts`'s header comment with this, replacing the earlier weaker "confirm the manifest isn't empty" framing.
  - **Verified:** `npx tsc --noEmit` clean; `npm run build` succeeds, `/api/extensions/[number]` present in route output, `Middleware 78.3 kB` still present (unaffected by this change, checked anyway since middleware.ts's neighborhood changed). **Not verified:** no live Postgres — the PATCH route's DB write and the optimistic-UI rollback path are unexercised beyond compiling.
- 2026-08-23 — User asked to audit 3CX's GitHub, fork what's useful, find gaps, "strictly invoke skills." Researched 3CX's org (10 public repos): **nothing forkable** — all thin client tooling over a closed, license-gated server (`xapi-tutorial`, `call-control-sdk-ts`, `cfd-demos` all need paid 3CX licenses to be useful; `agentic-call-control` is the one MIT repo worth reading, not forking). Audited our own repo in parallel and found the build was a compiling prototype, not a working PBX: **`pbx_configs/queues.conf` was missing entirely** (every inbound call would fail), the AMI client's single-response limitation was a known-but-unfixed gap, and `MixMonitor`/CDR-ingestion were both fully decorative (mounted volumes and DB fields with nothing populating them). User then asked for admin-created agent users with full call-center functionality (MOH, voicemail, transfer, conference, DNC list, asymmetric recording deletion). Planned in two passes (Plan-mode subagents) covering: 3CX audit, current-repo inventory, a "make it actually work" foundation design, and a 7-feature phased design (admin provisioning, MOH, DNC, recording retention, voicemail, attended transfer, conference) — user approved sequencing **foundation first, then features**. Full plan at `C:\Users\SAHARA\.claude\plans\refer-the-https-github-com-3cx-page-jiggly-starlight.md`.
  - **Independently verified two things myself against Asterisk 20's actual AMI docs before implementing** (not trusting the design subagent's assumptions): `CoreShowChannelsComplete` carries `ListItems` — confirmed absent from the initial ack, which is the literal root cause of the wallboard's `activeCalls` always reading 0. `QueueEntry` carries `Wait`/`Position`; `QueueMemberStatus`'s `Status` enum (0–8) confirmed exactly. Also independently found two bugs the design pass didn't: (1) `CoreShowChannels` counts *channels* not *calls* (a 2-leg call would show as 2), (2) `sip-context.tsx`'s `NEXT_PUBLIC_SIP_PASSWORD`/`NEXT_PUBLIC_SIP_EXTENSION` are build-time env vars baked into the client bundle — structurally incompatible with "admin creates multiple agent users," confirmed by reading sip.js's `SimpleUser` source (`"only handles a single concurrent session"`) and the actual usage sites.
  - **Executed Foundation phase this session** (Phase A—G features deferred to a future session, per the approved plan's honesty note that Phase A/F are each multi-day efforts): see the Phase Checklist's new "Foundation repair" entry above for the itemized list (queues.conf, AMI collector via `dev:test-driven-development`, recording, CDR listener). Skills invoked as instructed: `dev:test-driven-development` for the AMI collector (RED confirmed with `AmiClient is not a constructor` before any implementation existed, then GREEN, 5/5 passing) and the pure mapper/status-code test files; `Explore`/`Plan` subagents for the audit and designs; independent primary-source verification (docs.asterisk.org, sip.js source) rather than trusting any single pass uncritically.
  - **Verified:** `npx tsc --noEmit` clean; `npm run build` succeeds (`/api/channels`, `/api/recordings/[uniqueid]` present; `Middleware 78.3 kB` unaffected); `npm run test` — 18/18 passing across `ami-client.test.ts`, `queue-status.test.ts`, `cdr-mapper.test.ts`. **Not verified:** everything Asterisk-side remains compile/typecheck/unit-test confidence only — no Docker, Postgres, or Asterisk in this environment, same constraint as every prior session.
  - Ran `graphify . && graphify cluster-only . && graphify label .`: 327 nodes, 407 edges, 41 communities (up from 281/329/38). Same known Graphify limitation as before (#1895) drops `.conf` files and a few `.ts` files as "out-of-scope" — not a repo problem.
- 2026-08-23 — Executed Phase A (admin-created agents + PJSIP provisioning) from the approved 3CX-audit plan, on request to continue straight through without stopping. `dev:test-driven-development` invoked again for `renderPjsipConf` (RED: `Cannot find module './pjsip-config'`, then GREEN, 7/7). New/changed: `src/lib/{pjsip-config,pjsip-config.test,pjsip-provision}.ts`, `Extension.sipSecret` in `prisma/schema.prisma`, `GET /api/me/sip-credentials`, `POST/GET /api/admin/users` + `/admin/users` UI, `pbx_configs/{pjsip,pjsip-base,pjsip_dynamic}.conf` split, `docker-compose.yml` (shared RW mount for `pjsip_dynamic.conf` between `web`/`asterisk`), `sip-context.tsx` rewritten to fetch runtime credentials, `.env.example` (removed the always-vestigial `AGENT_1001_PASSWORD`/`PHONE_2001_PASSWORD`).
  - **Caught and fixed while implementing, not before:** Prisma's `omit` API (intended to exclude `sipSecret` from listing responses) type-checks as `never` in this client generation — apparently needs a preview flag this project doesn't have. Switched to explicit `select` before shipping, confirmed via `tsc`, not assumed to work.
  - **Verified:** `npx tsc --noEmit` clean; `npm run test` — 25/25 (7 new); `npm run build` succeeds, `/admin/users`, `/api/admin/users`, `/api/me/sip-credentials` all present, `Middleware 78.3 kB` unaffected. The seed `pjsip_dynamic.conf` was generated by literally running `renderPjsipConf` against the original 1001/2001 data rather than hand-transcribed, confirmed byte-identical to the prior hand-written template. **Not verified:** no live Postgres/Asterisk — the actual file-write-then-AMI-reload flow, and whether Asterisk's `pjsip reload` picks up `#include`d file changes without a full module cycle, remain unverified.
  - Security review of the credential-handling changes was done by hand (reasoning through each route's exposure surface — one-time secret disclosure, explicit `select` over full-row returns, ownership checks on `/api/me/sip-credentials`, no `NEXT_PUBLIC_*` secret leakage), not via the `security-review` skill — this repo has no `.git`, and that skill operates on `git diff` against a branch, which doesn't apply here. Noted so a future session doesn't assume that skill was run.
  - Ran `graphify . && graphify cluster-only . && graphify label .`: 344 nodes, 451 edges, 41 communities (up from 327/407/41). Two new minor warnings, not errors: `asterisk_20`/`coturn` nodes are "minted by two different files" (the master doc's prose descriptions collide with the same concepts elsewhere) — Graphify kept one variant and dropped the other; cosmetic, not a data-loss concern for our purposes.
- 2026-08-23 — Executed Phase B (Music on Hold) and Phase C (Do Not Call blocklist) from the approved plan, on request to continue through both without stopping. New/changed: `pbx_configs/{musiconhold,res_odbc,func_odbc,odbc.ini,odbcinst.ini}`, `moh/default/README.md`, `DoNotCallEntry` Prisma model, `src/lib/{phone-normalize,phone-normalize.test}.ts` (7 tests, all passed first run), `GET/POST /api/dnc`, `DELETE /api/dnc/[id]`, `GET /api/dnc/check`, `POST /api/dnc/bulk-import`, `/admin/dnc` UI, `sip-context.tsx`'s `makeCall()` gains a pre-dial DNC check + new `dialError` context field the Dialpad renders, `extensions.conf`'s `[from-agent]` gains the mandatory dialplan-side `DNC_CHECK()` guard.
  - **Two real bugs caught and fixed before shipping, not after:** (1) `odbc.ini` initially pointed the Postgres `Servername` at `postgres` (the compose DNS name) — but `asterisk` runs `network_mode: host` and has no bridge-network DNS at all, so that would never have resolved; fixed to `127.0.0.1`, the same pattern already learned from the Foundation phase's `manager.conf` fix (host-networked service reaching a bridge-network one). (2) Noticed while wiring this that Postgres's port was published on all interfaces (`"5432:5432"`) with no actual need — tightened to loopback-only (`"127.0.0.1:5432:5432"`) as a security hardening, since `web` never used the published port at all (bridge DNS instead) and `asterisk`/local-dev were the only real consumers.
  - **Two things flagged, not swept under a checkbox:** the dialplan's `DNC_CHECK()` does a raw string match with no phone-number normalization (can't call the TS normalizer from the dialplan) — a stored `+971...` entry won't catch a differently-formatted dial string; and whether the Asterisk image even has ODBC support at all is unverified, with a documented AGI-based fallback if it doesn't.
  - **Verified:** `npx tsc --noEmit` clean; `npm run test` — 32/32 (7 new, all pure `phone-normalize` logic); `npm run build` succeeds, `/admin/dnc` and all four `/api/dnc*` routes present, `Middleware 78.3 kB` unaffected. **Not verified:** no live Postgres/Asterisk — the ODBC connection itself, the `DNC_CHECK()` function's exact syntax, and MOH's `directory=default` resolution are all compile/config-review confidence only.
  - Ran `graphify . && graphify cluster-only . && graphify label .`: 371 nodes, 502 edges, 43 communities (up from 344/451/41).
- 2026-08-23 — Executed Phase D (recording retention, asymmetric agent/admin deletion) on request to continue. Re-entered plan mode first per the harness's own workflow; ran a fresh `Explore` pass to re-ground the design against actual current code rather than trusting the original sketch verbatim (it predated a lot of what Phases 0/A/B/C had since changed) — this caught that ownership has no FK (`CallDetailRecord.agentExtension` is a bare string) and that no agent-facing recordings UI existed at all yet, neither of which the original design had spelled out concretely. New/changed: `Recording` + `AuditLog` Prisma models, `src/lib/{recording-access,recording-access.test}.ts` (TDD'd, 7/7 first try, no refactor needed), `requireAdminSession()` in `auth-guard.ts`, `GET /api/recordings`, `POST /api/recordings/hide`, `DELETE /api/admin/recordings/[id]`, the byte-serving route rewritten from staff-only to session-based-with-ownership-check, `POST /api/cdr` extended to create `Recording` rows at ingestion, new `agent-recordings.tsx` component wired into `agent/page.tsx`.
  - **Real bug caught by `next build` itself, not a lint/style issue:** the originally-planned `/api/recordings/[id]/hide` route collided with the existing `/api/recordings/[uniqueid]` byte-serving route — Next.js requires one shared dynamic-segment name across sibling routes at the same path position, and these needed two genuinely different identifier types (CDR `uniqueId` vs `Recording.id`). Fixed by moving to `POST /api/recordings/hide` with `{ id }` in the body instead of the URL.
  - **Verified:** `npx tsc --noEmit` clean; `npm run test` — 39/39 (7 new); `npm run build` succeeds, all new routes present (`/api/recordings`, `/api/recordings/hide`, `/api/admin/recordings/[id]`), `Middleware 78.3 kB` unaffected. **Not verified:** no live Postgres — the `Recording`/`AuditLog` tables and the whole ingestion-to-hide-to-byte-serving chain are compile/typecheck/unit-test confidence only.
  - Manual security review in place of the `security-review` skill, same reason as Phase A — this repo still has no `.git` for that skill to diff against.
  - Ran `graphify . && graphify cluster-only . && graphify label .`: 393 nodes, 546 edges, 41 communities (up from 371/502/43).
- 2026-08-23 — Executed Phases E, F, and G (voicemail, attended transfer, ad-hoc conference) in one continuous pass, on request to continue through all three without stopping. This completes every phase in the 3CX-audit plan.
  - **Phase F's design changed mid-implementation, for the better, after reading sip.js's actual source instead of trusting the plan's own sketch:** the plan called for a hand-rolled migration onto raw `UserAgent`/`Inviter`/`Invitation`. Reading `node_modules/sip.js/lib/platform/web/session-manager/*.d.ts` before writing any code turned up `Web.SessionManager` — an official, exported, multi-session-native class with a built-in `transfer()` that already does exactly attended-vs-blind transfer. Used it instead. Smaller, safer rewrite than planned, same outcome, and it additionally eliminated *both* of the old private-`session`-field hacks (caller ID, blind transfer) that the plan hadn't expected to fully resolve.
  - **Two real bugs/gotchas caught and fixed while implementing, not discovered afterward:** (1) the classic Asterisk `Goto(vm-${DIALSTATUS},1)` extension-name-resets-`${EXTEN}` gotcha in the voicemail dialplan (Phase E) — worked around with a captured `VMBOX` variable; (2) the old `makeCall`'s `callState("active")` was set the instant `SimpleUser.call()` resolved, which the sip.js docs say happens when the INVITE is *sent*, not answered — the Phase F rewrite fixed this by waiting for `onCallAnswered`, a real correctness improvement, not just a side effect of the migration.
  - **`dev:test-driven-development` used for every new pure function across all three phases:** `renderVoicemailConf` (7/7), `parseVoicemailMessageMetadata`/`canAccessMailbox`/`parseVoicemailId` (13/13 combined), `findChannelsToRedirect` (4/4) — all passed on the first implementation attempt, no refactor needed in any case.
  - **Verified:** `npx tsc --noEmit` clean (Phase F's full context rewrite passed on the *first* attempt, not after iteration — a direct payoff of reading the `.d.ts` files first); `npm run test` — 63/63 (11 new since Phase D); `npm run build` succeeds across all three phases with every new route present (`/api/voicemail*`, `/api/calls/conference`), `Middleware 78.3 kB` unaffected throughout. **Not verified, honestly:** none of this has run against a live Asterisk or WSS endpoint — voicemail spool format, `SessionManager`'s on-the-wire REFER/Replaces behavior, and the conference `BridgeId`/media-renegotiation risk are all flagged explicitly in their own checklist items rather than assumed to work.
  - This closes out the entire plan at `C:\Users\SAHARA\.claude\plans\refer-the-https-github-com-3cx-page-jiggly-starlight.md` — Foundation through Phase G, all seven phases done. What remains is exclusively live-infrastructure verification (Docker/Postgres/Asterisk/WSS), not further design or implementation work.
  - Ran `graphify . && graphify cluster-only . && graphify label .`: 426 nodes, 625 edges, 43 communities (up from 393/546/41).
- 2026-08-27 — Call-path root cause (6 stacked bugs) found and fixed; **first call ever carried** (`*97`, 0% RTP loss). CDR ingestion (`cdr_manager.conf`), outbound recording (MixMonitor in `from-agent-common`), `_[+0-9].` dialplan match, `DINSTAR_SIP_PORT` setting, Track B security fixes, E1 admin user-edit, E2 Cloudflare errors, E6 admin recordings page, A5/B3b Docker entrypoints. Outbound GSM test: Asterisk side works, Dinstar returns 503 — pending gateway-UI config (user, 2026-08-28). Full detail in §17 + §18.
- 2026-08-28 — **First outbound GSM call with verified real bidirectional RTP audio** (national dial format; E.164 still 503/480 — carrier-side format rejection, not a bug). Both 503 hypotheses (source-address asymmetry, DINSTAR_SIP_PORT desync) eliminated as today's cause via live agent diagnosis, but the env-forwarding gap for `DINSTAR_SIP_PORT` is real and unfixed. New bug found: blind transfer re-dials through the same busy GSM trunk, correctly 503s — needs a design fix, not started. Inbound two-stage-dialing fixed via Dinstar UI (hotline + Do Not Answer setting); revealed a deeper carrier-side call-barring issue (GSM Event: `FORBID CALL`; SIP Call History: all zeros; USSD `*#35#` → `UNKNOWN APPLICATION`) — blocked on the operator contacting the SIM's carrier. Messaging track findings mapped, delegated to run in parallel (no longer last). Repo confirmed public; operator decided to push anyway. Full detail in §19.

## 6. Decisions Made While Scaffolding (flag if you'd have chosen differently)

- **ORM: Prisma**, not Drizzle. Master doc left this open. Picked for migration ergonomics; `prisma/schema.prisma` is the schema source of truth now — don't introduce Drizzle alongside it.
- **AMI over ARI** for the Phase 4 REST API. The PRD's needs (originate for intervention, queue status, CDR) all map cleanly onto AMI actions/events, and it avoids standing up a separate ARI HTTP application. Revisit only if a future feature genuinely needs ARI's per-call stasis-app control that AMI can't express.
- **Next.js 14.2.35, not 14.2.13.** The master doc's exact reference version has a disclosed CVE (shown as an `npm install` warning). Stayed on the 14.x line (not 15/16) since the master doc is explicit about "Next.js 14."
- **No Shadcn CLI run.** Components are hand-written Tailwind with the same glass-card/dark-slate look the master doc specifies. Nothing blocks swapping in real Shadcn components later; do it if the project wants Shadcn's specific primitives (Dialog, Toast, etc.), not just the visual style.
- **Auth: Auth.js v5 (next-auth beta) with Credentials + Prisma, not a third-party/hosted option.** Chosen because the user model (email/password, three roles) already lived in `prisma/schema.prisma` and Auth.js's Credentials provider maps onto it directly with no new service to run. Revisit only if there's a reason to want SSO/OAuth later — Auth.js supports adding providers alongside Credentials without a rewrite.
- **JWT sessions, not database sessions.** Credentials sign-in isn't compatible with Auth.js's database session strategy without extra plumbing, and the schema has no `Account`/`Session`/`VerificationToken` tables (no Prisma adapter installed) — keeping it that way was the simpler, still-correct choice for a Credentials-only setup.
- **3CX is a UX benchmark, not a codebase.** Confirmed by direct audit: their GitHub has no forkable PBX/dashboard/softphone code, only thin clients over a closed, licensed server. Staying on Asterisk + Next.js.
- **AMI collector over rewriting the AMI client with a third-party package.** `sendAndCollect()` is additive to the existing hand-rolled client rather than a rewrite/swap — the existing `send()`/framing/parsing is correct and battle-tested (now literally, via vitest), so the fix is scoped to exactly the gap (multi-event correlation), not a wholesale replacement.
- **`CoreShowChannels` counts channels, not calls — fixed by deduping on `Linkedid`, not by adding a separate "count calls" AMI action.** Simpler than an additional round-trip, and the data needed (grouping channels into calls) is already present on the same event stream `sendAndCollect` already gathers.
- **vitest over jest.** TS-native, zero babel config, fast — and this is the first test framework in the repo, so there was no existing convention to match. Scope: pure/mockable logic only (AMI framing, status/interface mapping, Cdr event mapping) — nothing here can exercise a live socket, DB, or Asterisk instance.
- **CDR listener as a standalone process + its own Dockerfile target/compose service, not a Next.js `instrumentation.ts` hook.** An AMI subscription needs one durable, reconnecting TCP connection; instrumentation hooks have no single-execution guarantee across server workers, dev restarts, or redeploys, risking duplicate or dropped CDR ingestion. Costs a second small container instead.
- **Recording route is staff-only for now, not yet agent-scoped.** The planned `Recording` model (retention/asymmetric-deletion feature, not yet built) will add agent-ownership + hidden-state checks enforced at this same byte-serving layer — deliberately deferred rather than half-built now with a model that doesn't exist yet.
- **Config-generation over PJSIP realtime for extension provisioning (Phase A).** Confirmed choice from the plan, executed as designed: avoids ODBC/sorcery/second-schema complexity and keeps Prisma the sole schema owner, at the cost of a `pjsip reload` round-trip per provisioning change instead of instant realtime pickup.
- **`Extension.sipSecret` is a separate field from `User.passwordHash`, not reused.** A bcrypt hash is one-way and cannot serve as a SIP digest secret — conflating the two would have been a functional bug (agents could never actually register), not just a modeling nitpick.
- **Secrets disclosed once, at creation, never again via GET — enforced with `select`, not `omit`.** Discovered `omit` doesn't work in this Prisma client generation (types reject it as `never`); used explicit `select` instead rather than spending more time chasing the preview-flag requirement for a feature with an equivalent, equally-simple alternative.
- **DNC dialplan enforcement: `func_odbc` direct-to-Postgres, not an AGI script or ARI.** Per the plan's rationale — a single synchronous lookup doesn't justify a separate script runtime (AGI) or a whole Stasis app (ARI). Accepted tradeoff: unverified whether the Asterisk image has ODBC support at all; documented AGI fallback if it doesn't.
- **DNC dialplan check fails open on an ODBC error, not closed.** A DNC-infrastructure problem taking down all outbound calling was judged worse than the (hopefully rare) risk of a call slipping through during an outage — but this is a compliance-relevant tradeoff, not a purely technical one, and is flagged for sign-off rather than treated as obviously correct.
- **Postgres port tightened to loopback-only while wiring ODBC**, not as a separate initiative — found and fixed in the same pass since Phase C's work was what actually depended on that port being reachable at all, making the review natural to do there.
- **Dedicated `Recording`/`AuditLog` models over more `CallDetailRecord` fields (Phase D).** A call may have more than one recording in a future phase (transfer/conference consult legs) — coupling recording lifecycle 1:1 into the CDR would have blocked that later without a schema migration that's avoidable now.
- **`recording-access.ts`'s `canAccessRecording()` is the single source of truth for both listing and byte-serving.** Two independent implementations of "is this hidden/owned" would have been the exact class of bug the original design's "critical security property" note was warning about — a recording invisible in the UI but still fetchable by guessing/reusing its URL.
- **Hide via request body, not a `[id]` URL segment, after `next build` caught the routing collision.** Not a preference — Next.js's dynamic-segment-name-must-match-across-siblings rule made the originally-planned shape impossible to ship.
- **No admin UI for the hard-delete route.** The plan named the route as a deliverable, not a management page; added the minimum, not speculative UI for an action that's rare by nature (permanent, compliance-relevant deletion).
- **`Web.SessionManager` over hand-rolled `UserAgent`/`Inviter`/`Invitation` (Phase F).** Discovered by reading sip.js's own source before implementing, not by following the plan verbatim — it's the officially exported, multi-session-native class with a built-in attended/blind `transfer()`, making the "large rewrite" meaningfully smaller and safer than the plan estimated while achieving the same goal.
- **Voicemail deletion is destructive; recordings are not (Phase E vs. D).** The user's requirement named recordings specifically ("the agent side deletion will not delete the recording"), not voicemail — read literally rather than assumed to generalize. Flagged for confirmation in both the plan and here; revisit if voicemail should get the same hide-not-delete treatment.
- **Conference orchestration is entirely server-side AMI (Redirect + Originate), not a softphone-driven flow (Phase G).** Browser WebRTC has no way to mix three parties' audio itself — only Asterisk's ConfBridge can — so this was never a sip.js-context decision the way transfer was.
- **OpenWA's REST surface was rewritten against the real upstream repo, not re-guessed (§11).** The original `openwa-provider.ts` invented a plausible-looking API (`/api/instances/...`) that never matched any real server — verified false by actually building and running the pinned upstream sidecar and hitting it. `src/lib/messaging/openwa-client.ts`/`openwa-types.ts` are transcribed from OpenWA's own official SDK source at the pinned commit, not from documentation prose, and confirmed against the live container's real responses.
- **Hand-rolled Emotion cache provider over `@mui/material-nextjs` (§11).** That package's `AppRouterCacheProvider` crashes SSR page-data collection against `@mui/material@9.x` (`unstable_createUseMediaQuery is not a function`) — a real upstream incompatibility, confirmed by removing the package and having the crash disappear. MUI's own docs describe the manual pattern as an equally-supported alternative; used it instead of pinning to an older, compatible-but-stale `@mui/material-nextjs` version.
- **Pinned Prisma engine binaries explicitly rather than trusting `binaryTargets: ["native"]` (§11).** Alpine 3.23's OpenSSL 3.x isn't recognized by Prisma 5.22's auto-detection, which silently ships an incompatible engine — this is an upstream Prisma/Alpine version-compatibility gap, not a config mistake, and would have broken every database call in the deployed image had it shipped undetected.

## 7. Open Questions / Decisions Deferred to User

- Real production domain to replace `YOUR_VM_PUBLIC_DOMAIN` throughout configs and `.env`.
- Secrets: `.env.example` and `pbx_configs/manager.conf`/`pjsip.conf` placeholders (`REPLACE_ME_*`) need real values before any deployment — never commit real ones.
- ~~No authentication exists yet~~ — **resolved 2026-08-23**, see §4's Auth checklist item. `/admin/*` and `/agent` now require sign-in via Auth.js.
- ~~Agent-status persistence still not wired up~~ — **resolved 2026-08-23**, see §4's Agent status persistence checklist item.
- **Users without a linked `Extension` row can't have their status persisted.** `setAgentStatus` degrades to local-only state with a console warning in that case (see `sip-context.tsx`). Only matters once real users exist beyond the bootstrap admin — worth fixing before onboarding real agents, by making extension-assignment part of user provisioning.
- **No signup/password-reset/rate-limiting.** Deliberately out of scope for now (see §4's Auth checklist) — `create-admin-user.mjs` is the only way to create or update a user. Decide before any real users besides the bootstrap admin need accounts.
- ~~The AMI multi-event collector gap should probably be fixed before demoing the wallboard/queue manager/intervention flow~~ — **resolved 2026-08-23**, see the Foundation repair checklist item.
- ~~Admin-created agent users need PJSIP provisioning~~ — **resolved 2026-08-23**, see §4's Phase A checklist item. Admins can now create users with linked extensions that actually register.
- ~~Music on Hold, Do Not Call blocklist~~ — **resolved 2026-08-23**, see §4's Phase B and Phase C checklist items.
- ~~Recording retention with asymmetric agent/admin deletion~~ — **resolved 2026-08-23**, see §4's Phase D checklist item.
- ~~Three more requested features remain designed but not built: voicemail, attended transfer, ad-hoc 3-way conference~~ — **resolved 2026-08-23**, see §4's Phase E/F/G checklist items. Every phase in the 3CX-audit plan is now built.
- **No admin UI for the hard-delete recording route** (`DELETE /api/admin/recordings/[id]`) — deliberately API-only per the plan's stated scope. Build one if/when there's an actual need to hard-delete recordings from the product rather than a script/API client.
- **`AuditLog` has no viewer UI** — rows are written on hide/hard-delete but nothing in the product surfaces them. Fine for now (data exists for future compliance reporting), but worth building a view before anyone actually needs to audit an incident.
- **The entire 3CX-audit plan is now implemented — nothing left to design.** What remains for every phase (Foundation through G) is exclusively *live-infrastructure verification*: standing up the actual Docker/Postgres/Asterisk/WSS stack (on the Ubuntu cloud VM this was always meant for, per the master doc) and confirming the many explicitly-flagged unverified assumptions — AMI field names (`Linkedid`, `BridgeId`, `QueueMember`/`Cdr` fields), ODBC driver presence, `#include`-then-reload pickup for `pjsip`/`voicemail` dynamic configs, voicemail spool format, and `SessionManager`'s real on-the-wire REFER/Replaces and multi-session media behavior. This is the natural next step whenever real infrastructure becomes available — not more code in this environment.
- **Voicemail deletion vs. recording retention asymmetry (Phase E) still needs a human confirmation**, not just an engineering default — see §4's Phase E checklist and §6's decision entry.
- **DNC dialplan matching's lack of normalization (Phase C) and its fail-open-on-ODBC-error tradeoff (Phase C) both still need compliance sign-off**, carried forward unresolved from earlier in this document — re-flagging here since Phase C predates this final consolidation and it would be easy to lose track of.
- **Conference's `BridgeId` dependency and WebRTC-redirect media risk (Phase G)** are the least-verified assumptions in the whole plan — prioritize testing this phase first if/when live Asterisk access is available, precisely because it's stacked on top of two other unverified assumptions (the AMI collector's field names AND live media renegotiation).
- ~~Queue membership is still static~~ — **resolved 2026-08-23**, see §11. `queues.conf`'s hardcoded member line is gone; `src/lib/queue-membership.ts` adds/removes AMI queue membership at agent creation/disable time.
- **`Extension.sipSecret` is stored in plaintext in Postgres**, same risk tier as other plaintext service-account secrets already in this schema (e.g. AMI/CDR-ingest secrets live in env vars, not the DB, which is actually a stronger posture than this). Worth encrypting at rest before real deployment — flagged, not fixed.
- **No UI yet to rotate a `sipSecret`** or hard-delete an extension/user — Phase A only covers creation. An admin who needs to revoke access currently has no in-product path to do so.
- **DNC dialplan matching doesn't normalize dialed numbers** — a real compliance gap, not just a nice-to-have, per §4's Phase C checklist. Needs either a strict dialing-convention policy or a future AGI-based check before this can be trusted as the sole compliance control.
- **Unverified whether the Asterisk image (`tiredofit/asterisk:20-latest`) has ODBC support at all** — `pbx_configs/odbc.ini`'s header comment has the fallback plan (AGI calling back into `GET /api/dnc/check`) if it doesn't. Confirm on first real deployment before trusting the dialplan-level DNC check.
- **DNC fail-open-on-ODBC-error tradeoff needs compliance sign-off**, not just engineering judgment — flagged in §4's Phase C checklist, not silently decided.

---

## 8. Trial-Readiness Pass (2026-08-23) — voice fixes, security hardening, and the unified WhatsApp/SMS/CRM/MCP workstream

A full audit (three parallel Explore agents covering auth/API, voice/media quality, and UI/data-model/messaging fit) found the system had never carried a real call: three independent Tier-0 defects meant no WebRTC audio could flow at all, plus a dozen security blockers including an AMI CRLF-injection path reachable by a plain AGENT session. This section records what changed to fix that and to add the client's four new requirements (Resend agent invites with locked credentials, a WhatsApp+SMS chat panel via a forked OpenWA sidecar with Meta Cloud API fallback, an admin-gated SIM-SMS approval workflow, an internal MCP server, and generic CRM webhook/REST connectivity). Full reasoning for every decision lives in the plan file this session worked from; this is the terse changelog.

**Voice — Tier 0 (nothing worked before these):**
- `pbx_configs/http.conf` didn't exist — `pjsip-base.conf`'s `[transport-wss]` `bind=` line is inert; WSS is served by Asterisk's HTTP server, configured separately. Created it, mounted in `docker-compose.yml`.
- DTLS media certs (`pbx_configs/keys/`) were referenced but never generated or mounted — every WebRTC call's DTLS handshake would fail silently. Directory + generation instructions added (`pbx_configs/keys/README.md`); keys themselves are `.gitignore`'d and must be generated per-deployment.
- Coturn and Asterisk both claimed UDP 10000-10100 on the same host network — split to Asterisk 10000-20000 / Coturn 20001-30000.

**Voice — quality (jitter/latency/dropouts):**
- Added `JITTERBUFFER(adaptive)=200,80,60` to both `[from-agent]` and `[from-dinstar]` dialplan contexts, plus `jitterbuffer=yes` on ConfBridge — there was no jitter buffer anywhere in the system.
- `rtp_timeout`/`rtp_timeout_hold` added everywhere (endpoints leaked ports forever on a dead channel).
- `direct_media=no` added to the generated WebRTC/hardware endpoint templates (`src/lib/pjsip-config.ts`) — was defaulting to `yes`, which tried to steer media directly between a DTLS/SRTP browser and the alaw Dinstar trunk and couldn't succeed.
- Codec order flipped to `alaw,ulaw,opus` (was `opus,ulaw,alaw`) — every call was transcoding opus↔alaw for zero perceptual benefit, since the far end is always 8kHz GSM.
- Coturn's `--external-ip` was never set (relay candidates advertised the private IP) and the browser never received `iceServers` at all (`NEXT_PUBLIC_TURN_SERVER` was defined and never read). Added `src/app/api/me/turn-credentials/route.ts` (mints coturn REST ephemeral credentials) and wired `iceServers`/`iceTransportPolicy: "all"`/`iceGatheringTimeout: 2000` into `sip-context.tsx`.
- SIP.js `SessionManager` had zero reconnection logic — a dropped WebSocket left the UI showing `AVAILABLE`/connected forever while the agent was actually unreachable. Added `reconnectionAttempts`/`reconnectionDelay`/keepalive/`onServerConnect`/`onServerDisconnect`.
- Fixed the `<audio autoPlay>` element to use a ref + explicit `.play().catch()` with a UI "unmute" affordance (`audioBlocked`/`retryAudioPlayback` in `useSIP()`) — Chrome's autoplay policy could silently block inbound-call audio.
- Explicit `echoCancellation`/`noiseSuppression`/`autoGainControl`/`channelCount`/`sampleRate` audio constraints (was bare `audio: true`).
- Added `pbx_configs/asterisk.conf` (`highpriority=yes`) + `cap_add: [SYS_NICE]` + resource limits on `web`/`postgres` in `docker-compose.yml` — Asterisk previously ran at normal priority alongside Postgres/Next.js on the same host.
- Added WebRTC quality telemetry: `src/lib/webrtc-stats.ts` (jitter/loss/RTT/MOS-estimate extraction from `getStats()`), `CallQualitySample` table, `POST /api/calls/quality`, polled every 5s from `sip-context.tsx` during an active call. There was previously zero data to diagnose an agent's "the audio was bad" report.
- Fixed `dtmf_mode` on the Dinstar trunk (was unset → PJSIP default `rfc4733`, may not match the gateway) and stopped `dialpad.tsx` sending DTMF into a held (sendonly) call.
- Gave the CDR listener its own narrowly-scoped AMI account (`[algopbx-cdr-listener]` in `manager.conf`, `read = cdr` only) instead of sharing `[algopbx-app]`'s full event-class subscription.

**Security:**
- **AMI CRLF injection (the most serious finding):** `src/lib/ami-client.ts`'s `frameAction()` now rejects any field value containing CR/LF before it reaches the wire — closes a path from a plain AGENT session (via `/api/calls/conference`) to arbitrary AMI actions including `Action: Command`. Route-level Zod schemas on `/api/calls/conference` and `/api/intervention` also tightened to digit/channel-shaped regexes as defense in depth.
- `/api/intervention` (supervisor spy/whisper/barge) now sources the supervisor's own extension from the session, not the request body; cross-checks `targetChannel` against a live `CoreShowChannels` list before acting; and audit-logs every intervention. Previously unrestricted and unaudited.
- Login rate-limiting/lockout added (`LoginAttempt` table, `src/lib/rate-limit.ts`), plus a constant-time miss path (`DUMMY_HASH` compare) to close a user-enumeration timing oracle. Previously: none.
- `User.disabled` + a live Postgres check on every request in `src/auth.ts`'s `jwt` callback (not just at sign-in) — a revoked account's session now dies on its next request instead of surviving up to the JWT's lifetime. `session.maxAge` also cut from NextAuth's 30-day default to 8h. New `PATCH /api/admin/users/[id]` route to toggle it.
- `prisma/migrations/` created from scratch (there was none — a fresh deploy had no schema). `Dockerfile` now runs `prisma migrate deploy` on container start, non-root user, `HEALTHCHECK`.
- Voicemail/recording delete routes no longer silently swallow `EROFS`/unlink failures and report `ok:true` anyway; the `./voicemail`/`./recordings` mounts are read-write in `docker-compose.yml` now (were `:ro`, so deletion could never have worked); recording hard-delete unlink failures are now audit-logged instead of vanishing.
- `next.config.mjs` now sets CSP/HSTS/`X-Frame-Options`/`X-Content-Type-Options`/`Referrer-Policy`/`Permissions-Policy` — none existed before, for an app holding a plaintext SIP secret in browser memory.
- Wallboard's fabricated `waiting: 0`/`longestWaitSec: 0`/every-member-`AVAILABLE` placeholder data replaced by sharing `/api/queues`'s real AMI computation (`src/lib/queue-status.ts`'s new `getQueueSnapshots()`).
- `admin/page.tsx`'s silent `?? "9000"` supervisor-extension fallback replaced with an explicit "no extension linked" state.
- `src/app/admin/layout.tsx` added — the admin nav previously lived inline in `admin/page.tsx` only, so every other `/admin/*` subpage had no navigation at all.
- `GET /api/cdr` query params Zod-validated (previously 500'd on bad input); `dnc/bulk-import` capped at 2MB/100k lines (previously unbounded sequential upserts); `AUTH_SECRET` now fails fast at boot in production if unset.

**Workstream D — Resend invites:** `Invite`/`User.passwordHash` (now nullable) in schema; `POST /api/admin/users` creates a user with no password and emails a single-use 24h-expiry link (`src/lib/mail/resend.ts`, `src/app/invite/[token]/page.tsx`, `POST /api/invite`). Replaces the old admin-typed "temporary password" that was never emailed or rotatable. There is deliberately no route anywhere that lets an agent change their own email or password after that — enforced by absence, not a permission check.

**Workstream E — WhatsApp + SMS:** `MessageProvider` interface (`src/lib/messaging/types.ts`) with three adapters — `OpenWaProvider` (primary, forked/vendored per `vendor/openwa/README.md`; evolution-go was rejected: license-activation gate + stale repo), `MetaCloudProvider` (fallback), `DinstarSmsProvider` (SIM SMS over the UC2000's HTTP/JSON API, unverified against a live unit, polled not pushed). New tables: `WaInstance`, `Contact`, `Conversation`, `ChatMessage`, `SmsAccessRequest`, `Room`. Admin-only WhatsApp pairing/logout (`src/app/admin/whatsapp`); admin-only SIM SMS inbox with an OTP-heuristic sensitivity classifier (`src/lib/messaging/sensitive-detect.ts`) and a request→approve/decline/revoke unlock flow (`src/app/admin/sms`, `SmsAccessRequest`) — a sensitive message's body never leaves the server to an agent session without an approved, time-boxed grant. Agent chat panel (`src/components/chat/*`) added to `agent/page.tsx`'s new two-column layout. Rooms (`src/app/admin/rooms`) are a UI-only saved filter — no tenancy, no scoping added to any other model.

**Workstream F — internal MCP server:** `mcp-server/` (stdio only, never network-exposed). Read tools (PJSIP/channel/queue state, CDRs, WebRTC quality, config files with secrets redacted, container logs) need no approval. Write tools (`provision_extension_reload`, `restart_container`) require a short-lived, single-use, admin-minted `McpApproval` token (`POST /api/admin/mcp-approvals`) and audit-log every use. No tool accepts a free-text shell command or raw AMI action string — read commands are a fixed enum table, matching the same discipline the AMI CRLF fix applies at the app layer.

**Workstream G — CRM connectivity:** Generic layer only, no named CRM adapter yet (per plan). `src/lib/webhooks.ts` (HMAC-signed, retried delivery) + `emitEvent()` fan-out to `WebhookSubscription` rows, wired to `call.ended` (CDR ingest) and `message.received`/`message.sent` (messaging routes). `ApiKey`-authenticated REST surface under `/api/crm/*` (contacts, contact activity timeline, click-to-call) — see `src/app/api/crm/README.md`.

**What still needs live verification before the trial** (nothing further to design, only to confirm against real infrastructure — same status this doc already recorded for the rest of the system in §7):
- Every OpenWA/Dinstar API shape is best-effort against public docs, not a live instance — see `src/lib/messaging/openwa-provider.ts` and `dinstar-sms-provider.ts`'s own "UNVERIFIED" headers.
- The `@modelcontextprotocol/sdk` API surface `mcp-server/index.ts` is written against has not been run in this environment — `mcp-server/README.md` says so explicitly.
- The hand-written `prisma/migrations/20260823000000_init/migration.sql` (and the three migrations added on top of it) were authored without a reachable Postgres to diff against — verify with `prisma migrate diff` against a throwaway dev database before trusting it as a deploy baseline.
- MOH audio files are still not present (`moh/default/` — licensing is an operator concern, unchanged from before this pass) — callers still hear silence on hold/in queue until real files are added.
- Middleware-level page redirects (`src/middleware.ts`, edge runtime) do not carry the `User.disabled` live-check the API layer now has — a disabled agent's `/agent` page shell can still render until their first API call 401s. The API layer is the actual security boundary (already true before this pass — middleware never was, per its own header comment) but this is worth closing if a disabled account rendering a page shell (with no working data) is judged unacceptable even briefly.
- No route-handler-level test suite was added for the new auth/security logic (rate limiting, disabled-account propagation, invite consumption) — the existing 79+ tests remain concentrated on pure `src/lib/*` functions, now joined by `ami-client`'s new CRLF-rejection tests, `queue-status`'s shared-snapshot tests, `webrtc-stats`, `webhooks`, `mcp-server/allowlists`, and the messaging workstream's `sensitive-detect`/`wa-id`/`conversation-access` tests.
- `graphify-out/` (the dependency graph in this repo) was not regenerated as part of this pass — no CLI entry point for that exists (`graphify` is a skill-installer, not a graph-rebuild command); it needs the graphify skill run fresh over the current tree, or a future session with that skill loaded.

---

## 9. Agent Registration, Phone OTP, Login 2FA, and Admin Reporting (2026-08-23)

Extends the invite flow (§8's Workstream D) with a real post-invite registration step, phone verification, and two pieces of admin visibility that didn't exist at all before: who is signing in, and how many hours each agent actually talks. Full reasoning and rejected alternatives (including why `Shelex/free-otp-api`, `send-mobile-otp-php`, and `sms-retrieval-api-demo` were each not directly usable) live in the plan file this session worked from — this is the terse changelog. Invoked via the `fullstack-guardian` skill per the user's instruction.

**Schema:** `User` gains `phoneE164` (unique, nullable), `phoneVerifiedAt`, `phoneVerifiedByAdminId` (null = self-verified via OTP, set = admin override — kept distinguishable deliberately), `address`, `photoPath`, `profileCompletedAt`, `signInFeedSeenAt`. New `OtpChallenge` (DB-backed OTP state — send-throttled to 5/hour per user+purpose, guess-throttled to 5 attempts, never reused `checkSimpleRateLimit()` since that in-memory limiter isn't safe for something this sensitive) and `TrustedDevice` (30-day 2FA-skip cookie, hash-only storage matching the `Invite`/`ApiKey` pattern). Sign-in events reuse `AuditLog` (`action: "auth.signin"`) rather than a new table.

**Phone verification — two channels, not interchangeable:**
- **Firebase Phone Auth is PRIMARY** (`src/lib/firebase/client.ts` + `admin.ts`) — free at this scale (10k/month), no Indian DLT registration needed since Google is the registered sender. The client never gets to just *claim* verification succeeded: the server (`POST /api/register/verify-phone`) calls `verifyIdToken()` on the Firebase ID token and checks its `phone_number` claim matches the number being registered.
- **WhatsApp is the FALLBACK, registration path only** — triggered exclusively when the Firebase step itself errors, never tried first (Meta template sends cost money and are separately rate-limited). Required adding `sendTemplate()` to the `MessageProvider` interface (`src/lib/messaging/types.ts`), implemented only by `MetaCloudProvider` — never OpenWA, since routing OTPs through an unofficial WhatsApp engine is a ban risk.
- **Login 2FA (Workstream 6, built in full despite being marked "safe to cut" in the plan) uses a THIRD, server-driven path** (`src/lib/otp/service.ts` + `src/lib/two-factor.ts`), deliberately not Firebase's client SDK — that SDK requires the browser to hold the full phone number, and at the 2FA step the user isn't authenticated yet. `POST /api/auth-2fa/pre-login` (password check + trusted-device check) and `POST /api/auth-2fa/verify` (OTP confirm + issues the 30-day trusted-device cookie) sit in front of `src/auth.ts`'s `authorize()`, which now also requires a short-lived signed `otp_verified` cookie (HMAC'd with `AUTH_SECRET`) for any user with a verified phone. `src/app/login/login-form.tsx` was rewritten from a server-action form to a client component to drive this two-phase exchange; the old `actions.ts` was deleted (nothing else imported it).

**The hard gate:** only `AGENT` role is gated (staff have no invite/profile and would be locked out otherwise). `session.user.profileComplete` is recomputed live on every request by `src/auth.ts`'s `jwt` callback, same mechanism as the existing `disabled` check. `src/middleware.ts` redirects an incomplete agent's page loads to `/register`, but the **actual enforcement is `GET /api/me/sip-credentials`** refusing credentials to an unregistered/unverified agent — middleware's matcher excludes `/api` by design, so without that route's check a page-only gate would be cosmetic.

**Admin override:** `PATCH /api/admin/users/[id]` gained a `verifyPhoneOverride` action (`phoneVerifiedByAdminId` set, distinguishable from self-verification) for the case named explicitly in the requirements — "if the verification is having some glitch the admin will have power to override."

**Photo upload** (`src/lib/agent-photo.ts`, new `sharp` dependency): validated by actually decoding the image (never trusts the `Content-Type` header — an uploaded `.php` renamed `.jpg` fails here), capped at 5MB, resized, and **always re-encoded to strip EXIF** (phone photos routinely carry GPS coordinates). Served only through `GET /api/me/photo/[id]`, visible to the owning agent and staff, never other agents. Optional — a missing photo does not block `profileCompletedAt`.

**Admin visibility, both new:**
- `/admin/sign-ins` — every successful sign-in, polled every 5s (this codebase's standard "realtime" pattern, no websocket/SSE infra exists). New-device sign-ins (heuristic: has this exact user-agent signed in before) are flagged.
- `/admin/reports` — talk-time-per-agent (`CallDetailRecord.billsecSec` summed, day/week/month/all-time), reporting/monitoring only, explicitly not payroll. **Caveat recorded in the route's own header, not silently absorbed:** `agentExtension` is a bare string, not a foreign key, so a reassigned extension's historical hours would follow the extension, not the person — fine for monitoring, wrong if this ever fed pay (fix would be snapshotting `userId` onto each CDR at ingest).

**Not built:** a live test wired to `free-otp-api` for CI (the plan's "Automated" verification gate) — the OTP flow's correctness was reasoned through and unit-tested at the pure-function layer (`registration.test.ts`, `two-factor.test.ts`, `agent-photo.test.ts`) but no end-to-end test harness exists in this environment to actually run one.

**What needs live verification before trusting this in the trial** (same status as everything else flagged in §8 — nothing left to design):
- **`npm install` has not been run against the three new dependencies** (`firebase`, `firebase-admin`, `sharp`) added to `package.json` — `node_modules` in this environment predates this session's edits, so none of the new code has actually been type-checked or executed. Run `npm install` and `npm run typecheck` before anything else.
- A real Firebase project needs to exist with Phone Auth enabled, and `FIREBASE_SERVICE_ACCOUNT_JSON`/`NEXT_PUBLIC_FIREBASE_*` populated — nothing here works against the placeholder values in `.env.example`.
- The WhatsApp OTP template (`WHATSAPP_OTP_TEMPLATE_NAME`) must be created and approved in the Meta Business Manager as an authentication-category template before the fallback path — or login 2FA at all — can send anything; `MetaCloudProvider.sendTemplate()`'s exact request shape is unverified against a live WABA.
- The `prisma/migrations/20260823020000_add_agent_registration/migration.sql` migration carries the same hand-written, unverified-against-live-Postgres caveat as every other migration in this repo — diff it before deploying.
- The new-device heuristic in `src/auth.ts` (exact user-agent string match against `AuditLog` history) is intentionally simple and spoofable — it's a supervisor-visibility signal, not a security control; `TrustedDevice`'s hashed-cookie mechanism is the actual security boundary for 2FA skip.

---

## 10. Runtime Configuration, Setup Wizard, and OpenWA-primary OTP (2026-08-23)

Resolves everything §9 flagged under "before this runs" — not by doing that setup, but by removing most of the need for it, plus makes every external-service credential admin-configurable from the browser instead of `.env`-only, and adds a first-run `/setup` wizard so the first admin account no longer requires shell access to the container. `npm install` was actually run this time (`node_modules` in this repo now reflects `package.json`), and `npx tsc --noEmit`, `npx vitest run` (170/170 passing), and a full `npm run build` were all run clean before calling this done — the previous two sessions' "not yet verified" caveats on those specific points are resolved, not just re-flagged.

**OTP channel reversed from the §9 plan, deliberately:** OpenWA is now the *default* `OTP_CHANNEL`, not Firebase. Earlier guidance called sending OTPs over OpenWA a "ban magnet" — that reasoning was about customer-facing bulk OTP and doesn't transfer to ~50 codes ever, sent to known staff, on numbers with existing two-way conversation history. The real risk is shared blast radius (an OpenWA ban takes customer messaging down with it), addressed with an `OTP_WA_INSTANCE_ID` setting letting an operator dedicate one SIM to OTP if they want that isolation. `src/lib/otp/service.ts`'s `sendOtp()`/`verifyOtp()` are now channel-routed (`OPENWA` | `META_CLOUD`, both server-driven through the existing `OtpChallenge` table; `FIREBASE` is refused there and handled entirely client-side instead — see `src/app/register/page.tsx`'s channel branch). This means **OTP delivery works with zero external setup** — no Firebase project, no Meta template approval — the moment one OpenWA instance is paired.

**A second, more serious build-time-vs-runtime bug, found by actually running `npm run build`:** `src/auth.ts`'s `AUTH_SECRET` fail-fast check (added in §9) ran at module-load time whenever `NODE_ENV=production`, which `next build` sets internally regardless of the ambient environment — and `docker-compose.yml` correctly supplies `AUTH_SECRET` only at container *runtime*, not as a Docker build arg. Every `docker compose build` would have failed before producing an image at all. Fixed by excluding the `PHASE_PRODUCTION_BUILD` phase (`process.env.NEXT_PHASE`) from the check — same "build time vs. runtime" class of bug as the `NEXT_PUBLIC_SIP_*` fix below, caught only because the full build was actually run end-to-end rather than stopping at typecheck.

**The `NEXT_PUBLIC_SIP_*` build-time bug from §9's investigation, fixed:** Next.js inlines `NEXT_PUBLIC_*` vars at build time; `docker-compose.yml` only ever supplied `NEXT_PUBLIC_SIP_WS_SERVER`/`NEXT_PUBLIC_SIP_DOMAIN` at runtime, so every built image had both as `undefined` and every agent's softphone silently fell back to `wss://algopbx.local:8089/ws` — a hostname that doesn't resolve. Fixed with `GET /api/config/public` (new, unauthenticated, non-secret), which `src/contexts/sip-context.tsx` now fetches on mount instead of reading `process.env` directly (a `sipDomainRef` mirrors the value for the `useCallback`s that build `sip:` URIs). The same mechanism is why Firebase's client config (`NEXT_PUBLIC_FIREBASE_*`) can now be admin-configurable at all — `src/lib/firebase/client.ts` was previously reading build-time constants that a settings-panel edit could never have reached.

**A real, unrelated sip.js misconfiguration also found while fixing the above and typechecking it:** `sessionDescriptionHandlerFactoryOptions` (ICE servers, TURN credentials, `iceGatheringTimeout`, and the getUserMedia `constraints` carrying echoCancellation/noiseSuppression/autoGainControl) was placed at the top level of `SessionManagerOptions` in §8's voice-quality work. That field doesn't exist there — sip.js's actual type puts it under `userAgentOptions`. It compiled (TypeScript's excess-property check didn't catch the misplacement under the specific object-literal shape used) but was never wired to the session description handler at runtime, meaning **the TURN/ICE and audio-constraints work from §8 was never actually taking effect on real calls**. Moved to the correct location; this is now load-bearing and worth re-verifying live (Gate 1 in §8's verification section, specifically the "force a relay path" check) since it was previously testing a no-op.

**Settings storage** (`src/lib/settings/`): `AppSetting` table, AES-256-GCM encrypted (`crypto.ts`, `SETTINGS_ENCRYPTION_KEY`), resolved DB-row → `process.env` fallback → registry default (`service.ts`'s `getSetting()`/`requireSetting()`), declared once in `schema.ts` (17 settings across 6 sections) so the API and UI both derive from one source. In-process cache invalidated per-key on write; two modules with actual cached client objects (`mail/resend.ts`'s `Resend` instance, `firebase/admin.ts`'s Firebase `App`) register `onSettingChanged()` hooks so a credential rotation in the UI takes effect on the *next* call, not after a restart. Every messaging provider (`meta-cloud-provider.ts`, `openwa-provider.ts`, `dinstar-sms-provider.ts`) converted from synchronous `process.env` reads to `await getSetting(...)`, which touches every call site in each file (documented per-file). **Deliberately excludes telephony settings** (AMI, Coturn, `VM_PUBLIC_DOMAIN`) — those are duplicated into `pbx_configs/manager.conf` and container commands; making them safely editable needs generating those files from the DB too, out of scope here.

**`/admin/settings`** — masked secret fields (last 4 chars shown, never the value), blank-means-unchanged on save, per-section **Test connection** buttons (`POST /api/admin/settings/test`) that actually exercise each credential rather than just accepting whatever was typed: Resend sends a real email to the admin, OpenWA/Meta/Dinstar hit a status endpoint, Firebase initializes the Admin SDK from the service account and confirms it doesn't fail with "not configured." Every write audit-logged as `settings.update` with the key name, never the value.

**`/setup`** — first-run wizard, reachable only while `User.count({role: "ADMIN"}) === 0` (enforced server-side in `POST /api/setup`, not just hidden client-side), refuses if `SETTINGS_ENCRYPTION_KEY` is unset with a message naming the exact `openssl` command. Replaces requiring shell access to run `scripts/create-admin-user.mjs` on a fresh VM — that script still works as a non-interactive fallback. `src/middleware.ts`'s matcher excludes `/setup` the same way it already excluded `/login`.

**`vitest.config.mts` gained a `@/` alias** mirroring `tsconfig.json` — two new test files (`registration.test.ts`, `two-factor.test.ts`) imported modules that transitively pull in `@/lib/db`, which vitest couldn't resolve without it; this had been silently untested until this session actually ran the suite. One genuine pre-existing test bug fixed in the same pass: `ami-client.test.ts`'s "does not write anything to the socket when a field is rejected" asserted the socket's total write count was zero, ignoring the login handshake's own prior write — now asserts no *additional* write, which is what the test actually meant to check.

**What still needs live verification** (narrower than §9's list, since most of it is now resolved by design rather than by assumption):
- Every OpenWA/Meta/Dinstar API shape is still best-effort against public docs, not a live instance — unchanged from §8/§9, now exercised through `getSetting()` instead of `process.env` but not otherwise different.
- `/admin/settings/test`'s OpenWA check hits a guessed `/api/health` endpoint — verify against the actual deployed OpenWA sidecar and adjust if the real path differs.
- The hand-written `prisma/migrations/*/migration.sql` files (five now, including this session's `20260823030000_add_app_settings`) all carry the same unverified-against-live-Postgres caveat — diff before trusting as a deploy baseline.
- Firebase remains fully optional and unexercised end-to-end (no project created in this environment) — only relevant if `OTP_CHANNEL` is ever switched to `FIREBASE`.
- `npm run build`'s one warning (Node.js APIs `CompressionStream`/`DecompressionStream` used in an Edge Runtime context, from `next-auth`'s own `jose` dependency) is upstream, not introduced by this session, and did not fail the build — left unaddressed as out of scope.

---

## 11. WhatsApp/OpenWA Pairing Fix, Agent Provisioning, Dinstar Wizard, and MUI/SaaSable UI Overhaul (2026-08-23)

Live testing found WhatsApp pairing completely non-functional (stale,
undeletable pair, no QR ever rendered), Rooms static, Dinstar setup
entirely manual, admin account creation invite-only with no working
password path, and the UI visually unfinished. This session is the first
time in this repo's history the Docker image was actually built and run
end to end — every infra bug listed below was latent until that happened.
Git was initialized this session (`git init`); the repo had no version
control before.

**Root cause of the WhatsApp failure:** `src/lib/messaging/openwa-provider.ts`
called an entirely invented REST surface (`/api/instances/{id}/start|
/qrcode|/status|/logout`, header `api_key`) that the file's own header
admitted was "UNVERIFIED." No real OpenWA server has ever exposed those
paths. Confirmed by pinning the real upstream
(github.com/rmyndharis/OpenWA, MIT, commit `99874630c9d386340d71f191b310c8bd8aa52ee3`),
building it, and hitting it directly: the real API is
`/api/sessions/...` with `X-API-Key`, session status is a different enum
entirely (`created|initializing|qr_ready|authenticating|ready|
disconnected|action_required|failed`), and pairing codes
(`POST /api/sessions/{id}/pairing-code`) — a materially friendlier flow
for a non-technical operator than scanning a QR — weren't used anywhere.

**WhatsApp pairing, rebuilt:**
- `vendor/openwa/Dockerfile` deleted; new `vendor/openwa/prepare.sh` clones
  the pinned upstream commit into `vendor/openwa/upstream/` (gitignored —
  fetched at build time, not committed) and `docker-compose.yml`'s `openwa`
  service now builds **upstream's own Dockerfile** unmodified rather than
  re-deriving a from-scratch one (the old one discarded upstream's
  entrypoint script and dashboard, and had literally never been built).
  Env vars corrected to what upstream actually reads (`API_MASTER_KEY`,
  `DATABASE_TYPE/HOST/PORT/NAME/USERNAME/PASSWORD`, not the invented
  `API_KEY`/`DATABASE_URL`); added a persistent `openwa_data` volume
  (previously absent — every paired session was destroyed on container
  restart, which is the literal symptom reported: "the pair created
  cannot be deleted, cannot be refreshed"); `SSRF_ALLOWED_HOSTS=web` since
  `WEBHOOK_SSRF_PROTECT` defaults on and refuses a webhook URL pointing at
  a private bridge address. `vendor/openwa/initdb/01-create-openwa-db.sql`
  gives it its own Postgres database (upstream takes a whole
  `DATABASE_NAME`, not a `?schema=` fragment).
- New `src/lib/messaging/openwa-types.ts` (hand-transcribed from the
  pinned commit's own official SDK source, not prose docs) and
  `openwa-client.ts` (session lifecycle: create/list/get/delete/start/
  stop/logout/force-kill/getQr/requestPairingCode/registerSessionWebhook/
  statsOverview) — built on the existing `requestJson`/
  `assertSafePathSegment` helpers in `http.ts`, no new SDK dependency
  (deliberately: `MessageProvider` in `types.ts` doesn't model session
  lifecycle by design, and a second abstraction layer over an SDK whose
  version can drift from the pinned server SHA independently is not
  worth it for ~10 methods).
- `openwa-provider.ts` rewritten to delegate to the client. **Every call
  site had to change from passing `WaInstance.id` to `WaInstance.openwaSessionId`**
  — `WaInstance` gained `sessionName`, `openwaSessionId`, `providerStatusRaw`,
  `pushName`, `lastError`, `lastStatusAt`, `lastQrCode`, `lastQrAt`,
  `pairingCode`, `pairingCodeAt`, `webhookRegisteredAt`, and
  `assignedUserId` (new migration
  `20260824000000_wa_instance_openwa_session`, backfills the one
  pre-existing ghost row to `DISCONNECTED` with an explicit re-pair-needed
  error). New `InboundWebhookDelivery` table for idempotency.
- New polling route `GET /api/admin/whatsapp/instances/[id]/pairing`
  (never existed before, despite three separate old comments claiming
  "the admin page polls") and `POST .../pairing-code`. The webhook route
  (`api/messaging/openwa-webhook`) rewritten from a made-up
  `x-webhook-secret` header check to real HMAC-SHA256-over-raw-body
  verification against `X-OpenWA-Signature`, matching OpenWA's documented
  scheme, plus idempotency-key dedup.
- New `src/components/whatsapp/pairing-card.tsx` — QR/pairing-code state
  now lives per-instance (the old page kept one global `qr` variable, so
  only one card could ever show a code). Pairing code is the default UI
  (per the "non-technical operator" requirement), QR is the fallback
  toggle. Force-remove/force-kill added for a session stuck the way the
  original report described.
- **Verified against the real running stack, not just typechecked:**
  created an instance through the actual `/admin/whatsapp` UI → real
  OpenWA session created → clicked "Get pairing code" → confirmed via
  direct API call the poll endpoint returns a real 8-character code
  (`71JPMZMB`) and a real base64-PNG QR from the live sidecar
  (`sidecarReachable: true`) → deleted the instance, sidecar session
  torn down. The one thing NOT confirmed in-browser: live polling in the
  automated test browser — traced to `document.visibilityState` reporting
  `"hidden"` even for the active CDP-controlled tab (confirmed by direct
  JS evaluation), which is what the poll effect's intentional
  hidden-tab-pause guard reacts to. Not an app bug; a real browser
  doesn't have this problem.

**Agent provisioning (closes the "invite-only, no admin password path" gap):**
- `POST /api/admin/users` extended: `password` (min 12, optional — omit
  for the original email-invite flow, both paths coexist), `phoneE164`
  (admin-verified, exempts login 2FA — see below), `autoExtension`
  (lowest free number in 1001-1999) or manual `extensionNumber`, and
  `simPort` (must reference an already-paired `WaInstance`, one agent per
  port, enforced via the new `assignedUserId @unique`).
- `src/auth.ts` and `api/auth-2fa/pre-login/route.ts` both gained an
  exemption: a phone verified via `phoneVerifiedByAdminId` (admin
  override, already a weaker claim than a real OTP round-trip) skips the
  login-2FA OTP challenge. Without this, an admin-provisioned agent could
  never log in before at least one WhatsApp instance was CONNECTED to
  challenge them over — a chicken-and-egg lockout on a fresh deployment.
- New `src/lib/queue-membership.ts` (AMI `QueueAdd`/`QueueRemove`/
  `QueuePause`, TDD'd, 4/4 passing) called from user creation and the
  disable/enable toggle. `pbx_configs/queues.conf`'s hardcoded
  `member => PJSIP/1001` line removed — this was the reason a newly
  provisioned agent could never receive an inbound call, undiscovered
  until this session's audit since nothing had ever exercised it.
- New `PATCH /api/extensions/[number]` `{userId}` action (staff-only) to
  link an orphan extension (created via `POST /api/extensions` with no
  user field) after the fact — previously impossible.
- **Verified:** created a dummy agent through the real `POST /api/admin/users`
  (password + phone + `autoExtension`), confirmed it wrote a real PJSIP
  secret and regenerated `pjsip_dynamic.conf` for real (visible on disk),
  and that `pre-login` correctly reported `needs2fa: false` for the new
  account.

**Rooms:** `api/admin/rooms/route.ts` now catches the Prisma unique-name
violation and returns a real `409` (was a raw `500`); added `PATCH`
(rename + edit membership — there was previously no way to edit a room at
all, only delete-and-recreate). New `GET /api/admin/rooms/[id]/activity`
— member extension status + live AMI channel + WhatsApp identity +
recent conversation previews (redacted through the existing
`redactMessagesForSession`, not a second access-control path). Verified:
create → duplicate-name 409 → delete, through the real UI.

**`/admin/system` — new.** `GET /api/admin/system/health` runs 9 checks
in parallel (Postgres, settings-encryption round-trip, Asterisk AMI,
OpenWA `stats/overview`, WhatsApp-instances-connected count, Dinstar
gateway reachability, queue-membership drift, TURN config presence,
email config presence, OTP-channel resolvability), each carrying a hint
and a link to the fixing page. This is the concrete answer to "the app
looks not ready" — a single page enumerating exactly what isn't, and
why. Verified live: correctly red on Asterisk AMI (none running in this
dev environment), green on Postgres/OpenWA/settings-encryption.

**Dinstar setup wizard (`/admin/dinstar`) — new, closes "not identifiable
for a non-technical person":**
- New `src/lib/dinstar-discovery.ts`: `assertScannableCidr()` hard-refuses
  anything outside RFC1918 + the 100.64.0.0/10 CGNAT/Tailscale range (a
  scanner that could be pointed at the public internet by a typo is not
  acceptable — tested explicitly, 11/11 passing including the refusal
  cases), bounded-concurrency HTTP probe fingerprinting a Dinstar-shaped
  response; `probeDinstarCredentials()` tries both known UC2000 auth
  styles (Basic header vs. `?username=&password=` query string) and
  reports which one worked.
- `src/lib/messaging/dinstar-sms-provider.ts`'s `authHeaders()` split into
  `authHeaders()`/`authQueryParams()` driven by a new `DINSTAR_AUTH_STYLE`
  setting, persisted once the wizard's probe step determines it — this
  permanently resolves one of that file's two long-standing "UNVERIFIED"
  caveats.
- `192.168.1.50` was hardcoded twice in `pbx_configs/pjsip-base.conf`
  (`[dinstar-aor]` contact, `[dinstar-identify]` match) inside a
  read-only bind mount — changing the gateway's IP required SSH access to
  the host. Removed both sections; new generated
  `pbx_configs/pjsip_dinstar.conf` (read-write mount, same pattern as the
  existing `pjsip_dynamic.conf`), rendered by new `src/lib/dinstar-config.ts`
  (pure, tested, mirrors `pjsip-config.ts`'s injection-guard pattern
  exactly) and written by `dinstar-provision.ts`, which **verifies the
  AMI reload actually took effect** (`pjsip show aor dinstar-aor` shows
  the new IP) rather than assuming a `pjsip reload` picked up the
  `#include`d change — the same class of "assumed, not confirmed"
  question `pjsip-provision.ts` already flagged for the dynamic-extensions
  file, now answered defensively rather than left open a second time.
  `ALGO_PBX_MASTER_DOC.md` §6.2/§6.3's embedded config reference updated
  to match.
- New API: `POST /api/admin/dinstar/{discover,probe,apply}`. `apply` re-probes
  server-side (never trusts client-supplied auth-style state) before
  persisting settings and optionally provisioning Asterisk.
- Stays manual, stated plainly in the wizard UI: inserting the SIM/PIN,
  changing a factory-default device password, the gateway's own SIP-trunk
  configuration (a copy-paste values panel is shown), and network
  routing/Tailscale route approval.
- Also added: `SMS_POLL_SECRET` bearer-auth path on
  `POST /api/admin/messaging/sms/poll` (mirroring `api/cdr/route.ts`'s
  `timingSafeEqual` pattern) so inbound SIM SMS can be cron-polled instead
  of only ever arriving when an admin clicks a button — this was itself a
  "the system isn't ready" symptom.

**MUI v9 + Emotion + SaaSable-shaped theme, ShaderGradient landing page:**
- `src/theme/{palette,index,theme-provider,next-emotion-cache-provider}.tsx` —
  SaaSable-shaped tokens (12/16px radii, soft layered shadows, 8px rhythm)
  keeping Algo PBX's existing cyan/blue brand colors as primary/secondary
  rather than SaaSable's own palette (a design-system swap, not a
  re-brand). Light+dark, `localStorage`-backed toggle, no-flash inline
  script in `layout.tsx`.
- `src/components/admin-shell/{admin-shell,health-pill,theme-toggle-button}.tsx` —
  replaces the flat 12-`<Link>` wrap in `admin/layout.tsx` with a
  collapsible, grouped sidebar (Operations/Messaging/Configuration/Audit)
  and a topbar carrying the Phase-11 health pill (polls
  `/api/admin/system/health` every 30s, links to `/admin/system`) and
  theme toggle. `admin/layout.tsx` itself reduced to a thin server
  component handing session + a sign-out server action to the client
  shell.
- `src/app/page.tsx` rewritten on MUI (`Box`/`Button`/`Typography`) with
  a full-bleed `@shadergradient/react` WebGL background
  (`src/components/landing/gradient-background.tsx` — respects
  `prefers-reduced-motion` and falls back to a static CSS gradient when
  WebGL is unavailable).
- **`@mui/material-nextjs`'s `AppRouterCacheProvider` (`v14-appRouter`)
  is incompatible with `@mui/material@9.x`** — crashes Next's SSR
  page-data collection with `unstable_createUseMediaQuery is not a
  function`. Uninstalled it; replaced with a hand-written Emotion cache
  provider (`next-emotion-cache-provider.tsx`) using MUI's own documented
  manual App Router pattern. Do not reintroduce that package without
  re-checking this against whatever MUI version is current at the time.
- **`next/dynamic({ssr:false})` does not exclude a module from the server
  bundle when used inside a Server Component in Next 14 App Router** —
  confirmed by inspecting the actual compiled `page.js`: the entire
  three.js/postprocessing module graph was present server-side despite
  `ssr:false`, and crashed page-data collection on an unrelated
  MUI/module-evaluation-order symptom during that trace. Fixed by making
  `src/app/page.tsx` itself `"use client"` — `ssr:false` is only honored
  inside a Client Component. Anyone adding another client-only heavy
  dependency (a chart library, another WebGL thing) needs to know this.
- Not done: the remaining ~14 admin routes (CDR, Extensions, Queues,
  Reports, Sign-Ins, DNC, SMS, Settings) still render with the original
  Tailwind glass-card styling inside the new MUI shell — only the shell,
  landing, Dinstar, System, Rooms, Users, and WhatsApp pages got real UI
  work this session.

**Infra bugs found and fixed, unrelated to the actual ask, discovered
only because this was the first time `docker compose build web` was ever
actually run to completion in this repo's history:**
- **No `package-lock.json` ever existed** in `algo-pbx-frontend` — `npm ci`
  (the Dockerfile's deps-stage command) had never succeeded. Generated
  one; now committed.
- **`prisma migrate deploy` was broken in the runner stage** — the
  standalone Next.js build never copies `node_modules/.bin`, so `npx
  prisma` resolved to a bare "prisma: not found." Fixed by invoking
  `node node_modules/prisma/build/index.js migrate deploy` directly,
  bypassing bin resolution entirely.
- **Prisma 5.22's OpenSSL auto-detection is broken on Alpine 3.23**
  (`node:20-alpine`'s current base — ships OpenSSL 3.x only, with no
  `openssl1.1-compat` package available at all on this Alpine version).
  Both the schema engine (migrations) and the query engine
  (**every single database call the running app makes**) silently
  selected an `openssl-1.1.x`-linked binary that fails to load
  (`Could not parse schema engine response`, then a 503 on every route
  touching Postgres). Fixed with three explicit pins, verified
  individually via direct container exec before combining:
  `ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x` (before
  `npm ci`, controls which engine variant gets *downloaded*),
  `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` in
  `prisma/schema.prisma`'s generator block, and
  `ENV PRISMA_SCHEMA_ENGINE_BINARY=...` / `ENV PRISMA_QUERY_ENGINE_LIBRARY=...`
  pinning the exact `.so`/binary paths (controls which already-downloaded
  variant gets *invoked* — a separate runtime auto-detection that the
  first fix alone does not address).
- **Piping `docker compose build` through `tail` masks the real exit
  code** — `tail` always exits 0, so several rebuilds during this session
  were reported as "completed (exit code 0)" by the backgrounding
  mechanism while the actual `docker build` had failed underneath. Always
  redirect to a file and check separately (`> log 2>&1; echo $?`, or grep
  the log for `ERROR:`/`failed to solve`) rather than trusting a piped
  command's reported exit status.
- `src/lib/pjsip-config.ts`'s hardware-extension template set
  `context=from-internal`, which `pbx_configs/extensions.conf` never
  defined — a hardware phone could register but every outbound dial
  would silently fail with no matching dialplan context. Changed to
  `from-agent` (the same context WebRTC endpoints already use).

**Also fixed in passing (Phase 10 items from this session's own audit):**
sign-ins page's mark-seen POST raced its own first GET (fired in
parallel, so a fast POST could make the unread dot never appear — now
sequenced); DNC page's remove had no confirmation and no success
feedback; settings page's connection-test button had no `catch` (a
network failure left "Testing..." reverting with no result line ever
shown) and didn't clear a stale test result on save; the agent-facing
WhatsApp connection badge that three separate old comments claimed
existed (`GET /api/me/whatsapp`, `src/components/chat/whatsapp-connection-badge.tsx`)
did not, until this session.

**Verified:** `npx tsc --noEmit` clean; `npm run test` — 199/199 passing
(11 new: `openwa-types`, `openwa-webhook-auth`, `queue-membership`,
`dinstar-config`, `dinstar-discovery`); `npm run build` succeeds locally
(exit code confirmed explicitly, not piped through anything masking it)
— every one of the 18 page routes present in the output, landing page
statically prerendered at 4.01 kB; `docker compose build web` succeeds
(confirmed via unmasked exit code + image timestamp check); the running
container's `/api/health` returns `200 {"ok":true}` (proving the Prisma
query-engine fix works, not just the migration fix); the actual WhatsApp
pairing/Rooms/System-health flows exercised through real browser sessions
and direct authenticated HTTP calls against the live container, not
assumed from code review.

**Not verified — genuinely cannot be, in this environment:** call
functionality (outgoing/incoming/hold/transfer/supervisor intervention).
Asterisk requires `network_mode: host`, which does not function on this
Windows/Docker-Desktop machine. Every call-related code change (queue
membership wiring, the `from-internal`→`from-agent` context fix, dummy-agent
provisioning) is build/typecheck-verified but has never registered a real
SIP endpoint or carried real RTP. **This is the single highest-priority
thing to verify on the real Linux deployment VM** — create a dummy agent
through the new `/admin/users` form, place an outbound call through the
Dinstar trunk, receive an inbound call via `support_queue`, and confirm
hold/transfer/supervisor listen-whisper-barge all work, per the original
request's own acceptance checkpoint.

**`alibaba/open-code-review` was not actually run** — it requires a
global `npm install -g @alibaba-group/open-code-review` plus either an
LLM API key or its interactive delegation-mode setup, neither of which
this session performed. The Explore-subagent-based codebase audits done
instead (three separate passes: WhatsApp/OpenWA surface, Dinstar/UI
stack, admin-page functional inventory) served as this session's
substitute — a real `ocr scan` pass is still worth running once the tool
is actually installed and configured.

Ran `graphify update .` (incremental, no LLM needed for extraction) +
`graphify label .`: **1184 nodes, 2287 edges, 126 communities** (up from
426/625/43 at the end of §8's session — the count jump reflects `git
init` bringing every previously-untracked tooling/agent-config file
under Graphify's scan for the first time, not just this session's own
new source files). Same known extractor limitation as before (#2551) on
a handful of `.tsx` files with JSX syntax the parser partially chokes on
(`page.tsx` x2, `gradient-background.tsx`, `queue-manager.tsx`,
`sensitive-detect.test.ts`) — confirmed not real errors, since `tsc
--noEmit` and the actual production build both pass clean on every one
of them.

---

## 12. Production-Readiness Pass (2026-08-24) — docs, deploy hardening, branding, agent-workspace fixes

User-directed pass after a full audit (all MDs, docs/, compose, pbx_configs,
agent workspace). Terse changelog; full reasoning inline in each file's own
comments.

**Docs:** root `CLAUDE.md`/`AGENT.md` rewritten — they contained leftover
"Jetro research platform" content from another tool, actively misleading any
agent reading them; now proper Algo PBX context pointing at this file.
Master doc §3.1 diagram refreshed to the real 7-service topology + §6 marked
**historical reference only** (hardcoded-secrets compose sample, obsolete
SIPContext.tsx, pre-port-split ranges). `.env.example` SMS-poll crontab fixed
(`http://web:3000` only resolves inside the compose network; host cron needs
`127.0.0.1:3000`). `DEPLOYMENT.md` rewritten: port/firewall matrix, cert
issuance (DNS-01 via Cloudflare recommended; renewal deploy-hook restarts
asterisk+coturn+caddy — previously nothing restarted anything and all three
would serve expired certs), backups, image-pin policy. `docs/` PDFs: pdf2
corrected (Dinstar voice-side IP now via `/admin/dinstar` wizard writing
generated `pjsip_dinstar.conf`, not hand-editing `pjsip.conf`; `fromdinstar`
→ `from-dinstar`; SSL section rewritten around the shipped Caddy + one shared
cert pair); **pdf1 became reproducible for the first time** (new
`docs/pdf1-template.html`; `scripts/build-pdf2.py` replaced by
`scripts/build-docs.py` building both sources + `scripts/render-pdfs.ps1`
rendering via headless Edge). Both PDFs regenerated.

**Deploy hardening:** new `caddy` compose service (80→443 redirect, TLS from
the same `pbx_configs/keys/` pair Asterisk/coturn already use — closes the
"no TLS termination for the web UI anywhere" Tier-0 gap; `AUTH_URL=https://`
was assuming an HTTPS listener that didn't exist) + root `Caddyfile`
(auto_https off — certbot owns issuance). Coturn pinned `latest` →
`4.17-alpine` (tag verified against Docker Hub). New
`scripts/setup-firewall.sh` (ufw matrix incl. DOCKER-USER guards for
5038/5432) and `scripts/backup.sh` (pg_dump ×2 DBs + tar recordings/
voicemail/photos/openwa volume + .env copy, restore steps in header). New
`GO_LIVE_CHECKLIST.md` — Gate 0 hygiene → Gate 1 live call path → Gate 2
messaging/OTP → Gate 3 compliance sign-offs → Gate 4 ops; consolidates every
previously-scattered unverified flag.

**Branding/auth UX (user-directed):** landing background swapped from
ShaderGradient/three.js to React Bits `<Scanner />` (ogl), brand-tuned
(cyan/blue/white); removed `@shadergradient/react`, `@react-three/fiber`,
`three`, `three-stdlib`, `camera-controls` (verified used nowhere else);
reduced-motion/no-WebGL fallback preserved (`scanner-background.tsx`).
Landing copy now exactly "Algo PBX / wired for SAHARA" with a single Sign In
button (per-role entry buttons removed — they leaked structure on a public
page). Login was already one form for everyone; post-login redirect is now
role-based: `/api/auth-2fa/pre-login` returns `role`, `login-form.tsx`
routes ADMIN/SUPERVISOR→`/admin`, AGENT→`/agent` (callbackUrl still wins).
Previously every login landed on `/admin` and middleware bounced agents.

**Rooms bug (user-reported):** room selection never showed the WhatsApp chat
UI — the API layer always permitted staff everywhere
(`canAccessConversation`), so this was pure frontend wiring: conversation
rows on `/admin/rooms` now open the existing `ChatThread` in a slide-over;
unread badges shown; same pattern added to `/admin/sms`, which previously
advertised a SIM inbox that didn't exist (now lists SMS-channel conversations
+ thread drawer).

**Queue manager made real:** new staff-guarded `POST /api/queues/members`
(Zod-validated, queue-ownership-checked) over the existing AMI helpers
(add/remove/pause/unpause); `queue-manager.tsx` rebuilt with per-member
Pause/Unpause/Remove, add-member input, 5s refresh, AMI-unreachable banner.
`getQueueSnapshots()` now maps QueueMember's `Paused` flag to a `"PAUSED"`
status (type widened to `AgentStatus | "PAUSED"`).

**Agent workspace fixes (audit found 23 issues; bugs first):**
dialpad digits no longer accumulate during DTMF-in-call (and stale digits
clear on hangup; backspace + end-call added); blind transfer awaited w/
error feedback (was fire-and-forget); attended-transfer start surfaces
failure and ABORTS if the hold re-INVITE fails (was dialing the consult leg
anyway → two live sessions on one `<audio>` element); completeTransfer
propagates failure instead of optimistic-resetting on a dead transfer;
answerCall catches instead of unhandled rejection; late TURN credentials no
longer kill a live call mid-conversation (skip-rebuild guard + full state
reset when teardown does happen); ws connect/disconnect now PATCHes
server-side status too (wallboard/queue views were left stale); status
selector shows PATCH failures (silent revert); recordings/voicemail load
errors surface instead of rendering null forever, voicemail delete has a
two-click confirm (its own header asked for one), both poll for fresh data;
chat media messages render (mediaUrl was never displayed — empty bubbles),
delivery ticks added, auto-scroll + conversation-switch clear, composer send
failures caught + immediate refetch via `onSent`, unread badge clears
optimistically on select, list poll failures show a stale indicator;
WhatsApp connection badge polls every 30s instead of going permanently
stale. ESLint installed (`eslint@8.57` + `eslint-config-next@14.2.35`) —
`npm run lint` works for the first time, zero warnings.

**Deliberate scope call:** wholesale MUI conversion of the remaining ~13
Tailwind admin pages was NOT done. Those pages already implement the locked
design language (dark slate/cyan/glassmorphic cards) consistently inside the
MUI shell; converting them would risk regressions across working screens for
near-zero visual delta. The flagged *functional* inconsistencies are all
fixed instead (reports window labels say Last 24h/7d/30d matching the
rolling computation, CDR filter UI built against the long-existing API
params, voicemailPin now shown at creation on BOTH provisioning paths).
Revisit if a future pass wants pixel-level MUI uniformity.

**Verified:** `npx tsc --noEmit` clean; `npm run test` 199/199;
`npm run lint` clean (first successful run ever); full `next build`
succeeds with `/api/queues/members` present and Middleware 78.4 kB intact.
Both operator PDFs regenerate end-to-end via headless Edge. **Not verified
(unchanged class of gap):** everything Asterisk/OpenWA/Dinstar-side — see
`GO_LIVE_CHECKLIST.md`, which is now the single ordered list of what stands
between this repo and carrying a real call.

---

## 13. WhatsApp SIM-port board + Guide 2 refresh (2026-08-24, same day follow-up)

User clarified the original OpenWA question: they need FOUR numbers (one per
Dinstar GSM port), a scan-ready interface for pairing all of them easily,
and fresher PDF screenshots (the embedded ones predate the MUI shell).

- **Clarified the two layers for the user:** ONE sidecar connection config
  in `/admin/settings` (by design — one engine hosts all sessions) vs up to
  FOUR number instances on `/admin/whatsapp`. The data model already
  supported 4; what was missing was presentation + docs.
- **`/admin/whatsapp` rebuilt as a fixed 2×2 SIM PORT BOARD**
  (`src/components/whatsapp/sim-port-board.tsx`, replaces `pairing-card.tsx`
  — nothing else imported it): four slots labeled SIM Port 1–4 mirroring the
  gateway's physical ports, always all visible. Vacant slot = inline label +
  Start pairing right in place; occupied slot = compact card with status
  dot, linked number, and the scan-ready area front-and-center — big
  tap-to-copy pairing code by default (user-chosen default), QR one toggle
  away. All four codes visible simultaneously → link four phones in one
  sitting. Every prior per-instance action preserved (refresh/re-pair/
  logout/remove+force/technical details, sidecar-unreachable + lastError
  banners). Polling logic extracted into `usePairingPoll` keyed on identity
  fields only (NOT object identity — the parent refreshes instances every 5s
  and would otherwise restart the interval each time). Page header shows
  n/4 connected · ports in use. Zero API/schema changes.
- **Guide 2 §3 rewritten** around that reality: one-time sidecar connection
  in settings → the four-slot board → pair each port (code-first flow
  documented) → confirm every port in use shows Connected; layer-count table
  added; OTP-isolation tip retained; final checklist now requires "all four
  SIM ports paired... Connected". New `{whatsapp_img}` screenshot slot.
- **Screenshots:** Docker is NOT installed on this machine (no install dirs,
  no WSL, no service — the earlier session that ran docker compose was a
  different environment), so live recapture wasn't possible here. Executed
  the approved fallback: `scripts/build-docs.py` rewritten to substitute an
  honest "Screenshot pending" note when a capture file is missing (regex-
  replaces the whole img+caption block — never a broken `<img src="">`),
  full VM recapture steps documented at the top of that script; settings
  caption now states it predates the current shell. Board slot currently
  renders as pending-note until captured on the VM.
- **Verified:** typecheck clean, lint zero warnings, `next build` exit 0
  (`/admin/whatsapp` present), both PDFs regenerate via headless Edge
  (pdf2 grew to ~382 KB with the new §3).

## 14. Production-readiness re-audit + manager escalation + domain automation (2026-08-27)

Prompted by a user admin-panel walkthrough reporting Dinstar scanning
broken, voice recording "missing," no agent sign-out, and no manager-
escalation concept — plus an explicit request to connect a real domain
(GoDaddy → Cloudflare) from the admin panel. Three parallel Explore agents
plus a Plan agent traced every report to a concrete root cause before any
code was written; a re-audit pass (requested by the user specifically to
find gaps in the first plan) then surfaced a second, larger class of
day-one production risks — no log rotation, silent MOH, unbounded queues,
toll-fraud-open dialplan, no password reset, zero call/voicemail/WhatsApp
notifications anywhere in the agent UI — none of which the first pass had
caught. Full findings and the loop-by-loop plan live in this session's
plan file; this is the terse changelog. Everything below is `tsc`/`vitest`/
`eslint`/`next build` clean; **nothing has been run against live
Asterisk/Docker/a VM in this session** (none available) — treat every item
below the same as every other AMI/Docker-runtime claim already flagged
throughout this file: compiles and typechecks, not confirmed working.

**Security housekeeping:** `secrets_temp.txt` (untracked, held real fresh
secrets from the prior VM-repair session) deleted; `.gitignore` gained
`secrets*.txt`. Treat every value that file held as burned once a new
`.env` is pushed.

**AGENT-login bounce** (`handoff.md`'s standing blocker, 2026-08-26):
`src/middleware.ts` rewritten so every redirect it issues is built from
the real `x-forwarded-host`/`host` request headers via a new
`absoluteUrl()` helper, not `req.nextUrl.origin` — the same "sealed
NextURL defaults to localhost:3000" failure class already fixed in the
NextAuth route handler, now closed in middleware's own copy of the same
object too. A temporary diagnostic `console.log` is included, explicitly
flagged for removal once one real AGENT login is confirmed working on the
VM.

**Dinstar scan** (`src/lib/dinstar-discovery.ts`): `probeHost()` no longer
collapses every failure into an undifferentiated `null` — `classifyFetchError()`
distinguishes timeout/refused/no-route/unknown via `err.cause.code`;
`discoverDinstarHosts()` now returns `{hosts, scannedCount, reasonCounts}`;
per-host timeout raised to 3s (from 800ms) for CGNAT/Tailscale-range CIDRs,
since a WireGuard hop (possibly via DERP relay) is slower than LAN. New
`dinstar_route` check in `/admin/system`'s health route (credential-free
preflight probe). `/admin/dinstar` renders the reason breakdown as
actionable copy instead of a flat "no devices found." `DEPLOYMENT.md`
gained a pre-scan Tailscale-route-approval checklist.

**Voice recording:** confirmed NOT missing — `MixMonitor()`, the volume
mounts, the byte-serving route, and the CDR table's `<audio>` player are
all genuinely wired. The likely break is a silently-dead `cdr-listener`
(zero healthcheck existed on it before this session) producing exactly
the reported symptom. Fixed: the listener now touches a heartbeat file on
connect and every steady-state poll tick; `Dockerfile`'s `cdr-listener`
build stage gained a matching `HEALTHCHECK` reading it. Live diagnosis
(does ingestion actually work against a real Asterisk `Cdr` event) is
still open — needs the VM.

**Agent workspace shell** (`src/app/agent/layout.tsx` + new
`src/components/agent-shell/agent-shell.tsx`, mirroring
`admin/layout.tsx`'s server-action sign-out pattern): sign-out button and
a live SIP connection-status pill — `/agent` previously inherited zero
page chrome from anywhere. Confirmed hold/blind/attended-transfer were
already correctly implemented and wired; no changes needed there.

**Agent notifications** (previously a complete absence — a repo-wide grep
for `new Audio`/`ringtone`/`Notification(`/`document.title` returned zero
hits before this session): `sip-context.tsx` gained a looping ringtone
`<audio>` element wired to `callState === "ringing"` plus a browser
`Notification` on the same transition (both fail silently if blocked/
denied — never blocks the call). `agent-shell.tsx` requests notification
permission once on mount and sets a tab-title badge. New, fully derived
from existing data (no new call-log table): `GET/POST /api/me/missed-calls`
(`User.missedCallsSeenAt`, new migration `20260827000000_add_missed_calls_seen_at`,
same seen-marker pattern as `signInFeedSeenAt`) + `agent-missed-calls.tsx`
with one-click callback. Voicemail/WhatsApp/missed-call aggregate badges
render in the shell header, each independently polled off already-existing
endpoints (`GET /api/voicemail`'s `messages.length` IS the unread count,
since that route only ever lists `INBOX/`, not `Old/`). **Ringtone/MOH
audio files are not shipped** — same licensing-needs-a-human reasoning as
the pre-existing `moh/default/README.md`, now mirrored at
`public/sounds/README.md`; downloading an actual audio asset from the web
needs the user's explicit go-ahead per this session's action-permission
rules, not something an agent silently fetches.

**Manager escalation** (Loop C1 — new): admin-managed named list
(`EscalationTarget`: name + extension/phoneE164 + active) an agent picks
from a dropdown (`escalation-picker.tsx`, rendered in `call-controls.tsx`)
to feed the EXISTING `blindTransfer()` — no new call-control primitive.
Outcome detection is a parallel AMI observation (`AmiClient.waitForEvent()`,
new — same listener pattern as `sendAndCollect()` minus the ActionID
coupling, resolves `null` on timeout since "no answer" is itself a valid
result) watching for the target extension's `DialEnd`/`DialStatus`
(`src/lib/escalation.ts`'s `classifyDialEnd()`, 5/5 tests, same
"probable not proven against live Asterisk" confidence tier as every
other AMI field mapping in this repo). On busy/no-answer/failed: a
WhatsApp ping via the existing OpenWA registry (fails soft — never blocks
logging the attempt) plus a persistent `EscalationAttempt` row, visible at
new `/admin/escalations` (target CRUD + attempt log). New migration
`20260827000100_add_escalation`.

**Domain connect automation** (Loop C4 — new, the highest-blast-radius
item in this pass, land/test this one first on a non-production VM):
`caddy` now builds from new `Dockerfile.caddy` (`xcaddy` + the
`caddy-dns/cloudflare` plugin) instead of pulling `caddy:2-alpine`
directly, and issues its own Let's Encrypt cert via DNS-01 — `Caddyfile`
dropped `auto_https off` and the static `tls /certs/...` block for
`tls { dns cloudflare {env.CLOUDFLARE_API_TOKEN} }`. Caddy's own ACME
storage isn't the flat `fullchain.pem`/`privkey.pem` path Asterisk WSS/
Coturn TLS read, so a new `cert-sync` service bridges the two: polls
Caddy's issued cert, copies it into `pbx_configs/keys/` on change,
restarts `asterisk`+`coturn`. **`cert-sync` is the only container in this
entire stack granted the Docker socket** — a deliberate, explicitly-
flagged tradeoff for "no manual restart step," not a free win (it can
control any container on the host). It also recreates `caddy` (via
`docker compose up -d --no-deps caddy` against the HOST's real project
path, self-discovered through `docker inspect` on its own container —
NOT the read-only `/workspace` bind-mount inside itself, which the Docker
daemon on the host can't resolve — see `scripts/cert-sync.sh`'s header
comment for the full explanation of this Docker-socket subtlety) when
`/admin/settings`' new "Domain & TLS" section (`VM_PUBLIC_DOMAIN` +
`CLOUDFLARE_API_TOKEN`, added to `SETTINGS_REGISTRY` — the one telephony
setting deliberately let back into `AppSetting` since the "generate the
dependent config too" work this needed now exists, closing the gap
`prisma/schema.prisma`'s comment flagged) writes a new
`pbx_configs/generated/caddy.env` via `POST /api/admin/settings/domain/apply`.
New `scripts/render-caddy-env.sh` seeds that file from `.env`'s existing
`VM_PUBLIC_DOMAIN` once, before first bring-up, so a fresh deploy still
boots with zero admin-panel action required (`web`'s port 3000 stays
independently reachable throughout, exactly as `/setup` already assumes).
`domain_tls`'s "Test connection" validates the Cloudflare token via its
verify endpoint + a zone lookup confirming it actually covers the
configured domain. `DEPLOYMENT.md`'s TLS section rewritten around this
flow; manual certbot kept fully documented as fallback, explicitly not
deleted, until one full automated renewal cycle is observed live.

**Per-agent dial permissions / toll-fraud guard** (Loop C2 — new): the
outbound dialplan was a bare `_X.` — any number, no restriction, reachable
by any compromised agent session (SIP secret lives in browser memory).
New `Extension.dialPermission` (`LOCAL|NATIONAL|INTERNATIONAL`, default
`LOCAL`, migration `20260827000200_add_dial_permission`) selects which of
three chained `extensions.conf` contexts (`from-agent-local` →
`-national` → `-international`, `include =>`-cascaded so a wider tier is
a strict superset) a generated PJSIP endpoint's `context=` points at
(`pjsip-config.ts`'s `renderPjsipConf()`, 3 new tests). A hard-blocked
satellite/premium-rate prefix list AND an exact-match emergency-number
block (999/998/997 UAE, 112/911, 100/101/102/108 India — CLAUDE.md's own
India-agents/UAE-trunk mismatch means this PBX cannot correctly route a
real emergency call at all, so misdials are blocked rather than silently
reaching the wrong country's responders) are declared once in the base
tier using MORE SPECIFIC patterns than any allow-rule, so Asterisk's
best-match resolution makes them unbypassable regardless of which tier
an extension has — not merely "checked first." **Confidence: MEDIUM** on
the exact UAE/India prefix patterns (real conventions, not independently
re-verified against a live trunk) — same honesty tier as `func_odbc.conf`'s
already-flagged DNC normalization gap, and inherits that exact
limitation (EXTEN is whatever was dialed as-is, not E.164-normalized).
Also fixed in the same pass: `CALLERID(num)=AlgoCallCenter)` was setting
a non-numeric string into the NUMERIC caller-id field (malformed SIP
`From` toward the GSM trunk) — moved to `CALLERID(name)`, since the
Dinstar gateway presents the inserted SIM's own real number regardless of
what Asterisk sets; and the outbound `Dial()`'s trailing `T` flag (grants
the EXTERNAL party transfer rights on the channel) was dropped. Admin UI:
`/admin/extensions` gained a dial-permission dropdown on create and a
live-editable one per existing row (`PATCH /api/extensions/[number]`,
staff-only, regenerates+reloads PJSIP). `POST /api/crm/click-to-call` and
`cdr-mapper.ts`'s `inferDirection()` both updated for the context rename
(the latter via `startsWith("from-agent")`, deliberately covering both the
tier-context and the new `from-agent-common` shared-handler names since
which one Asterisk's `Cdr` event actually reports post-`Goto()` is itself
unverified against a live capture).

**Account lifecycle** (Loop C3 — new): before this, there was NO password
reset path of any kind — an agent who forgot their password was
permanently locked out. Both paths landed: self-service
(`/forgot-password` → `POST /api/auth/forgot-password` →
`POST /api/auth/reset-password`, reusing the existing `OtpChallenge`
machinery via a new `PASSWORD_RESET` `OtpPurpose`, both routes
enumeration-safe — same generic-response discipline `src/auth.ts`'s
`authorize()` already applies, with a documented, accepted timing-oracle
gap rather than either ignoring it or over-engineering a fix) and
admin-triggered (`/admin/users`' new "Send reset" button →
`PATCH /api/admin/users/[id] {sendReset:true}`, reusing the EXISTING
`Invite`/`tokenHash` mechanism and its consumption page — a password
reset link IS "set your password once via a single-use link," the same
operation onboarding already performs, just triggered later; `db.invite.upsert`
since `Invite.userId` is `@unique`). New `User.passwordChangedAt`
(migration `20260827000300_add_password_reset`, also adds the
`PASSWORD_RESET` enum value) is checked in `auth.ts`'s `jwt` callback
against the JWT's own `iat` — a reset now kills every OTHER outstanding
session on its very next request by reusing the exact same `disabled`
enforcement path every guard already checks, not a second parallel
mechanism. Also closed: `sipSecret` rotation (`PATCH /api/extensions/[number]
{rotateSecret:true}`, staff-only, one-time disclosure like creation) and
real extension hard-delete (`DELETE /api/extensions/[number]`,
ADMIN-only like the recording hard-delete precedent, best-effort queue-membership
cleanup + PJSIP reload) — previously an admin had no in-product way to
actually revoke a departed agent's access beyond `User.disabled`. New
`/admin/audit` + `GET /api/admin/audit` (staff-only, filter by
action/actor) — `AuditLog` rows have been written since Phase D but
nothing ever surfaced them; exactly the gap `LLM.md` §7 flagged.

**Disk safety + queue capacity** (Loop D1/D2 — new): `pbx_configs/logger.conf`
added (was entirely absent) — deliberately does NOT define a verbose file
target, since adding one without logrotate (which doesn't exist inside
this still-not-really-containerized Asterisk, see Phase A) would just
recreate the exact unbounded-growth problem this loop exists to close;
Docker's own already-rotated stdout capture is the durable log instead.
Only a low-volume `security` events file target is defined. New
`RECORDING_RETENTION_DAYS` setting (default 90, `0` disables) +
`POST /api/admin/maintenance/prune` (same cron-or-admin-session bearer
pattern as the SMS poller, new `PRUNE_SECRET`) prunes both expired
`Recording` rows+files and voicemail `.txt`/`.wav` pairs across every
mailbox — previously neither had ANY pruning, an unbounded-disk-growth
risk and a PDPL data-minimization gap. Decision logic extracted as
`src/lib/retention.ts`'s `isExpired()`, TDD'd (4/4 tests). **Real bug
caught before it shipped, not after:** the prune route's cron path
initially tried to write `AuditLog.actorId: "cron"` — that column is a
real, enforced Postgres foreign key to `User`, not a free-text field, so
that would have thrown on every single automated run. Fixed by
attributing cron-triggered audit rows to the earliest-created ADMIN
account instead (no schema change, no fake "system user" invented).
`/admin/system` health gained a `disk_space` check (`fs.promises.statfs`,
warns under 25% free, fails under 10%) — previously zero visibility into
whether the disk backing recordings/voicemail (and, since everything
shares one volume, Postgres) was close to full. `queues.conf`: `joinempty`
flipped `yes→no` and `leaveempty` `no→yes` (both were explicitly flagged
in-file at the time as "DEVELOPMENT-FRIENDLY — REVISIT FOR PRODUCTION"),
`maxlen` `0→4` (matching the Dinstar gateway's real hard concurrency
ceiling — four GSM ports, no matter how anything else is sized). New
static mailbox `9000` in `voicemail.conf` ("Office Overflow", numeric so
it stays compatible with `GET /api/voicemail`'s existing
`SAFE_MAILBOX` validation) is where `extensions.conf`'s `[from-dinstar]`
now routes a caller on ANY non-answered `Queue()` outcome
(`${QUEUESTATUS}` empty = answered and completed normally; anything else
= full/empty/kicked) — previously every one of those outcomes was a bare
`Hangup()`, silence then a drop, with no voicemail, no announcement,
nothing.

**Business-hours routing — asked, deliberately deferred, not an
oversight:** offered to implement `GotoIfTime` against either a proposed
Mon–Sat 9am–9pm GST schedule or custom hours; the user chose to skip for
now rather than have real hours guessed at — getting this wrong risks
silently rejecting real revenue calls. `[from-dinstar]` stays open 24/7
until real hours are specified.

**Also done, smaller items:** Docker `logging:` (json-file, 10m/3-file cap)
applied to all 8 services via a shared `x-logging` YAML anchor — previously
none of them had any rotation at all; healthchecks added to `coturn`
(`pidof turnserver` — no HTTP endpoint to probe) and `caddy` (`wget`
--spider against the plain-HTTP vhost) — previously neither existed.

**Not done in this pass** (hold-music AND ringtone audio files — both
blocked on the user's explicit go-ahead to fetch a specific CC0 source,
not a technical gap; business-hours routing — asked, deferred, see above;
the DNC-blocked/permission-blocked dialplan prompts are still placeholder
names, same audio-asset blocker; containerizing Asterisk for real; VM
networking/capacity; backup cron scheduling and a restore drill —
`scripts/backup.sh` already exists per an earlier session but has never
actually been scheduled or run; image digest-pinning) — all need either
a live VM (none available in this session) or a user decision already
flagged; pick up in this session's plan file next.

- 2026-08-25 — Rewrote Guide 1 (`docs/pdf1-template.html` / `1-Deploying-Algo-PBX-on-a-Linux-VM.pdf`) into a full VirtualBox-aware, non-technical install guide, prompted by a screenshot of the actual deployment environment: Oracle VirtualBox on Windows, an existing `ubuntuserver` VM already NAT-forwarding host ports 8000/80/443 (Coolify), and a second powered-off `algo_pbx` VM — the real target. New Chapter 2 is a first-class ports chapter (what a port is, the full matrix with a "what breaks if blocked" column, checking Windows-host vs Ubuntu-guest occupancy including `VBoxManage showvminfo ... | findstr Forwarding` for other-VM NAT rules, choosing a free port, what's movable vs not, symptom→cause→fix table); new Chapter 3 has the user create `algo_pbx` with **Bridged Adapter** (not NAT) with an explicit "why not NAT" box (20,000-port-wide RTP+relay ranges can't be per-rule forwarded, and it can't collide with `ubuntuserver`'s claimed ports); Chapters 4–12 restructured around that (static LAN IP reservation, Docker install, router port-forwarding as its own chapter, a post-`up -d` `ss -tulpn` verification step); new Appendix A is a port-check cheat sheet. Guide 2 (`docs/pdf2-template.html`) gained "Appendix B — Ports on the telephony side" (5060/udp Tailscale-only path, `ss -ulpn`/`pjsip show endpoints` verification, "silence = RTP range not signaling" diagnosis, never-expose list) and its checklist's old unlabeled Appendix was renamed "Appendix A" to make room. `DEPLOYMENT.md` §1 gained matching §1.1 "Running on VirtualBox" and §1.2 "Port conflicts" so the repo (source of truth per `CLAUDE.md`) doesn't fall out of sync with the PDFs. These two user decisions were confirmed via AskUserQuestion before writing: Bridged Adapter as the recommended/documented default (not NAT-with-forwarding), and that the VirtualBox VM is the real production deployment, not a rehearsal.
  - **Verified:** `python scripts/build-docs.py` — both HTML sources rewritten, zero `WARNING: no <img> block found` (proves the `{setup_img}`/`{settings_img}`/`{whatsapp_img}` placeholder blocks survived the rewrite intact); grepped the rendered `docs/pdf{1,2}-source.html` for leftover `{placeholder}` text — none found; confirmed the doubled-brace CSS/Docker-format-string escaping (`{{`/`}}` → literal `{`/`}` after `str.format()`) rendered correctly, e.g. `docker ps --format '{{.Names}} {{.Ports}}'`. `powershell -File scripts/render-pdfs.ps1` regenerated both PDFs via headless Edge (pdf1 261,655 bytes, pdf2 393,179 bytes). Docs-only change — no frontend code touched, so `npm run typecheck`/`test`/`build` were not re-run.
  - **Not verified:** the PDFs were not visually paged through by a human in this session (no PDF viewer used) — only structural/text checks (grep, byte counts, build-docs.py's own warning system) confirm correctness; a human pass to check page-break placement and table wrapping is still worthwhile before relying on this for a live install.

## 15. Live-VM verification: full redeploy, real bugs found and fixed, Dinstar/domain diagnosis (2026-08-27, same-day follow-up to §14)

Direct continuation of §14 — the user granted live SSH access and asked for a
full redeploy of everything built that day. This section is the first time
this repo's `docker-compose.yml` has ever been brought up in full on real
infrastructure; several real bugs surfaced that no amount of `tsc`/`vitest`
could have caught, matching this file's own repeated caveat about
AMI/Docker-runtime claims being unconfirmed until run live.

**Loop A1 (containerized Asterisk) — done, real config confirmed live:**
new `Dockerfile.asterisk` builds Asterisk 20 from source
(`ubuntu:24.04`, module set fixed via `pbx_configs/asterisk-menuselect.makeopts`)
instead of the nonexistent `tiredofit/asterisk:20-latest` this repo's
compose file referenced since Phase 1. Three build-time/runtime bugs found
and fixed, in order: missing `pkg-config`/`app_osplookup`/`chan_alsa`
build deps (minimal Ubuntu base vs. the full-ISO native install this was
ported from); Asterisk's own shared libs (`libasteriskssl.so*` etc.) land
in plain `/usr/lib`, not `/usr/lib/asterisk` — only the latter was being
copied into the runtime image, so the binary failed to start with a
missing-`.so` error; and a silent `exit 1` with zero log output, root-caused
by testing with no config mounted at all (bypassing compose), which
revealed `modules.conf` was missing entirely — this repo never had one
because every prior deploy relied on `make samples` to generate it
implicitly, and `Dockerfile.asterisk` deliberately skips that step. New
`pbx_configs/modules.conf` (`autoload=yes`) fixes it. `pjsip show endpoints`
now lists this repo's real generated extensions (`2001`, `dinstar-trunk`),
not sample defaults — closes the "split-brain" state `handoff.md` flagged.
`odbc show` confirms 1 active connection — the Phase C "ODBC support
unverified" question is now answered: it works, `unixodbc-dev` was simply
never installed before `./configure` ran on every prior native attempt.

**`cdr-listener` unhealthy → root-caused, two real bugs, not one:**
1. `docker compose up -d --force-recreate` was needed first — a plain
   `docker restart` does NOT refresh `host.docker.internal`'s `/etc/hosts`
   entry, which was stale (`172.17.0.1`, an old bridge gateway) vs. the
   container's actual current one (`172.18.0.1`).
2. After recreation, the connection still hung with no error — traced to
   `ufw`'s `default deny incoming` policy silently dropping AMI (5038/tcp)
   connections from the Docker bridge subnet. `scripts/setup-firewall.sh`
   correctly keeps 5038 off the *public* allow list (matches the hard
   constraint that AMI must never be internet-facing) but never had a
   rule permitting the *internal* Docker-bridge → host path `cdr-listener`
   (and `web`'s own AMI calls) actually need — a real, previously-untested
   gap, since Asterisk had never run live before this session. Fixed with
   a new, narrowly-scoped `ufw allow from 172.16.0.0/12 to any port 5038
   proto tcp` rule (matches `manager.conf`'s own `permit` ACL range
   exactly — a second, independent layer around the same already-narrow
   trust boundary, not a wider one), added to `setup-firewall.sh` and
   applied live.
3. Even with both fixed, `cdr-listener` (and `algopbx-app`) kept failing
   AMI login with `InvalidPassword` — `pbx_configs/manager.conf` still had
   its literal `REPLACE_ME_*` placeholders: the day's full-repo redeploy
   had overwritten an earlier session's live-templated copy with this
   repo's committed placeholder template (correct that the repo itself
   never carries real secrets — the gap is that the deploy process has no
   re-templating step of its own yet). Re-templated from `.env` via `sed`
   on the VM (values never printed). **Then a fourth, genuinely surprising
   bug:** `asterisk -rx 'manager reload'` reported success and
   `manager show users` listed both accounts correctly, but AMI logins
   kept failing with the *old* (pre-fix) credentials regardless — this
   build's `manager reload` does not actually re-read secrets, only the
   user list. Only a full `docker compose restart asterisk` (fresh process
   load) actually applied the corrected `manager.conf`. `cdr-listener` is
   now genuinely healthy and connected.

**Music on hold — silent, not missing (Loop D1):** the CC0 track the user
provided (converted to 8kHz mono WAV, `moh/default/music-box.wav`) was
correctly mounted and `musiconhold.conf`'s `[default]` stanza was
syntactically valid, but `moh show classes` came back **empty** — no
parse error, no warning, across `module reload`/`module unload`+`load`/
`core reload`, all silently no-ops for this. Isolated by testing a
differently-named class (ruled out a `[default]`-name conflict) and an
absolute vs. relative `directory=` value (the actual cause): this
from-source Asterisk 20 build (`git --branch 20 --depth 1`, i.e. the live
tip of the branch, not a fixed release tag) does not resolve a relative
`directory=` value against `$ASTDATADIR/moh/` the way upstream docs
describe — only an absolute path (`/var/lib/asterisk/moh/default`)
actually registers the class. Same "reload doesn't actually reload"
pattern as the manager.conf bug above; a full container restart was
required either way. Fixed permanently in `pbx_configs/musiconhold.conf`.
**Not yet fixed:** `moh show files` also lists the directory's
`README.md` as a playable file (Asterisk enumerates every file in
`directory=`, not just recognized audio ones) — harmless today since
`.wav` sorts before `README`, but worth moving `README.md` out of
`moh/default/` (a sibling `moh/README.md`, one level up) before adding a
second track.

**Dinstar scan/connection — diagnosed, one half fixed, one half needs the
UAE office:** the Tailscale binary was **not installed at all** on the
cloud VM — `scripts/setup-tailscale-cloud.sh` has always assumed it's
present. Installed via the official apt repo (`pkgs.tailscale.com`,
GPG-keyring method — the curl-pipe-to-sudo one-liner Tailscale's own docs
lead with was correctly blocked by this session's own safety tooling as
an unreviewable download-and-execute pattern) and `tailscaled` enabled.
`tailscale up --accept-routes` is running in the background on the VM
with a pending device-auth link — **this needs the user to open it in a
browser while logged into the office Tailscale account and approve it**;
Claude cannot complete an account-linking OAuth-style flow on the user's
behalf. Separately, and out of reach entirely from this session: the UAE
office side (`scripts/setup-tailscale-uae-office.sh`, run on a PC on the
Dinstar's LAN, then the advertised route approved in the Tailscale admin
console) has never been run — no access to that machine exists from here.
**Both halves must complete before Dinstar scanning/calls can work at
all**, regardless of anything else in this repo.

**Domain connect — build path verified, cannot go further without user
input:** `algo-caddy` is already running from the new `Dockerfile.caddy`
(`xcaddy` + `caddy-dns/cloudflare`) — `caddy list-modules` confirms
`dns.providers.cloudflare` is loaded, `caddy version` reports `v2.11.4`.
This was Loop C4's single biggest identified risk ("untested, first build
must happen on the VM") and it is now resolved: the automation code is
real and working. It cannot be switched on further, though:
`VM_PUBLIC_DOMAIN` is still the literal placeholder `127.0.0.1` and
`CLOUDFLARE_API_TOKEN` is empty in the VM's `.env` — needs the user's
actual GoDaddy-purchased domain name (pointed at Cloudflare nameservers)
and a Cloudflare API token scoped to DNS edit on that zone before
`/admin/settings`'s "Domain & TLS" section can be applied for real.

**VM networking — still the blocker for real audio, including any test
from India:** `ip -4 addr show`/`ip route` on the VM confirm it is still
on VirtualBox **NAT** (`10.0.2.15`, gateway `10.0.2.2` — VirtualBox's
default NAT range), not the Bridged Adapter the earlier plan (Loop A2)
called for. `VBoxManage showvminfo algo_pbx --machinereadable` (run from
the Windows host, which this session also has shell access to) confirms
`nic1="nat"`. This matters more than it might look: `handoff.md` already
diagnosed that NAT cannot forward Asterisk's 10000–20000 RTP range or
Coturn's 20001–30000 relay range, so **even once the domain/TLS work
lands, a real inbound test call — from India or anywhere outside the
VM's own LAN — will connect but carry no audio.** Deliberately NOT
attempted this session: `handoff.md` also records that Bridged Adapter
was tried once before and failed with an unresolved connection timeout,
and switching a running VM's NIC type is a hard-to-reverse action that
risks cutting off the only SSH path back into it — exactly the class of
action this session's own safety rules require flagging and confirming
rather than just doing. **This is the top blocker to resolve next**,
ahead of the domain work, since domain automation alone cannot fix it.

**Backups — verified for real, not just present:** `scripts/backup.sh`
(existed, never run) was executed once manually — captured both Postgres
databases, recordings/voicemail/agent-photos, the OpenWA session volume,
and `.env`. Ran a full restore drill: restored `algopbx_db.sql.gz` into a
disposable scratch `postgres:16-alpine` container (not the live DB),
confirmed every table recreated correctly and real data landed (2 `User`
rows), then tore the scratch container down. This is the first time this
repo's backup path has been proven to actually work end to end, not just
exist. **Update from §16: cron scheduling was done in the follow-up
session** — see below; this line is left for the historical record of
what §15 itself shipped.

**Also confirmed still-open, unchanged from §14:** business-hours routing
(deferred by user choice), DNC-blocked/permission-blocked dialplan
prompts (still placeholder names, blocked on a real recorded announcement),
image digest-pinning (low priority — the 3 pulled images left,
`postgres:16-alpine`/`coturn/coturn:4.17-alpine`/`docker:27-cli`, are
already tag-pinned, not `:latest`).

## 16. Dinstar SIM live, real domain issuing real certs, deploy pipeline itself was broken (2026-08-27, second same-day follow-up to §15)

Cron scheduling (backup + 14-day cleanup, prune, SMS-poll) landed exactly
as designed in §15. Bridged networking got fixed too, but not the way
originally planned: `handoff.md`'s Loop 1.3 called for a bridged adapter
on a wired NIC, on the theory that Wi-Fi bridging was the failure mode.
The wired NIC was already in use — attached directly to the Dinstar
gateway's own management interface (192.168.11.0/24), not a general LAN.
Bridging onto it worked once **`Protocol ARP Offload` was disabled** on
that adapter (a known VirtualBox/NIC-firmware conflict: the NIC
intercepts ARP below the bridge driver) — Windows→VM traffic worked
immediately after, but VM→outbound stayed broken until the VM was fully
power-cycled (not just the NIC link bounced), confirming the bridge
doesn't cleanly rebind to a reset physical adapter without a full VM
restart. `192.168.1.50`/`192.168.1.0/24` were hardcoded as Dinstar
defaults throughout the repo (the `/admin/dinstar` scan CIDR, the
`pjsip_dynamic.conf`-style dinstar seed, `.env.example`) — genuinely
wrong for this office's real wiring (`192.168.11.1`), independent of the
separately-diagnosed Tailscale gap; fixed in
`src/app/admin/dinstar/page.tsx`, `pbx_configs/pjsip_dinstar.conf`, and
`.env.example`.

**Dinstar trunk + SIM, done and verified against the real device UI:**
the SIP Trunk entry pointed at `192.168.11.10:5080` (this Windows PC, the
wrong port) — a stale leftover, fixed to `192.168.11.20:5060`. Setting it
to `5060` silently failed to persist every time with zero error, isolated
via extensive bisection (arbitrary ports saved fine; only `5060`
specifically reverted) to the Dinstar refusing a trunk peer port equal to
its **own** local SIP port, which also defaults to `5060` — fixed by
moving the device's own local port to `5061` under
`Call Configuration → SIP Configuration`, which both requires and
triggers a device restart. That restart incidentally also fixed a
separate problem: the inserted SIM showed "No SIM Card" on every check
until then, consistent with this GSM hardware only reading SIM presence
at module power-on, not on hot-insertion. Port 0 now shows
`Mobile Registered` with a real UAE IMSI (`4240...`) and strong signal.
Both `IP->Tel Routing` (`SIP Server → Port Group-0`) and `Tel->IP Routing`
(`Port Group-0 → Trunk-0`) were already correctly pre-configured from an
earlier session. One real inbound test call (external phone → the SIM)
rang through to the point of prompting for an extension — the GSM→Asterisk
leg works. The reverse direction (agent extension → `+971544887712`
through the trunk) was set up (extensions provisioned) but never actually
placed before the session ended — see §16.9 "Immediate next steps".

**Domain (`saharatechs.com`) connected for real** — a genuine Let's
Encrypt certificate confirmed issued via Cloudflare DNS-01
(`"certificate obtained successfully"` in Caddy's own log). Getting there
surfaced four distinct, real bugs in the deploy/automation mechanism
itself, all now understood and three of four fixed in code:

1. **The `web` container's runtime UID doesn't match the on-disk owner of
   any generated config file.** Every file `src/lib/pjsip-config.ts`,
   `src/lib/dinstar-config.ts`, or the domain-apply route regenerates
   (`pjsip_dynamic.conf`, `pjsip_dinstar.conf`, `voicemail_dynamic.conf`,
   `pbx_configs/generated/{Caddyfile,caddy.env}`) is created on the host
   owned by the SSH deploy user at mode `644`; the `web` container
   actually runs as a *different* uid (`nextjs`, 1001). Every single
   admin-panel action that regenerates one of these files — provisioning
   an extension or user, connecting the Dinstar trunk, connecting the
   domain — failed with `EACCES: permission denied`. This had never
   surfaced before because nothing had ever been provisioned through the
   live app until this session. **Worked around**, not fixed: `chmod
   666`/`777` on the affected files/directory. **Still needs a real
   fix** — matching UIDs, or a deploy-time `chown` step — since a future
   full repo re-sync resets these permissions back to `644` (confirmed:
   it happened mid-session when the repo was re-synced to pick up other
   fixes, and had to be re-applied).
2. `cert-sync` (the sole container with Docker-socket access, tasked
   with recreating `caddy` on domain-setting changes) discovers its own
   host project directory correctly via `docker inspect $HOSTNAME`, but
   was then handing that host-only path straight to `docker compose -f`
   — which reads the compose file's bytes **locally**, from cert-sync's
   own container filesystem, before ever talking to the daemon over the
   socket. Always failed with `open .../docker-compose.yml: no such file
   or directory`. **Fixed** in `scripts/cert-sync.sh`: symlink the
   discovered host path to `/workspace` (the read-only bind-mount of the
   same repo root cert-sync already has) inside its own writable
   filesystem, satisfying every path Compose might need under
   `--project-directory` — including `.env`, which `docker compose up`
   (unlike `config`) independently re-resolves against that same path for
   its own bookkeeping, a second instance of the identical bug that
   needed the same fix.
3. Even with that fixed, `docker compose up -d --no-deps caddy` silently
   no-op'd — Compose's own idempotency model correctly saw that the
   **service definition** hadn't changed (only a bind-mounted file's
   *content* had) and left the existing Caddy process running against its
   stale, already-open read of the old config, indefinitely, across
   several marker-triggered "recreate" cycles that all reported success.
   **Fixed** by adding `--force-recreate` to the `docker compose up`
   invocation in `recreate_service()`.
4. `cert-sync`'s own `VM_PUBLIC_DOMAIN` (baked in from `.env` at
   container-create time, per its `environment:` block in
   `docker-compose.yml`) still held the placeholder `127.0.0.1` — the
   *real* domain, entered through `/admin/settings`, only ever gets
   written to `AppSetting` in Postgres and to Caddy's own generated
   `caddy.env`, never back to the static `.env` file `cert-sync` reads.
   **Fixed operationally** by updating `.env` directly and recreating
   `cert-sync` — **not fixed in code**, and flagged as a real design gap:
   there are now two independent sources of truth for the public domain
   (`AppSetting` vs. `.env`), and nothing keeps them in sync going
   forward. A durable fix would have `cert-sync` read the domain from
   `caddy.env` (which the apply route already writes correctly) instead
   of its own separately-sourced env var.

Not yet confirmed at session end: whether `cert-sync`'s `sync_cert()`
function has actually copied the newly-issued cert into
`pbx_configs/keys/fullchain.pem`/`privkey.pem` and restarted
Asterisk/Coturn to pick it up (the WSS-signaling half of TLS, distinct
from the DTLS media cert below) — the check was in progress when the
session ended.

**The expensive lesson this session:** the overwhelming majority of "why
doesn't this take effect" mysteries chased tonight — for newly-provisioned
extensions, for the domain-apply route's own `Caddyfile` write, for
Dinstar credentials — eventually traced back to **the deployed `web`
image being stale relative to the actual repo source**, not to any bug in
the source. `docker compose restart web`, used constantly all session,
restarts the *existing* image; it does not rebuild. Confirmed concretely:
`/admin/domain` (built earlier this same day) didn't exist on the VM at
all, and the domain-apply route's own success message text differed
between the stale and freshly-rebuilt versions. A large amount of
debugging time went into filesystem-level theories (bind-mount staleness,
UTF-8 in comments, field-by-field PJSIP bisection) that were actually
explained entirely by testing against old compiled code. **Going forward,
deploy any code change to this VM with `docker compose up -d --build
<service>`, never a plain `restart`.**

**A second, independent unreliability pattern, confirmed repeatedly and
distinct from the stale-image issue above:** this specific Asterisk
build's `module reload <x>.so` and `manager reload` CLI commands report
success — and can even show *partially* correct state on inspection —
without actually applying the change. Confirmed for `manager.conf` AMI
secrets (login kept failing with old credentials after a "successful"
`manager reload`), `musiconhold.conf` classes (`moh show classes` stayed
empty through `module reload`/`unload+load`/`core reload`, for content
later proven entirely valid), and PJSIP endpoint definitions (a
freshly-appended test endpoint appeared to load via `module reload
res_pjsip.so`, but a genuine full restart proved that misleading — the
same file's `[2001]`/`[2002]` endpoints, byte-identical in every test,
never actually loaded until the real blocker — missing DTLS certs, next
paragraph — was found). **Treat any `reload`-style command's own
"success" report in this build as unproven until independently confirmed
with a full `docker compose restart`.**

**A real, separate bug found mid-investigation of the above:**
`/etc/asterisk/keys/` (bind-mounted from `pbx_configs/keys/`) had never
been populated at all — only its own README existed. Every WebRTC PJSIP
endpoint `src/lib/pjsip-config.ts` generates references
`dtls_cert_file`/`dtls_private_key_file` paths there, which is enough to
block that endpoint from loading (silently, no logged error, consistent
with the reload-unreliability pattern above). Fixed per that directory's
own README: `openssl req -x509 -newkey rsa:2048 -nodes -days 3650
-keyout pbx_configs/keys/asterisk.key -out pbx_configs/keys/asterisk.crt
-subj '/CN=algopbx.local'` — deliberately self-signed, which the README
confirms is correct here since `dtls_verify=fingerprint` validates the
SDP fingerprint exchanged in signaling, not the certificate's chain of
trust. **Not yet independently re-confirmed** whether this alone explains
extensions 2001/2002 failing to load, separate from the stale-image issue
— both were being untangled at once when the domain-debugging thread took
over; needs a clean re-test now that both are fixed.

**Housekeeping done along the way:** a full `git ls-files` +
untracked-non-ignored resync of the whole repo to the VM (to pick up this
same-day's Phase 4 domain-wizard code, which had never been synced) had
a real side effect worth remembering — it reset `manager.conf`'s and
`odbc.ini`'s live-templated secrets/credentials back to their committed
`REPLACE_ME_*` placeholders, since those files are legitimately tracked
with placeholder content (real secrets are never committed) and the sync
doesn't know to preserve a prior live templating pass. Re-templated both
from `.env` immediately after. **Any future full resync of this repo to
this VM must re-run that templating step afterward** — it is not
automatic.

**Passwords set for testing, must be rotated before real use:**
`admin@algopbx.local` / `agent@algopbx.local` → `TestPass123!`;
`agent2@algopbx.local` → `TestPass123!Agent`. Set directly via DB since
original credentials weren't available and the self-service/admin reset
flows (built in §14) need a working email/WhatsApp path this session
didn't have set up for a throwaway test account.

**Immediate next steps, in priority order:**
1. Confirm `cert-sync` copied the real cert into `pbx_configs/keys/` and
   restarted Asterisk/Coturn (`docker logs algo-cert-sync` for a "new
   certificate detected" line; check `fullchain.pem`/`privkey.pem`
   timestamps).
2. Re-verify extensions `2001`/`2002` load
   (`docker compose restart asterisk` then `pjsip show endpoints`) now
   that DTLS certs exist and the image is fresh.
3. Place the one test this session never got to: an agent WebRTC
   softphone dialing `+971544887712` through the Dinstar trunk.
4. Fix the UID-vs-file-owner mismatch properly, not just with `chmod`.
5. Decide how `VM_PUBLIC_DOMAIN` stays in sync between `.env` and the
   database, or point `cert-sync` at `caddy.env` instead.
6. Rotate the temporary passwords above.
7. Adopt `docker compose up -d --build` as the standard deploy step for
   this VM from now on.

## 17. THE call-path root cause found and fixed — `res_srtp` was never built; AMI `command` privilege + reload chain (2026-08-27, third follow-up)

Prompted by the user's assessment ("so many stale functions, not a real
working PBX") and confirmation that **even local extension-to-extension
calls fail**. A `security-audit`-skill pass (3 hunters) + a
`systematic-debugging` Loop A1 evidence sweep across every component
boundary of the call path. The multi-session "reload is unreliable in
this Asterisk build" mystery is now fully explained — it was never one
bug, it was three stacked, each masking the next:

1. **`pbx_configs/manager.conf` — the AMI account had no `command` write
   class.** Every `Action: Command` (`pjsip reload` etc. from
   `pjsip-provision.ts` / `voicemail-provision.ts` / `dinstar-provision.ts`)
   was answered `Response: Error / Permission denied`. Fixed: added
   `command` to `[algopbx-app]`'s `write =` (NOT to `[algopbx-cdr-listener]`).
2. **`src/lib/ami-client.ts` — `send()` never checked `Response: Error`.**
   It resolved the error block as success (only `sendAndCollect()`
   checked). So the denied reload above surfaced to the route as
   "provisioned OK". Fixed: `send()` now rejects on `Response: Error`;
   `parseBlock()` also now joins repeated `Output:` lines (AMI 2.x Command
   response format) so read-back verification can see the full CLI text.
   New tests in `ami-client.test.ts`.
3. **This from-source Asterisk 20 build has NO `pjsip reload` command** —
   only `module reload res_pjsip.so`. `pjsip reload` returned "No such
   command", swallowed by #2. Fixed: all three provision files now issue
   `module reload res_pjsip.so`. `pjsip-provision.ts` also does a
   read-back (`pjsip show endpoints`) and throws a clear "run
   docker compose restart asterisk" error if an endpoint didn't load.

**THE deepest one, found by Loop A1 and NOT previously known:**
4. **`res_srtp` was never compiled into the Asterisk image.**
   `pbx_configs/asterisk-menuselect.makeopts` carried
   `MENUSELECT_DEPSFAILED=MENUSELECT_RES=res_srtp` — the from-source build
   never installed `libsrtp2-dev` before `./configure`, so `res_srtp`
   failed its dependency check and was silently dropped. **Every
   generated WebRTC endpoint has `media_encryption=dtls`, which requires
   `res_srtp`; without it Asterisk rejects the entire `type=endpoint`
   stanza at config-load with no logged error** — `pjsip show auths` and
   `pjsip show aors` showed 1001/2001/2002 fine, while `pjsip show
   endpoints` was empty but for `dinstar-trunk`. This is why no WebRTC
   agent has ever registered in this repo's history — one layer deeper
   than the missing-DTLS-cert-files issue §16 found. Fixed:
   `Dockerfile.asterisk` now installs `libsrtp2-dev` (build) +
   `libsrtp2-1` (runtime), and runs `make menuselect.makeopts` +
   `menuselect --enable res_srtp res_odbc func_odbc ...` for a clean
   dependency-checked selection instead of freezing the hand-copied
   makeopts (whose frozen DEPSFAILED set — `res_pjsip_config_sangoma`
   etc. — diverged from a clean scan and broke the build).

**Security fixes landed this session (from the `security-audit` skill —
full findings in the plan file):** B0 `web` bound to `127.0.0.1:3000` +
`DOCKER-USER` REJECT for :3000 (was cleartext on every interface,
bypassing Caddy/TLS); B1 login lockout keyed on the client-controlled
`X-Forwarded-For[0]` → forgeable → unauthenticated ADMIN takeover (setup
admin has no phone so skips 2FA) — now takes the proxy-appended last XFF
entry + a per-email aggregate bucket a rotating header can't evade; B1c
`AUTH_SECRET` was presence-checked only, `.env.example` ships `change-me`
— now rejects known placeholders + <32 chars; B2/B2 (2 hunters) any AGENT
could toll-fraud via `POST /api/calls/conference` originating straight at
the trunk, bypassing dial tiers + DNC + emergency block — now routes
through a `Local/…@from-agent-<tier>` channel like click-to-call; B2b jwt
callback never re-read `role`/`extension` (demotion took ≤8h) — now live;
B3 SUPERVISOR could silently harvest any extension's plaintext SIP
secret/PIN via the un-audited `{userId}`/`{rotateSecret}` branches — now
ADMIN-only + audited; B4 comma in an agent's own name permanently broke
voicemail regen org-wide (throw-whole-batch) — now sanitized per-entry;
B4 SSRF via `POST /api/admin/dinstar/probe` (`host` interpolated raw into
a URL) — now `assertProbeableHost` (bare private IPv4 + range check);
B4/E2 `CLOUDFLARE_API_TOKEN` accepted newlines (401 + caddy.env line
injection) — now regex-validated + `setSetting` trims all secrets.

**E1 (objective #2): admin can now edit agent accounts** — `PATCH
/api/admin/users/[id]` extended with name/email/role/password/simPort/
extensionNumber; new `DELETE` (ADMIN-only, revoke + release resources +
scrub PII, keep audit history); edit drawer in `/admin/users`.

**E2 (objective #5): Cloudflare "token rejected"** — surfaces the real CF
error/code instead of a hardcoded string; queries `/zones?name=` per
apex candidate instead of un-paginated `per_page=50`; scope help text
now says `Zone:DNS:Edit` + `Zone:Zone:Read`.

**Verified live this session:** AMI now authenticates + `module reload
res_pjsip.so` succeeds from the `web` container; provisioning extension
1001 through `/admin/extensions` writes a real secret AND the read-back
verification correctly reports the endpoints don't hot-load (honest
error, was a silent false success before). Local `npm run
typecheck`/`test` (230)/`lint` all clean. **Asterisk image rebuilding
with `res_srtp` at session pause** — the WebRTC-endpoint load + first
local call (A6) is the immediate next verification once it finishes.

**Immediate next steps:**
1. Finish `docker compose build asterisk` (res_srtp), `up -d`, confirm
   `pjsip show endpoints` lists 1001/2001/2002 and `module show like
   srtp` shows `res_srtp.so` Running.
2. Rebuild `web` (`docker compose build web`) to pick up all the
   Track A/B/E1/E2 source changes, `up -d --build web`.
3. Two browser profiles → register two agents → **first local A↔B call
   with two-way audio** (Gate 1). RTP: `VM_PUBLIC_IP` in `.env` is still
   `127.0.0.1` — set it + `docker compose up -d coturn` for non-local
   media.
4. Dinstar inbound IVR fix is a GATEWAY-side config (two-stage dial off,
   fixed destination) — see plan Track C; then harden `[from-dinstar]`
   with `exten => _[+0-9].,1,Goto(s,1)`.
5. B3b: render `manager.conf`/`odbc.ini` from `.env` at startup (still
   hand-templated; a resync reverts them).
6. Rotate all credentials (plan Track B5).

## 18. First call carried; outbound GSM blocked at the Dinstar; CDR/recording gaps closed (2026-08-27, fourth follow-up to §17)

**FIRST CALL EVER CARRIED.** After the §17 fixes plus two more found this
session (AOR/auth object naming, `Web.SessionManager` ignoring its
`server` arg), agent 2002's softphone registered over WSS and dialed
`*97` → call went Up in VoicemailMain → **Asterisk RTP 150 rx / 128 tx,
0% loss, codec alaw** — bidirectional DTLS-SRTP media over the direct
192.168.11.x LAN path. `GO_LIVE_CHECKLIST.md` Gate 1 is finally met.

Two more call-path bugs fixed:
7. **Generated PJSIP `[<n>-aor]` / `[<n>-auth]` object names.**
   `res_pjsip_registrar` resolves a REGISTER's AOR by the `To:` username
   (`2002`), so a `2002-aor` object is never found →
   `404 "AOR '' not found for endpoint '2002'"` on every registration.
   Fixed `pjsip-config.ts` to name all three objects `[<n>]` (standard
   PJSIP wizard pattern).
8. **`Web.SessionManager` ignores its `server` constructor arg when
   `userAgentOptions.transportOptions` is set** (it was, for
   `keepAliveInterval`) → transport URL became `""` → "Invalid WebSocket
   Server URL" → crashed the whole React app on every agent page. Fixed
   `sip-context.tsx`: repeat `server` inside `transportOptions` + a
   fail-soft guard.

**CDR + recording ingestion gaps closed:**
- `cdr_manager.so` shipped "Not Running" — no `pbx_configs/cdr_manager.conf`
  existed, so Asterisk never emitted the `Cdr` AMI event → CDR table
  stayed empty regardless of call activity. Added the file + mounted it.
  **Verified: a `*97` call now writes a `CallDetailRecord` row.**
- `MixMonitor` was only in `[from-dinstar]` (inbound). Added it to
  `[from-agent-common]` so **outbound calls record too** (objective:
  "recording for both inbound and outbound").
- `[from-agent-common]` / `-international` / `[from-dinstar]` matched only
  `_X.`, which does NOT match a leading `+` → outbound to `+971544887712`
  hit "invalid extension" → `603 Decline`. Changed to `_[+0-9].` and added
  `Set(DIALNUM=...)` to strip the leading `+` before `Dial(...@dinstar-trunk)`.

**Dinstar SIP port:** `src/lib/dinstar-config.ts` hardcoded `:5060` but
the UC2000 must move off 5060 when Asterisk also binds 5060 on the same
host (the device refuses a trunk peer on its own local port). New
`DINSTAR_SIP_PORT` setting + env var (default 5060, this office = 5061);
`renderDinstarConf(ip, sipPort)`; `dinstar-provision.ts` reads the setting.
Seed conf + `.env.example` + VM `.env` all set to 5061.

**OUTBOUND GSM TEST — Asterisk side fully working, Dinstar returns 503.**
Placed a real call from 2002 to `+971544887712`. SIP trace confirms:
tier match (2002 NATIONAL, +971 allowed) → DNC check (ODBC live) → `+`
stripped → MixMonitor started → INVITE to `...@dinstar-trunk`. The GSM
leg gets `503 Service Unavailable` (was `404` before the port fix). The
gateway's "IP to GSM Call History" is all zeros — rejected at the SIP
layer before any port is tried.

**DINSTAR UI — pending (user is doing this, 2026-08-28).** Full checklist
is in `handoff.md`. Summary: Claude already changed IP→Tel Routing rule
"default" Source from `SIP Server` → `Trunk-0 <AlgoPBX>` (Asterisk
connects as a trunk peer, not register-mode — most likely 503 cause).
User to confirm it stuck + re-test, then check: gateway Local SIP Port =
5061; port 0 in port-group-0; trunk is plain peer (no auth/register);
number format (may need Digits-to-Delete=3 + Prefix=0 → `0544887712`);
Tel→IP routing rule for inbound; and disable two-stage dialing /
secondary dialtone for inbound (issue #6 "rings once then asks for
extension").

**Confirmed healthy in the Dinstar UI (no change needed):** SIP Trunk 0
`192.168.11.20:5060` "AlgoPBX" KeepAlive Yes; Digit Map `x.#|x.T`; port 0
SIM registered, full signal, Idle; device UC2000-VE Business 8 GSM ports.

**Still un-run:** the rebuilt Asterisk image (A5 UID-chown + B3b
config-templating entrypoints, res_srtp) has not been deployed yet.
cdr-listener still has a ~12-min AMI reconnect loop (needs a keepalive
ping — login itself works). Messaging track (E7 stale agent badges, E8
start-new WhatsApp/SMS conversation, E9 Contacts page, D1/D2) is
explicitly LAST per the user. `git`: 3 commits unpushed (19cc979,
a444f94, + docs) — push only on explicit say-so.

## 19. Outbound GSM audio confirmed live; inbound traced to carrier-side call barring, not config (2026-08-28)

Session picked up mid-plan (`~/.claude/plans/sorted-sprouting-crystal.md`,
supersedes the wigderson plan — that one was blocked on a stale subagent
registry, fixed by a session restart). Full plan covers bridged-LAN
migration, USB portability, and boot-time network identity (Phases 2–5);
this entry covers only what was executed: Phase 1 (call path) and the
start of Phase 6 (messaging, delegated in parallel per updated instruction).

**Cabling reality correction, discovered live:** the operator had never run
Ethernet from the office router to this PC — the wired NIC's only-ever use
was the direct Dinstar cable. Mid-session the Dinstar was moved to the
office router to test flattening, which stranded it on the wrong subnet
(confirmed by a full `192.168.0.0/24` sweep — 7 hosts, none the UC2000) and
left the VM's bridged `enp0s8` without carrier. **Reverted**: Dinstar back
on the direct cable to the PC. Recovery techniqe for next time if this
happens again: a temporary secondary IP in the Dinstar's subnet
(`New-NetIPAddress -InterfaceAlias 'Wi-Fi' -IPAddress 192.168.11.50
-PrefixLength 24`) reaches it over L2 without any routing, since it's the
same broadcast domain. Phase 2 (the real flatten) is now gated on a cable
run from the router to the PC that doesn't exist yet — nothing else in the
plan needs it.

**Bridge required a second full power-cycle** after the cable was restored
— link came back but `ping 192.168.11.1` from inside the VM failed
(`PROBE`, never `REACHABLE`) even though the reverse direction and
host↔VM both worked, confirming VirtualBox's bridge binding — not the NIC's
`Protocol ARP Offload` setting, which was already correctly `Disabled` —
needs a full guest power-cycle to rebind after a carrier drop, matching
§16. No SSH sudo password was available in-session for a clean
`systemctl poweroff`; the operator ran it interactively via `! ssh`.

### The 503 hypothesis chain — both leading theories eliminated, real cause found live

1. **`DINSTAR_SIP_PORT` env-forwarding gap (new, sharper than previously known).**
   Confirmed via `debugger` agent: the loaded AOR contact was correct
   (`sip:192.168.11.1:5061`) but only because `pjsip_dinstar.conf` is still
   the **build-time seed** from `.env.example` — it has never been through
   `renderDinstarConf` at runtime. Both resolution legs are dead: no
   `DINSTAR_SIP_PORT` row in `AppSetting` (the wizard's apply route never
   persists it — already known), **and** `docker-compose.yml:303-305` never
   forwards `DINSTAR_SIP_PORT` into the `web` service's `environment:`
   block at all — the host `.env` has it, `algo-web`'s `process.env` does
   not. First "write Asterisk config" wizard run will silently regress the
   trunk to `:5060`. **Not yet fixed in code** — two-line fix identified
   (add to compose `environment:`, persist in the apply route), queued in
   the plan's Phase 1.4.
2. **Source-address asymmetry (dual NIC) — ELIMINATED.** `network-engineer`
   agent: `ip route get 192.168.11.1` returns `dev enp0s8 src 192.168.11.20`
   unconditionally (longest-prefix match beats the NAT default route, no
   policy-routing override). There is no code path by which the NAT
   address reaches the gateway. **The planned LAN flatten would not have
   fixed the 503 structurally — that hypothesis is retired, not deferred.**

### What actually happened on a live test call — real audio, then a real transfer bug

With the bridge fixed, a call from agent 2002 to a national-format number
(`0504852446` — dialing in `+971...` E.164 form got `503`/`480` from the
GSM leg, but the **national format `05...` got through cleanly**) went
**100 Trying → 183 Session Progress → 200 OK**, bridged, and carried
**confirmed bidirectional RTP** (`res_rtp_asterisk.c` packet log, both
legs, both directions — Dinstar↔Asterisk on `192.168.11.1:8000`↔`.20`,
Asterisk↔browser via ICE on `192.168.56.1`/`192.168.11.10`). **First
outbound call with verified real audio, not just signaling.** Call ended
normally 11s later (`Reason: Q.850;cause=16`, the far end hanging up).

**The `+971...` E.164 attempts were the original 503 all along** — GSM
leg answered (100/183 with real Dinstar SDP) then the network itself
rejected within ~2s (`480 Temporarily not available`), consistent with the
carrier not accepting that dial format on this SIM/line. National format
avoids it. Worth carrying into Phase 1.4's digit-manipulation fix (Dinstar
IP→Tel Advanced Rules: Digits to Delete=3, Prefix to Add=0).

**New bug found, not yet fixed:** an agent's blind transfer via `REFER`
to `+971544887712` is handled by the dialplan as **a second, brand-new
outbound call through the same GSM trunk** — placed from the channel
representing the *already-bridged* Dinstar leg, while the original call to
`0504852446` was still up. The Dinstar correctly refused the overlapping
INVITE with `503` (port already occupied). This is a real design gap for
single/limited-port GSM trunks, not a config bug — blind-transferring an
active GSM call to an external PSTN number can't be served by re-dialing
through the same trunk. Deferred; needs its own design pass, not a
quick fix. Flagged to the operator; not started.

### Inbound fix attempted, applied cleanly, but root cause is one layer deeper (carrier-side)

Root-caused via the Dinstar UI (no code changes) that inbound calls hit
the gateway's own two-stage-dialing IVR: **Port 0 had no "To VOIP Hotline"
set**, combined with **"Do Not Answer GSM Incoming Call for Hotline" =
Yes** (Service Parameter) — that combination falls back to the device's own
digit-collection prompt instead of forwarding. Fixed via the UI (Chrome,
`claude-in-chrome`, driven directly by the agent):
- Port Configuration → Port 0 → **To VOIP Hotline = `100`** (value is
  cosmetic — Asterisk's `[from-dinstar]` context unconditionally
  `Goto(s,1)` regardless of the digits it receives).
- Service Parameter → **Do Not Answer GSM Incoming Call for Hotline = No**.
- **First save silently didn't commit** — clicking Save immediately
  navigated to the login page instead of the usual "Parameters OK" prompt,
  and the value reverted after the required restart. Root cause not fully
  understood (likely a session race); the fix was to redo it and confirm
  the "Parameters OK, setting successfully." prompt appears **before**
  restarting — that attempt persisted correctly across the restart.
- **Both restarts required a native browser `confirm()` dialog the
  automation could not dismiss programmatically** (`CDP
  Input.dispatchMouseEvent`/`Runtime.evaluate` both hang while a JS dialog
  blocks the renderer) — the operator dismissed it manually both times.
  Flag for anyone automating this UI again.

**After the fix, inbound got WORSE in a way that revealed the real cause.**
4 live test calls (same caller number both before and after) each rang
once and dropped — **no incoming-call notification in the agent UI at
all**, a regression from the earlier "please dial extension" IVR
behavior. Diagnosis, evidence-first:
- `docker exec algo-asterisk asterisk -rx "core show channels"` / the full
  SIP trace: **zero `INVITE` requests from `192.168.11.1` ever appeared**,
  before or after the hotline fix, across the whole session. Asterisk was
  never contacted for any of these calls.
- Dinstar's own **GSM Event** log: every "Call in" event shows
  **`FORBID CALL`, duration 1s**, caller `065426169` (national format).
- Dinstar's own **SIP Call History**: **all zeros**, every port, both
  directions. The device never attempted the Tel→IP leg at all — the
  rejection happens purely at the GSM/mobile layer, before any Call
  Configuration logic (routing, digit map, caller manipulation, hotline)
  is ever consulted.
- Ruled out via direct UI inspection (all confirmed empty/default, not the
  cause): Call Limit, Tel→IP Caller Manipulation, Digit Map (`x.#|x.T`,
  permissive), Call Forwarding (unset), Phone Number Learning (unset),
  Phone Number Config (unset). **One false lead corrected in-session:**
  "No Alerting Call Handle" was initially misread as `Hang Up` from a
  flawed DOM query (grabbed `checked` without the matching `value`); a
  corrected query confirmed it was already `Normal Handle` — not the cause.
- **USSD query sent to the SIM** (`*#35#`, standard GSM "query barring of
  all incoming calls" code) via the Dinstar's own USSD tool: network
  replied **`UNKNOWN APPLICATION`** — the carrier's supplementary-service
  subsystem itself isn't responding for this SIM/line.

**Conclusion: this is a carrier-side restriction, not a Dinstar or Asterisk
config problem.** Every configurable surface on the gateway has been
checked and ruled out; the GSM layer accepts the call just long enough to
log it, then kills it in ~1s, before the device even tries the SIP leg.
**Next action is not code or gateway config — it needs a call to the SIM's
carrier** to check for active incoming-call barring on the line or confirm
the SIM's plan includes standard two-way voice service.

### Messaging track — delegated in parallel (operator reversed "strictly last")

Full current-state map done (`Explore` agent, no code changes yet):
navbar badge staleness (`agent-shell.tsx`), no route/UI exists to start a
new WhatsApp/SMS conversation (`ingest.ts`'s `conversation.create` is only
reachable from inbound webhook/poll paths), no session-authenticated
Contacts page (`/api/crm/contacts` is bearer-API-key-only, for external
CRM sync), WhatsApp instance-error surfacing exists admin-side
(`pairing/route.ts` persists `lastError`) but is invisible agent-side
(`/api/me/whatsapp` doesn't select it), Dinstar SMS provider is explicitly
marked unverified-against-hardware in its own header comment. Full detail
in the plan file's Phase 6.

**New, more specific findings from the operator this session** (not yet
started): `POST http://openwa:2785/.../messages/send-text` returns **400**
on send; the admin WhatsApp room UI shows only the last message instead of
the full thread and needs a WhatsApp-Web-style layout (no status/settings
buttons); voice messages aren't playable; the admin panel needs a manual
refresh to see new inbound WhatsApp messages (no live update). All folded
into Phase 6 of the plan for the next session.

### Git — corrected and decided

`handoff.md`'s "~110 uncommitted files" was **stale** — actual working
tree this session had exactly 2 modified files (`LLM.md`, `handoff.md`);
everything else was already in the 3 local commits. Secret hygiene
verified clean (`.gitignore` excludes `.env`/`pbx_configs/keys`/
`pbx_configs/generated`; the one alarming-looking tracked file,
`.jetro/daemon/credentials.json`, is `{}`). **Found: `origin` is
PUBLIC** (`github.com/deepakt369b-droid/algo-pbx`), remote `master` is an
unrelated-history older snapshot of this same project (85 files, one
`"commit"`-messaged push, 2026-08-24) — nothing unique to preserve. The
exposure was raised explicitly (full deployment topology, firewall
matrix, domain, Dinstar/Tailscale design would publish) and the operator
confirmed proceeding anyway — **git work (delete `.jetro/` debris, commit,
push `main` as a new branch alongside `master`) is queued, not yet
executed this session.**

### `DINSTAR_SIP_PORT` landmine — fixed and verified (delegated, `nextjs-developer` agent)

The gap identified above is closed. `api/admin/dinstar/apply/route.ts`
now persists `DINSTAR_SIP_PORT` via `setSetting` alongside the other four
wizard settings; the wizard UI (`admin/dinstar/page.tsx`) gained a labeled
port field on the link step (default `5060`) explaining the UC2000's
own-local-port constraint. Validation logic factored into new
`src/lib/dinstar-apply-schema.ts` (matches `settings/schema.ts`'s
`DINSTAR_SIP_PORT` validator exactly, with a comment tying the two so they
can't drift), with 6 new focused tests in
`dinstar-apply-schema.test.ts`. **Independently re-verified, not just
taken on the agent's word**: `npm run typecheck && npm run test && npm run
lint && npm run build` all re-run and confirmed green (236/236 tests,
zero lint warnings, full build with `/admin/dinstar` route intact) after
reviewing the actual diff. `docker-compose.yml` was correctly left
untouched — it already had `DINSTAR_SIP_PORT: "${DINSTAR_SIP_PORT:-5060}"`
in `web`'s `environment:` block; the deployed container is just stale and
needs `docker compose up -d --no-deps web` to pick it up (not done this
session — no active calls were risked to do it).

### `saharatechs.com` DNS — found pointing at an unrelated business, fixed

Operator reported the domain loading `aceindustry.ae` on mobile/other
networks. Root-caused via direct Cloudflare API inspection (read-only
first): the zone's **A record pointed at `139.84.171.47`** — the exact
same IP `aceindustry.ae` resolves to, almost certainly GoDaddy's default
parked-domain landing IP (the zone also carries a `_domainconnect`
CNAME to `domaincontrol.com`, GoDaddy's auto-provisioning artifact) — and
was **`proxied=true`** (violating `DEPLOYMENT.md`'s explicit grey-cloud
requirement, which would have broken SIP/RTP/WSS even with the right IP).
Local browsing on this LAN was unaffected because of an existing Windows
hosts-file override (`192.168.11.20 saharatechs.com`, from an earlier
session) that bypassed public DNS entirely.

**Fixed via the Cloudflare API** (token already present in
`pbx_configs/generated/caddy.env` on the VM) after explicit operator
confirmation: A record repointed to the office's current public IP
(`217.165.236.207`, checked live via `ifconfig.me`), both the apex A
record and the `www` CNAME switched to **DNS-only (`proxied=false`)**.
Verified propagated via Cloudflare's own `1.1.1.1` resolver post-change.

**Not fixed, expected next**: port 443 (and 8089/3478/RTP) is not yet
reachable on `217.165.236.207` from outside — the router doesn't forward
those ports to the VM yet. That's Phase 5 of the plan, not started. The
realistic result right now is "can't connect" rather than the login page
— a real improvement over redirecting to a stranger's website, but not
yet a working public PBX.

### Messaging track (E7–E9, D1–D2) — all five items completed, delegated to 5 parallel subagents

Full Phase 6 of the plan executed in one pass, each agent given exclusive,
non-overlapping file ownership so five parallel writers couldn't collide.
**Every agent's diff was independently reviewed and the full verification
suite (`typecheck && test && lint && build`) was re-run by hand on the
final combined tree** — not just accepted on each agent's own report, same
standard as the `DINSTAR_SIP_PORT` fix. Result: clean typecheck, **265/265
tests passing** across 33 files, zero lint warnings, successful production
build with the full route manifest (including every new route). No file
collisions occurred — each changed file traced to exactly one agent's
declared scope, confirmed via `git status --porcelain` before and after.

- **E7 (badges)**: Voicemail badge was structurally incapable of being
  "unread" (no seen-state existed anywhere — filesystem-spool voicemail
  has no DB row to attach one to). Added `User.voicemailSeenAt`
  (migration hand-written, **not applied to a live DB** — no
  `DATABASE_URL` reachable in the agent's environment; needs
  `npx prisma migrate deploy` against the real Postgres before this
  ships), `GET/POST /api/voicemail` now round-trips it exactly like the
  existing missed-calls pattern, badge counts only unseen messages via a
  new pure `countUnseenVoicemail` helper. Missed-calls badge lag fixed by
  adding a `MissedCallsRefreshContext` so the mark-read action triggers an
  immediate badge re-fetch instead of waiting up to 20s for the next poll.
- **E8 (start new conversation)**: `ingest.ts`'s inline find-then-create
  extracted into an exported `findOrCreateConversation()` (preserving the
  `waInstanceId: null`-is-never-equal Postgres behavior the original
  comment already flagged), reused by both the inbound webhook/poll path
  and a new `POST /api/messaging/conversations` for agent-initiated
  threads. New compose UI lives inside `conversation-list.tsx`'s header.
  Session-gated at agent level (`requireSession`), matching the
  `[id]/messages` POST precedent, not admin-only.
- **E9 (Contacts page)**: New `/admin/contacts` (staff-only —
  `requireStaffSession`, matching every other `/admin/*` page; reasoned
  explicitly that `middleware.ts` already blocks AGENT sessions from every
  `/admin/*` route regardless, so gating the API more loosely than the
  page is reachable would be dead code) with full CRUD, `DELETE` returns
  409 rather than a raw FK-constraint throw when a contact still has
  conversations. CDR caller numbers now resolve to `Contact.displayName`
  via a new join in `api/cdr/route.ts` (flagged explicitly as outside the
  original file list — nothing else claimed it, judged safe). Agent
  missed-calls/voicemail caller-name resolution was deliberately **not**
  done this pass to avoid a two-writer collision with E7 on the same
  files — left as an explicit follow-up.
- **D1 (WhatsApp)**: Found and fixed the actual cause of the live
  `send-text` 400 — `openwa-client.ts` built request bodies keyed `to`,
  but the real OpenWA DTO expects `chatId` (verified against the pinned
  commit's actual SDK source fetched from GitHub, not guessed — flagged
  honestly as code-level verification, not a live-call confirmation, since
  the sidecar wasn't reachable from the agent's environment). Agent-facing
  WhatsApp error surfacing fixed (`lastError` now selected and rendered on
  the connection badge). The "last message only" thread view was a
  flexbox bug (`min-h-0` missing on the scroll chain), not missing
  iteration logic — fixed, plus a minimal WhatsApp-Web-style bubble layout
  with **no status/settings button**, per the explicit instruction. Voice
  messages now render via `<audio controls>` using the same trust/handling
  level the pre-existing image rendering already had for `mediaUrl`.
- **D2 (Dinstar SMS provider verification)**: Reached the **real, live**
  UC2000 at `192.168.11.1` and found two concrete defects the code's own
  "unverified" banner had flagged as risk: plain HTTP never actually
  serves anything on this device, only redirects to HTTPS (fixed —
  `baseUrl()`'s default scheme changed to `https://`); the device's
  **self-signed TLS certificate causes `DEPTH_ZERO_SELF_SIGNED_CERT`** on
  every request from this codebase as currently written — confirmed by
  reproducing the exact `fetch()` call in a scratch script, not assumed.
  **Not fixed** (deliberately, flagged as a required follow-up rather than
  papered over): the TLS trust problem itself needs either a trusted cert
  on the device or a narrowly-scoped opt-in on the shared HTTP client — a
  blanket `NODE_TLS_REJECT_UNAUTHORIZED=0` was explicitly rejected as an
  inappropriate unilateral fix (would weaken TLS for every other outbound
  call in the process). Also flagged for whoever owns it: the device
  redirects an unauthenticated request to an HTML `/enLogin.htm` session
  page, not a `401 WWW-Authenticate: Basic` challenge — contradicts what
  `dinstar-discovery.ts`'s `probeHost()` fingerprint assumes. Real
  credentials were never available in-session; no credential guessing was
  attempted. Test fixtures are honestly labeled best-effort constructed,
  not real-captured, since an authenticated response was never obtained.

**Net effect**: E7/E8/E9 are fully shippable pending the voicemail
migration being applied to a live DB. D1's chatId fix and thread-view fix
are shippable; the send-400 root cause is fixed with strong evidence but
not live-confirmed. D2 revealed the SMS provider cannot work at all yet
against this specific device until the TLS trust problem is resolved —
this is now a known, well-understood blocker instead of an "unverified"
question mark.

- 2026-08-28 — **Single-port-Dinstar blind/attended-transfer fix**, confirmed live via a real SIP trace: an agent transferring an active GSM call to an external number caused Asterisk to place a SECOND outbound Dial() through `dinstar-trunk` from the already-bridged Dinstar leg, which the gateway correctly rejected with `503` (only one SIM/port live) — the agent saw a bare failed transfer with no explanation. **Chose Option A (client-side rejection)**, not the dialplan-side option: `extensions.conf`'s `from-agent-common` has no clean way to detect "this channel's REFER target is retargeting an already-Dinstar-bridged leg" without bridge/`CHANNEL(peer)` introspection this repo has no live Asterisk to build or verify against, whereas rejecting before the REFER (and, for attended transfer, before the consult call's own `manager.call()` — itself a second outbound dial, independent of REFER) is strictly earlier, equally effective for the reported failure mode, and fully testable as pure logic today.
  - New `src/lib/transfer-guard.ts`: `isInternalExtension()` mirrors `extensions.conf`'s `_1XXX`/`_2XXX` internal-routing patterns exactly (not `pjsip-config.ts`'s looser `\d{3,6}` provisioning validation — flagged in-file as a pre-existing dialplan gap, not something this guard should silently paper over); `evaluateTransferPermission()` blocks only "current call is Dinstar-trunk-originated AND target isn't a known internal extension", fails OPEN (allows) when the call's origin is untracked/unknown, same availability-over-blocking tradeoff already used by the DNC dialplan check. 11 tests, `transfer-guard.test.ts`.
  - `src/contexts/sip-context.tsx`: new `primaryCallOriginRef` (`"trunk" | "internal" | null`) set on every call-establishment path (`makeCall` by destination pattern, `onCallReceived` by the inbound caller-id user part — a queue-distributed GSM call always presents the external caller's own number there, never an internal extension) and cleared on every teardown path (hangup, `onCallHangup`, the SessionManager-rebuild cleanup, a failed `makeCall`). `blindTransfer` and `startAttendedTransfer` both call `evaluateTransferPermission()` first and `throw` a clear message ("Can't transfer an active GSM call to another external number — this line only has one connection.") if blocked — this reuses `call-controls.tsx`'s existing `transferError` catch path (already wraps every transfer action in try/catch), not a new UI surface.
  - Internal-to-internal, internal-to-external, and trunk-to-internal transfers (agent-to-agent/queue/voicemail) are completely unaffected by design — the guard only fires on the one combination that was actually confirmed to produce the 503.
  - **Verified**: `npm run typecheck && npm run test && npm run lint && npm run build` — all four clean (278 tests passing, up from 267; build exits 0). **Not verified, and cannot be from this environment**: whether a real REFER from this softphone actually gets blocked client-side before hitting the wire, and whether the dialplan's existing behavior for the (now-guarded-against) case is exactly as SIP-traced — no live Asterisk/Dinstar in this session, same standing constraint as every other SIP code path in this repo. No `pbx_configs/*.conf` files were touched by this fix (Option A was entirely client-side), so no dialplan reload is needed.

### Deployed to the live VM — and a correction to an earlier claim

Tonight's code (both the `DINSTAR_SIP_PORT` fix and the full messaging
track) is now **running live** on `192.168.11.20`, not just committed.

The VM's `/home/pbx/algo-pbx` is a separate git checkout still on old
`master`, carrying ~101 files of uncommitted local changes from prior
sessions' direct SSH edits — never reconciled with this Windows clone's
history. Rather than risk a `git pull`/reset across unrelated histories,
every one of the 34 files tonight's commits touched was diffed against
the VM's live content first: the 22 that already existed there were
**byte-identical** to this repo's `a444f94` baseline, confirming the VM's
tree is a clean superset with no local divergence in application source —
safe to copy over directly, which is what was done (tar + scp, no `git`
involved on the VM side).

**Correction**: §19 claimed `docker-compose.yml` "already had
`DINSTAR_SIP_PORT` correctly, just needed a container recreate." That was
checked only against this Windows repo's copy — the VM's actual deployed
`docker-compose.yml` **did not have the line at all**
(`grep DINSTAR_SIP_PORT docker-compose.yml` on the VM: no match). Added it
directly on the VM (backup kept at `docker-compose.yml.bak-sipport`,
matching this repo's exact line/comment — should be folded into a real
commit next session, currently only live on the VM, not in git). After
recreating `algo-web`: `DINSTAR_SIP_PORT=5061` confirmed present in the
container's actual environment for the first time ever. **This closes the
whole landmine loop for real** — code fix + compose fix + live
verification, not just the code half.

Also applied live: the `voicemailSeenAt` migration (`ALTER TABLE`,
confirmed via `\d "User"` before/after, and registered in
`_prisma_migrations` with a computed checksum matching Prisma's own
format, so a future `prisma migrate deploy` won't try to reapply it) —
done only after explicit operator confirmation, since it's a direct write
to the live database.

Verified post-deploy: all 8 containers healthy (`caddy`'s known
false-alarm aside), `/admin/contacts` and `/admin/dinstar` both return
`307` (redirect to login — proof the routes exist and are correctly
gated, not 404).


## 20. Hold/transfer call-window collapse fixed; agent navbar wired to real routes; MOH hardened; inbound-voice diagnosis corrected (2026-08-28, follow-up to §19)

Entry point was a user report bundling four symptoms: the agent navbar's
Voicemail/Missed/Chat items do nothing, pressing Hold (or starting a
Transfer) makes the active-call card collapse to "No active call" while
the call is still live on the far end, no music plays on hold, and a
pasted third-party diagnostic brief for the Dinstar inbound/SMS/Tailscale
path. Root-caused all four by reading the actual code (`sip-context.tsx`,
the installed `sip.js` in `node_modules`, `call-controls.tsx`,
`agent-shell.tsx`, the PJSIP/MOH configs) rather than trusting the pasted
brief, which turned out to be wrong or already-solved on several specific
claims — see the corrections recorded in the approved plan file
(`~/.claude/plans/the-navbar-voicemail-missed-chat-cheeky-pinwheel.md`).

**Root cause of the call-window collapse (two independent causes, both
confirmed against `node_modules/sip.js`, not assumed):**

- **Hold**: `toggleHold` had no try/catch and `call-controls.tsx`'s onClick
  had no `.catch` — a hold/unhold rejection was an unhandled promise
  rejection with zero UI feedback. Worse, sip.js's own
  `SessionManager.setHold` → `Session.invite()` (the hold re-INVITE)
  **terminates the session itself** from inside `session.js` when Asterisk
  2xxs the re-INVITE with an answer SDP the browser can't apply
  (`ackAndBye(488, "Bad Media Description")`) — and reports that through
  the **same** `onCallHangup` delegate as an ordinary hangup. The app then
  unconditionally reset to `"idle"`, which is what "No active call"
  renders — while the far end (Asterisk, and whoever it's bridged to)
  stays up. Confirmed a rejected re-INVITE *cannot* do this (the Web
  SessionDescriptionHandler has no `rollbackDescription`, so sip.js's
  rollback path is a no-op) — the live failure has to be an *accepted*
  re-INVITE whose answer SDP fails locally.
- **Attended transfer**: `completeAttendedTransfer` awaited
  `manager.transfer(...)` and reset both sessions unconditionally on
  resolution. But `Session.refer()`/`_refer()` resolves as soon as the
  REFER hits the transport — never on the 202, and never on the
  transfer-result NOTIFY that actually says whether the far end accepted
  it. A REFER later rejected (4xx/5xx/6xx — precisely the single-port
  Dinstar 503 case behind the `9292e92` transfer-guard commit) still
  collapsed the UI to idle with **both** sip.js sessions alive and
  orphaned: `hangupCall` early-returns on the now-null ref, a later
  far-end BYE fails the identity check in `onCallHangup`, and
  `onCallReceived` believes the agent is free while two real calls are
  still up.
- Two secondary defects found alongside: SessionManager shares **one**
  `<audio>` element across every managed session, so ending the
  attended-transfer consult call wiped the resumed primary call's audio
  (silent, not dropped); and the attended-hold failure wrote to
  `dialError`, rendered by `Dialpad`, not `CallControls` — the agent could
  never see it.

**Fix:**

- New `src/lib/call-termination.ts` (`classifyTermination`) and
  `src/lib/refer-notify.ts` (`parseReferNotify`/`describeReferNotify`) —
  pure, sip.js-independent decision helpers, same pattern as the existing
  `transfer-guard.ts`. 16 new tests between the two.
- `sip-context.tsx`: `toggleHold` wrapped in try/catch/finally with a
  `holdInFlightRef`; `onCallHangup` now calls `classifyTermination` to set
  a new `callError` (surfaced by `CallControls`, including its idle
  branch, so the explanation survives the collapse) instead of silently
  resetting; `completeAttendedTransfer` rewritten to pass `onNotify` and
  gate the reset on `parseReferNotify` reporting `succeeded` — on
  `failed`/timeout (~15s) both sessions are kept alive so the agent can
  retry or cancel, matching the existing "single-port Dinstar" guard's own
  intent; `blindTransfer` gets the same NOTIFY wiring for feedback only
  (its local-leg collapse on REFER acceptance is legitimate). New
  `reattachPrimaryAudio()` re-attaches the primary session's remote stream
  via `manager.getRemoteMediaStream()` whenever the consult session ends
  while the primary lives. The attended-hold failure now writes
  `callError`, not `dialError`.
- `call-controls.tsx`: renders `callError` in both the active-call and
  idle cards, with a dismiss button; the Hold button gets a defensive
  `.catch` on top of `toggleHold`'s own internal handling; the
  `completeAttendedTransfer` catch surfaces the thrown error's real
  message instead of a fixed string.
- Behind `NEXT_PUBLIC_SIP_DEBUG=1`, sip.js's `userAgentOptions.logLevel`
  now goes to `"debug"` — needed to actually capture the live SDP failure
  on a real deploy; **not verified against live Asterisk/Dinstar, no such
  environment exists in this session** (same standing constraint as every
  other SIP code path in this repo). The fix makes the failure visible and
  non-fatal to the UI; it does not by itself guarantee the hold re-INVITE
  starts succeeding — that needs a `pjsip show history` SDP diff on real
  hardware, see the plan file's Verification section.

**Agent navbar wired to real routes.** `agent-shell.tsx`'s
Voicemail/Missed/Chat items were plain `<span>`s — not stale data (their
badge counts already polled live endpoints, fixed by an earlier commit),
just non-navigable. New `src/app/agent/{voicemail,missed,chat}/page.tsx`,
each a thin server-component shell (mirrors `admin/cdr/page.tsx`) around
the **existing** `AgentVoicemail`/`AgentMissedCalls`/`ChatPanel`
components — no duplicated data fetching, no new endpoints. Navbar items
are now real `<Link>`s with an active-route indicator via `usePathname()`.
`MissedCallsRefreshContext` still spans `children` at the layout level, so
the badge-refresh handshake is unaffected. Also fixed in passing:
`GET /api/me/missed-calls` never resolved `callerNumber` to a Contact
display name, unlike `/api/cdr` — now reuses
`buildContactDisplayMap`/`resolveContactDisplayName` from
`contact-display.ts`, same as the admin CDR page.

**MOH hardened.** Config was already structurally correct (verified live
in §16/§18: `musiconhold.conf`'s `[default]` class registers,
`direct_media=no` lets Asterisk anchor media and inject MOH). What was
missing was that class selection was **entirely implicit** — no
`moh_suggest` anywhere, so it only worked because PJSIP's own implicit
default happens to be the string `"default"`, matching the class name by
coincidence. Now pinned explicitly: `moh_suggest=default` on
`[dinstar-trunk]` (`pjsip-base.conf`) and on every generated WebRTC/
hardware endpoint (`src/lib/pjsip-config.ts`, with new test assertions),
plus a new `[global]` section pinning `moh_passthrough=no`. Also moved
`moh/default/README.md` → `moh/README.md`: it previously sat *inside* the
directory Asterisk scans for playable files, and `moh show files` was
listing it as a track (harmless only because `.wav` sorts first — see
§16's original finding). **Not fixed, and can't be from here:**
`moh/default/music-box.wav` is gitignored and will not exist on a fresh
clone/deploy target — an empty directory means silence with no error, not
a crash, so this is easy to miss. Must be copied to any new deploy target
by hand.

**Inbound-voice diagnosis in `handoff.md` corrected.** New evidence (the
gateway *answers* and plays a "please dial the extension" prompt before
dropping) directly contradicts §19's carrier-side-barring conclusion — a
truly barred call can't produce gateway audio at all. This matches Dinstar
DISA/second-dial-tone behavior from an empty "To VOIP Hotline" on one or
more ports; §19's own record of a "Port 0 hotline" fix "confirmed
persisted" suggests it was never applied (or didn't survive) on the other
three ports. `handoff.md` now carries an explicit correction block above
the superseded section rather than an edited-in-place rewrite of history.
**Not applied in this session** — it's a Dinstar web UI change (To VOIP
Hotline = `s` on all four ports), not a code change, and no access to the
gateway exists in this environment.

**Verified this session:** `npm run typecheck && npm run test &&
npm run lint && npm run build` all clean — 294 tests passing (up from 278
in §18/§19's last count, +16 from the two new pure-logic test files), build
exits 0. **Not verified, and cannot be from this session:** any of the
hold/transfer/MOH fixes against a real SIP call — no live Asterisk/Dinstar
available here, same standing constraint as every other SIP code path in
this repo. The Dinstar hotline fix and the `moh/default/music-box.wav`
copy are both real-hardware/real-deploy follow-ups, not code.

**Also produced, not yet executed:** a full production-deployment plan
for a fresh Hostinger VPS (Phases 1–5: bootstrap, Tailscale bridge to the
Dinstar, gateway inbound-voice config, SMS TLS fix + poller, security
hardening), gated on this session's Phase 0 fixes landing first. Several
corrections to the user-provided deployment brief are recorded in the
plan file itself — notably a contested Dinstar LAN IP (`192.168.11.1` per
this repo's own config vs `192.168.11.20` claimed in the brief, which
§15's live VM record confirms is actually the VM's own second NIC on
that LAN, not the gateway), `DINSTAR_AUTH_STYLE`'s real values being
`basic`/`query` (not digest), and the SMS API being self-signed HTTPS (not
plain HTTP) — undici rejects it before any application code runs, which is
the actual blocker, not credentials or auth style, neither of which has
ever been exercised.


## 21. Production deployment to a real Hostinger VPS — full stack live over HTTPS on a real domain; Tailscale bridge to the Dinstar re-established; inbound-voice diagnosis re-confirmed live, correcting §20's correction (2026-08-28, same day, follow-up to §20)

Direct continuation of §20 in the same session: once the Phase 0 app fixes
landed, the user asked to continue straight into the deployment plan
(`~/.claude/plans/the-navbar-voicemail-missed-chat-cheeky-pinwheel.md`,
Phases 1–5) rather than stopping. This entry covers everything actually
executed — Phase 1 (VPS bootstrap) end to end, Phase 2 (Tailscale bridge)
end to end, and the start of Phase 3 (Dinstar gateway config), where a
live re-test overturned §20's own inbound-voice correction.

### Access established, not assumed

The session had no pre-supplied VPS credentials. Key-based SSH to
`root@187.53.128.252` (Hostinger, Ubuntu 26.04.1 LTS, hostname
`srv1936994`) worked on the first attempt using this machine's existing
`~/.ssh/id_ed25519` — confirmed rather than guessed
(`ssh -o BatchMode=yes ... echo CONNECTED`). Two Cloudflare API tokens the
user pasted (`cfat_...` prefix, not the standard unprefixed Cloudflare
token format) were both rejected outright by Cloudflare's own
`/user/tokens/verify` endpoint ("Invalid API Token", code 1000) — real,
externally-verified rejections, not a local assumption. Documented as a
genuine open question (why a token generated fresh from the dashboard's
own confirmation screen would still fail Cloudflare's own check) rather
than papered over.

### Phase 0 committed and pushed first

Per the plan's explicit gate, §20's fixes were committed
(`7ff2c4c "Fix hold/transfer call-window collapse, wire agent navbar, pin
MOH config"`, 21 files) and pushed to `origin/main` before Phase 1 cloned
the repo onto the VPS — discovered in the process that GitHub's default
branch for this repo is still `master` (stale, unrelated history), not
`main`; the clone step now explicitly documents `git checkout main`.

### Phase 1 — VPS bootstrap

- Docker 29.7.2, Compose v5.5.0, git 2.53.0 already present on Hostinger's
  image (skipped the manual install steps in the plan).
- `ufw`: SSH already implicitly reachable, then explicitly allowed
  22/80/443/8089/tcp + 443/3478/10000:20000/udp, enabled with 22 allowed
  FIRST to avoid a lockout, verified with a **fresh** SSH connection
  (not the already-open session) before proceeding. 5060 deliberately
  left closed at this point.
- Secrets: all 12 required (`POSTGRES_PASSWORD`, `SETTINGS_ENCRYPTION_KEY`,
  `COTURN_AUTH_SECRET`, `AMI_SECRET`, `CDR_AMI_SECRET`, `AUTH_SECRET`,
  `CDR_INGEST_SECRET`, `CRM_WEBHOOK_SECRET`, `OPENWA_API_MASTER_KEY`,
  `OPENWA_WEBHOOK_SECRET`, `SMS_POLL_SECRET`, `PRUNE_SECRET`) generated with
  `openssl rand` on the VPS itself, not invented locally. `VM_PUBLIC_IP`/
  `VM_PRIVATE_IP` both `187.53.128.252` — this Hostinger VPS has a single
  NIC with a directly-assigned public IP, no separate private network
  segment, confirmed via `ip -4 addr show` (not assumed from the plan's
  generic dual-IP template). `DINSTAR_LAN_IP=192.168.11.1` kept as-is,
  resolving the plan's flagged contested-IP question in the repo's favor
  (confirmed later this session — `.20` really is the old local VM, `.1`
  really is the gateway). `RESEND_API_KEY`/`DINSTAR_SMS_PASSWORD`
  deliberately left as `change-me` (not needed to launch / gated on
  Phase 4).
- **Build trap, found and fixed live:** `docker compose build` failed on
  `vendor/openwa/upstream` not existing — not a submodule, a documented
  manual step (`bash vendor/openwa/prepare.sh`, pins a specific upstream
  OpenWA commit) that the plan's Phase 1 checklist hadn't called out
  explicitly. Run once, unblocks the build.
- **Real root cause chased down, not worked around:** the full
  `docker compose build` then failed with `make[2]: *** [...
  libpjsua...] Error 2` inside the from-source Asterisk build — a bare
  `make` exit code with no compiler diagnostic in the captured log. Rather
  than accept that as a genuine pjproject/toolchain incompatibility,
  reproduced the exact failing `RUN` step in an isolated throwaway image
  (truncated `Dockerfile.asterisk` built up to the `WORKDIR` before the
  failing line, `docker run` into it, re-ran `./configure` /
  `make menuselect.makeopts` / `make third-party` individually with the
  real exit code captured to a separate file — the exact `> log 2>&1;
  echo $?` discipline `CLAUDE.md`'s build-log-capture warning describes).
  **The isolated rebuild succeeded cleanly, exit 0.** Conclusion: the
  original failure was resource contention — `docker compose build`
  defaults to building all 5 services concurrently, and this box has only
  2 vCPUs / 7.7GB RAM building Asterisk-from-source, OpenWA's
  Chromium+Vite bundle, Caddy's Go compile, and two Next.js `npm ci`s all
  at once. Fix: build each service **sequentially**
  (`docker compose build <service>`, one at a time, each with its own
  captured real exit code) — all five (`asterisk`, `caddy`, `web`,
  `cdr-listener`, `openwa`) then built clean individually.
- **Second trap, exactly as the plan predicted:** `docker compose up -d`
  failed on `caddy` — `error mounting
  "/opt/algo-pbx/pbx_configs/generated/Caddyfile" to rootfs`, because
  `pbx_configs/generated/` ships with only a `README.md` and Docker had
  materialised a directory at the missing mount path. `rmdir` the stray
  directory, `bash scripts/render-caddy-env.sh` (seeds the safe
  plain-HTTP-only template), `docker compose up -d caddy` — came up
  healthy. All 8 services (`postgres`, `coturn`, `asterisk`, `web`,
  `cdr-listener`, `caddy`, `cert-sync`, `openwa`) confirmed healthy via
  `docker compose ps`; `cert-sync` needed a second plain `docker compose
  up -d` (no service filter) since it `depends_on: caddy` and hadn't
  auto-started when only `caddy` was targeted.
- Verified externally: `curl http://187.53.128.252/` — 200, real Algo PBX
  landing page ("Wired for SAHARA") rendered, not a stub.
- **TLS, without the Cloudflare token that never worked:** since both
  Cloudflare tokens failed and the VPS already has port 80/443 openly
  reachable, used Caddy's own default automatic HTTPS instead of the
  app's built-in Cloudflare-DNS-01 `/admin/settings` flow — a
  hand-written `pbx_configs/generated/Caddyfile` for `pbx.saharatechs.com`
  with no `tls` block, which Caddy satisfies via `tls-alpn-01` using the
  already-open port. Real blocker hit and resolved along the way: the
  `pbx` A record didn't exist in Cloudflare yet (confirmed absent even on
  Cloudflare's own `1.1.1.1` resolver, ruling out propagation lag) — the
  user added it by hand (grey-cloud/DNS-only, matching the plan's
  requirement that the proxy not intercept WSS/TURN traffic on this
  domain). Once DNS resolved, `docker restart algo-caddy` obtained a real
  Let's Encrypt certificate on the first attempt — confirmed independently
  via `openssl s_client`: `subject=CN=pbx.saharatechs.com`,
  `issuer=Let's Encrypt`, valid through 2026-11-26. This deliberately
  diverges from the app's own domain-apply route (still Cloudflare-DNS-01
  only) — documented in the Caddyfile's own header comment so a future
  session doesn't get confused about why the two don't match, and so a
  working Cloudflare token later can cleanly take over without conflict.
- **First-run `/setup` intentionally left to the user.** `POST /api/setup`
  creates the first ADMIN account with a real login password — squarely
  "creating an account, entering a password to authenticate" per this
  session's own action-permission rules, prohibited regardless of
  technical ability to do it via `curl`. Directed the user to
  `https://pbx.saharatechs.com/setup` in their own browser; verified after
  via `GET /api/setup` returning `needsSetup: false`, not by asking the
  user to self-report.

### Phase 2 — Tailscale bridge to the Dinstar

- **Corrected an assumption in the plan's own Phase 2, live:** the plan
  assumed a Linux "always-on machine" would run
  `scripts/setup-tailscale-uae-office.sh`. This session's actual dev
  machine (this Windows PC) turned out to already be physically wired
  into the Dinstar's own LAN (`Ethernet` interface holds
  `192.168.11.50`/`192.168.11.10`, confirmed reachable to the gateway at
  `192.168.11.1` via `ping` and an HTTPS 302). Rather than force the bash
  script onto an unsupported OS, installed the Windows Tailscale client
  directly (`winget install Tailscale.Tailscale`) and brought it up with
  `tailscale up --advertise-routes=192.168.11.0/24 --accept-routes` — the
  same effective config the shell script would have produced, adapted to
  the actual host. **The stale `192.168.1.0/24` default in
  `setup-tailscale-uae-office.sh`/`setup-tailscale-cloud.sh` the plan
  flagged is still unfixed in the repo** — not touched this session since
  the Linux script path wasn't actually exercised; flagged again here so
  it isn't lost.
- Both ends authorized interactively (user opened each
  `login.tailscale.com/a/...` link) — confirmed via `tailscale status` on
  both sides, not assumed from the CLI returning without error.
- **Route approval traced through a real UI-navigation confusion, not
  hand-waved:** after advertising the route, the VPS's own
  `tailscale status --json` kept showing `PrimaryRoutes: None` for the
  Windows peer despite the user reporting the route as "approved" twice —
  turned out they were looking at the Windows tray applet (local
  connection status only) and then the bare machines list, not the
  specific per-machine "Subnets" panel in the web admin console where
  approval actually lives. Resolved once the user clicked through to the
  right panel; confirmed via the VPS's own peer view
  (`PrimaryRoutes: ['192.168.11.0/24']`) before declaring it done, then a
  real `ping 192.168.11.1` from the VPS (0% loss, ~150ms RTT, UAE↔cloud)
  as the final proof — not the advertised-route state alone, which had
  already been shown to lag reality once.
- **5060 opened narrowly, not broadly:** confirmed via `ufw`'s own block
  log (`grep 'UFW BLOCK'`) that container-to-host AMI traffic
  (`5038/tcp`) was being silently dropped from the `algo-net`/`default`
  Docker bridge subnets — `cdr-listener` had been stuck in a reconnect
  loop against `host.docker.internal:5038` this whole time with no
  visible error beyond "connecting...". Fixed by scoping `ufw` rules to
  the exact three Docker bridge subnets in use (`172.17/18/19.0.0/16`),
  not "Anywhere" — `cdr-listener` connected and went healthy immediately
  after. Applied the identical narrow-scoping principle to SIP itself:
  rather than rebind Asterisk's PJSIP transport off `0.0.0.0:5060` (which
  the plan flagged as needing a templating mechanism that doesn't exist
  yet), left the bind alone and added one `ufw` rule
  (`allow in on tailscale0 from 192.168.11.0/24 to any port 5060 proto
  udp`) — achieves "SIP never exposed publicly" at the firewall layer with
  no code change, confirmed 5060 has no other rule (still unreachable
  from the public internet).

### Phase 3 — Dinstar gateway config, and a self-correction

Logged into the gateway's own web UI (user entered credentials directly,
never shared with or seen by this session) via browser automation from
the Windows PC already on that LAN. **Corrected two more assumptions on
sight:** this is a UC2000-**VE Business**, 8 ports not 4 (ports 4–7 have
no modem hardware installed/powered; ports 1–3 have modems but no SIM
inserted; only port 0 has a live, registered SIM) — the plan's "all 4
ports" instructions were adjusted to "all 8" accordingly, though only
port 0 is actually live.

Findings, all read directly off the device, not inferred:
- **Port Configuration**: only port 0 had a "To VOIP Hotline" value
  (`100`); ports 1–7 were empty. Set to `100` on all 8 (matching port 0's
  existing, dialplan-compatible value — `extensions.conf`'s `_X.`
  catch-all routes any digit string to `s` regardless, so `100` and the
  plan's suggested `s` are functionally identical here) via the
  bulk-select-and-type UI flow (the page's own "copy to all" button
  turned out to clear fields instead of propagating them — typed each
  port's field individually instead once that was discovered).
- **Tel→IP Routing table appeared empty on first load** — turned out to
  be a stale/slow AJAX render on that specific page, not a real gap: a
  page reload revealed a pre-existing rule (`ToAlgoPBX`, index 0,
  Port Group-0 → Trunk-0, Allow) that was there all along. A duplicate
  rule added before catching this was deleted again, leaving the
  original two rules (`ToAlgoPBX` and a `default` catch-all) untouched.
- **The real, load-bearing find:** SIP Trunk 0 ("AlgoPBX") pointed at
  `192.168.11.20:5060` — the OLD local-office VM from before this
  redeploy, not the new cloud VPS. Updated to `100.64.32.115:5060` (the
  VPS's Tailscale IP) via the trunk's Modify form. This is the actual
  config gap that mattered; the hotline values were cosmetically
  incomplete but the trunk destination being dead would have blocked
  everything regardless.
- No NAT-traversal toggle exists anywhere in this firmware's UI to
  disable — confirmed by reading through `SIP Configuration` and
  `Network Configuration` in full rather than assuming a checkbox exists
  because the plan mentioned one.

**Live re-test overturned §20's own correction.** With `pjsip set logger
on` and a live `docker logs -f algo-asterisk` watch running, the user
placed two real calls to the SIM immediately after the hotline+trunk fix.
Both logged `FORBID CALL` in the gateway's own GSM Event history (1s
duration, identical to every other inbound attempt recorded tonight going
back hours) and **produced zero SIP traffic on the Asterisk side** —
nothing in the live log at all. Before concluding anything, re-checked
every device-side setting that could plausibly cause a DISA-then-reject
pattern (Call Limit: no rules; Phone Number Learning: no rules; Digit Map:
permissive catch-all; Basic Configuration's "No Alerting Call Handle":
Normal Handle; GSM incoming call limit: disabled) — all clean, matching
what `handoff.md` §19 had already ruled out before §20's correction ever
happened. Two YouTube links the user offered as reference mid-test turned
out to be a 30s Dinstar IP-PBX demo clip and a **Dinstar Analog Gateway**
(FXO/FXS, not GSM) training video — checked both, neither applicable to a
GSM carrier-barring question.

**`handoff.md` corrected a second time** (a RE-CORRECTION section, not a
silent rewrite): the DISA/empty-hotline theory that drove §20's earlier
fix does not survive live re-testing and is now marked superseded again;
the original carrier-side-barring diagnosis from §19 is confirmed current.
The hotline and trunk-IP fixes made this session are kept (real, correct
config hygiene, and now correct for whenever the carrier issue clears) but
are documented as **not** the fix for today's actual blocker. Next step
recorded as unchanged from §19: contact the SIM's mobile carrier about
incoming-call barring — nothing further is fixable from the PBX/gateway
side. Also recorded honestly: the user separately recalled hearing a DISA
prompt on this same SIM earlier today, before this session's changes —
noted as a real, credible first-person observation that doesn't reconcile
with tonight's live evidence, rather than dismissed.

**Verified this session:** VPS reachable and healthy end-to-end (8/8
services), HTTPS live with a real independently-verified cert, admin
account created and confirmed, Tailscale bridge proven with a real ping
across it, Dinstar SIP trunk pointed at a reachable destination, ufw
rules confirmed via both `status` and the kernel's own block log — not
assumed from any single tool's success exit code. **Not verified, and
currently blocked on something outside this session's control:** any
inbound call actually reaching Asterisk — carrier-side barring prevents
testing the SIP trunk/`[from-dinstar]` dialplan/queue path at all until
the carrier issue clears. Outbound calling was not re-tested this session
(no reason to expect regression — nothing touched the outbound path — but
not independently confirmed against the new VPS either).

**Not yet done, remaining from the plan:** Phase 4 (SMS — the TLS-bypass
code change and the poller service), Phase 5 (fail2ban, `ss -tulnp`
audit, Hostinger snapshots), and the stale-subnet-default fix in the two
Tailscale shell scripts noted above.


## 22. Dinstar gateway config applied via browser automation; carrier-barring theory decisively ruled out; paused on a SIM/antenna registration issue (2026-08-28, same day, direct continuation of §21)

Direct continuation of §21's Phase 3 work, same session. Logged into the
Dinstar UC2000-VE's own web UI (`https://192.168.11.1`) via browser
automation from this Windows PC — the user entered the gateway's admin
credentials directly into the login form; this assistant never saw them.

### Config applied, confirmed via screenshots at each step

- **Port Configuration**: "To VOIP Hotline" was `100` on port 0 only,
  empty on ports 1–7. Set to `100` on all 8 (the bulk "copy to all"
  button on this firmware actually **clears** the target fields instead
  of propagating them — discovered by watching it fail, then typed each
  port's field individually instead). Saved, confirmed "Parameters OK".
- **Tel→IP Routing**: appeared completely empty on first load ("Total:
  entries", blank) — turned out to be a slow/stale AJAX render on that
  specific page, not a real gap; a reload revealed a pre-existing rule
  (`ToAlgoPBX`, Port Group-0 → Trunk-0, Allow) that had been there the
  whole time. A duplicate rule added before catching this was deleted
  again.
- **SIP Trunk Configuration** — the actual load-bearing fix: Trunk 0
  ("AlgoPBX") pointed at `192.168.11.20:5060`, the old local-office VM
  from before this session's redeploy. Updated to `100.64.32.115:5060`
  (the new VPS's Tailscale IP) via the trunk's Modify form.
- **Port Group Configuration**: confirmed `port-group-0 <default>` — the
  only group that exists — already covers all 8 physical ports
  (`0,1,2,3,4,5,6,7`), so none of the above needed per-port duplication
  and covers wherever the live SIM ends up.
- No NAT-traversal toggle exists anywhere in this firmware to disable;
  confirmed by reading `SIP Configuration` and `Network Configuration` in
  full rather than assuming a checkbox exists because a plan mentioned
  one.

### Live re-test overturned §20's DISA-prompt correction, again

With `pjsip set logger on` and a live `docker logs -f algo-asterisk`
watch running on the VPS, the user placed two real calls to the SIM
immediately after the fix above. Both logged `FORBID CALL` in the
gateway's own GSM Event history (1s duration, identical to every other
inbound attempt recorded that day) and produced **zero** SIP traffic on
the Asterisk side. Re-checked every device-side setting that could
plausibly cause a DISA-then-reject pattern — Call Limit (no rules),
Phone Number Learning (no rules), Digit Map (permissive catch-all
`x.#|x.T`), Basic Configuration's "No Alerting Call Handle" (Normal
Handle), GSM incoming call limit (disabled) — all clean. Also checked two
YouTube links the user offered mid-test as reference: a 30s Dinstar
IP-PBX demo clip and a **Dinstar Analog Gateway** (FXO/FXS, not GSM)
training video — neither applicable to a GSM carrier-barring question.
`handoff.md` picked up a RE-CORRECTION section (not a silent rewrite):
the DISA theory doesn't survive live re-testing; the original
carrier-barring diagnosis was reinstated as current. Committed
(`e6ec1f0`).

### The decisive test: carrier barring ruled out for real

The user physically moved the SIM card out of the Dinstar and into an
ordinary mobile phone. **It received incoming calls normally** — same
number, same carrier — including with the phone deliberately forced onto
2G-only network mode. A number that is actually barred by the carrier
fails on every device, unconditionally; this one didn't. **This
permanently rules out carrier-side incoming-call barring** — overturning
§19's original diagnosis and §21's re-confirmation of it, both of which
this session had otherwise trusted. Also ruled out along the way (checked
before the phone test, once §21's re-confirmation started looking shaky):
a 2G-voice-sunset theory (`Mobile Configuration` shows the module is
2G-only — `NetWork Mode`/`Band Type` both `Default(Auto)`, page's own note
confirms "GSM module Only supports" pure-GSM band combinations, no real
3G/4G capability) — also ruled out by the same phone test once forced to
2G.

### New leading theory, untested — hardware/seating, not carrier or config

With every carrier- and config-side theory eliminated, tried one more
diagnostic step: rebooted the whole gateway (`Tools → Restart`, user
confirmed first since it drops all 8 ports for ~1–2 minutes, not just
port 0) to rule out a stuck radio state despite the module showing
"Registered". Discovered along the way that **`Tools → Module Recovery`
is a firmware re-flash utility** (needs a firmware file, real risk of
bricking a module if interrupted), not a soft reset as the label
suggested — correctly did not run this without explicit confirmation.

Post-reboot, the SIM came back on a **different physical port (1, not
0)** — the tray apparently got swapped when the user moved the card
between the phone and the gateway. Polled `Mobile Information` repeatedly
over ~4.5 minutes: signal icon showed visibly weak/near-empty bars the
entire time, status crawled from "searching network" to outright
**"Mobile Unregistered"** — markedly worse than port 0's earlier "Mobile
Registered, full signal" reading before any of today's SIM-swapping.
This was never resolved before the session ended — asked the user to
physically check the SIM seating and antenna connection on the gateway,
which they were about to do when they had to leave for the day.

**`handoff.md` given a full end-of-session rewrite of its own header**
(not just another correction block — the whole "what to read first"
section) recording the exact pickup state for tomorrow: VPS/Tailscale/
gateway access details (no new credentials needed — SSH key auth and the
Tailscale bridge are both already live), the full chain of overturned
theories in order so nothing gets re-litigated from scratch, and the
precise next three steps (check SIM/antenna seating → re-test live with
both-sided log watching → no config change needed regardless of which
port the SIM ends up in, since `port-group-0` already covers all 8).

**Verified this session (in addition to §21's list):** Dinstar hotline and
SIP trunk config changes saved and confirmed via the device's own
"Parameters OK" / list-view responses, not assumed. **Not verified, and
now blocked on a physical hardware check the assistant cannot perform
remotely:** whether the SIM/antenna are actually seated correctly on
whichever port it's now in — this is the literal next step, not a new
open question found late.

## 23. Admin overrides: agent phone at creation, plaintext password display, hard user delete (2026-08-29, deployed to prod VPS)

Operator-directed changes to `/admin/users`, **deployed live** (commit
`58e9c21`, migration `20260829000000_add_password_plain` applied, `web`
rebuilt + recreated, healthy):

- **Agent phone box in account creation** — the phone field now shows in
  BOTH "Email invite" and "Set password now" modes (was password-mode
  only). Backend already accepted `phoneE164` for either path; only the
  form was withholding it. When set, the number is stamped
  admin-verified (`phoneVerifiedByAdminId`) + `profileCompletedAt`, so a
  WhatsApp password-reset code works for that agent immediately.
  Root cause of the operator's "reset not sending" report: the test
  accounts had NO phone on file, so `/api/auth/forgot-password`'s
  `phoneE164 && phoneVerifiedAt` guard silently sent nothing. The OpenWA
  instance itself was connected and healthy the whole time.
- **`User.passwordPlain`** (new nullable column) — kept in sync with
  `passwordHash` at every write site (setup, invite consume, admin create,
  admin PATCH, self-service reset). `GET /api/admin/users` returns it for
  ADMIN sessions only; the user list shows `Password: <value>` per row.
  **Deliberately breaks the original "an admin never learns the agent's
  password" property** — owner's call, see memory
  `owner-overrides-security-model`. Pre-existing users show blank until
  their next password change.
- **Hard `DELETE /api/admin/users/[id]`** — replaced the soft-delete +
  PII-scrub with a real transactional hard delete: removes the `User` row
  plus all FK-referencing rows (auditLog, otpChallenge, trustedDevice,
  loginAttempt, invite, escalationAttempt, smsAccessRequest, chat
  assignments); extensions/SIM ports are released (unlinked, not deleted);
  DNC entries reassigned to the acting admin. Audit trail for that person
  is gone by design.

typecheck + 294 tests + lint + build all clean before deploy.

**Resend mail helpers were reporting false success** (commit after
`58e9c21`, deployed): the Resend SDK resolves with `{ error }` instead of
throwing on an API failure, and `sendInviteEmail`/`sendPasswordResetEmail`
ignored the return — so a failed send (bad key, unverified domain) showed
as a green "Test email sent". Now checked and re-thrown, so
`/admin/settings` "Test connection" and the invite/reset warnings surface
the real reason.

**`/register` <-> `/agent` redirect loop (regression from the §23 admin
changes, found + fixed + deployed same session).** Admin user creation
stamped `profileCompletedAt` whenever a phone was supplied, but the form
has no address field and `isProfileComplete()` — which `src/middleware.ts`
and `/api/me/sip-credentials` recompute live from the fields — requires
one. `GET /api/register` trusted the timestamp and told the page to
`router.replace("/agent")`; middleware saw the empty address and bounced
back to `/register`; the page renders "Loading..." while redirecting, so
the loop showed as a permanently stuck loading screen. Three fixes:
(1) admin create no longer sets `profileCompletedAt` (pre-verified phone
just skips the OTP step); (2) `GET /api/register` derives `profileComplete`
from `isProfileComplete()`, not the timestamp; (3) the register page only
skips the profile step when name AND address are already on file.
Verified live in-browser: `/agent` now loads fully. No DB surgery needed
— the stuck agent recovers by filling the address on the (now-shown)
form.

**Agent softphone / call path (inbound + outbound) unblocked on the VPS.**
`pjsip show endpoints` showed ONLY `dinstar-trunk` — extensions 1001/1002
were in the generated `pjsip_dynamic.conf` but Asterisk was silently
rejecting both endpoint stanzas because
`/etc/asterisk/keys/asterisk.crt` / `asterisk.key` (the self-signed
DTLS-SRTP media cert every generated endpoint references) **did not
exist** on this VPS — only the Let's Encrypt `fullchain.pem`/`privkey.pem`
had ever been placed there. `module reload res_pjsip.so` reported success
but never loaded them (the known reload-unreliability). Fixes:
(1) generated `pbx_configs/keys/asterisk.{crt,key}` on the VPS with
`openssl req -x509` per that dir's README; (2) `docker compose restart
asterisk` — 1001 + 1002 now load (`Unavailable`, i.e. waiting for a
REGISTER, not rejected), queue member `PJSIP/1002` went `Invalid` ->
`Unavailable`; (3) added an `ensure_dtls_media_cert()` bootstrap to
`scripts/cert-sync.sh` (the one container with write access to that dir)
so a fresh deploy self-heals instead of costing another session.
Outbound dialplan (`from-agent-{local,national,international}` ->
`from-agent-common` -> `Dial(PJSIP/<num>@dinstar-trunk)`) and inbound
(`from-dinstar` -> `support_queue`) are both correct and loaded. **Two
things still gate real calls:** the agent must finish registration (add
an address — the redirect-loop fix above lets them reach the form) before
`/api/me/sip-credentials` will hand the softphone its creds, and ext 1002
is `dialPermission=LOCAL` (UAE numbers only) — bump it to NATIONAL in
`/admin/extensions` to also reach India (+91), then restart asterisk.
Inbound GSM still additionally depends on the Dinstar gateway actually
delivering the INVITE (the separate SIM/registration "normal hangup"
question).

**Outbound GSM: `DINSTAR_SIP_PORT` was `5061`, gateway is on `5060` —
every outbound INVITE was black-holed.** Live SIP capture on the VPS
showed Asterisk retransmitting `INVITE sip:...@192.168.11.1:5061` six
times with ZERO packets back (32s -> "NO ANSWER"). A raw OPTIONS probe
proved the gateway answers `200 OK` on `:5060` and is silent on `:5061` —
the `5061` value was left over from the old same-host local-VM setup
(where Asterisk also bound 5060 on the same box) and never applied to the
split-host VPS/Tailscale topology. Fixed on the VPS
(`pbx_configs/pjsip_dinstar.conf` contact -> `:5060`, `.env`
`DINSTAR_SIP_PORT=5060`, asterisk restarted) and in the repo
(`.env.example` default, seed `pjsip_dinstar.conf`, and the now-corrected
`5061` comments in `src/lib/dinstar-config.ts` + `settings/schema.ts`).
**After the fix the gateway responds** — `100 Trying` then
`503 Service Unavailable` on the GSM leg. `503` from the UC2000 on
outbound almost always means the SIM's GSM module isn't registered to the
mobile network (the handoff §22 open item: "Mobile Unregistered" / weak
signal after the physical port swap) or a gateway-side IP->Tel routing
rule. Needs the gateway web UI (office LAN only) — its admin password is
not recorded here, so this session could not check GSM status directly.

**Still open from this session:** the invite-email path — settings now
hold `INVITE_FROM_EMAIL=algopbx@saharatechs.com` and a `RESEND_API_KEY`
whose last 4 chars render as `.com` (suspicious — a real key is `re_…`;
an email may have been pasted into the key field). Resend mail helpers
now surface the real error (they were reporting false success). Operator
to re-run "Test connection" for the now-truthful error and re-paste the
real key. Also: inbound GSM call still untested (agent 1001 unregistered,
zero CDRs). Inbound GSM call: agent 1001 was unregistered and
zero CDRs exist; a live trace was armed but no call came through the
window. Both need a follow-up.
