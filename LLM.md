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
- Design language: **"Apple black"** (superseded the old dark-slate/cyan glass lock, 2026-09-01). True-black `#000` base / `#1C1C1E` cards / `rgba(255,255,255,.08)` hairlines / single system-blue `#0A84FF` accent used sparingly; light mode `#FFFFFF`/`#F5F5F7`/`#1D1D1F`; SF-Pro-like system font; 10–14px radii; flat — no gradients, no glow, no purple. All colours are CSS variables in `src/app/globals.css` (light on `:root`, dark on `:root[data-theme="dark"]` + `prefers-color-scheme`), surfaced as Tailwind semantic tokens. **No page may hardcode a hex.** Stack: Tailwind + Headless UI (`src/components/ui/`); MUI/Emotion removed. Phase M (MUI migration) is CANCELLED.
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
- [ ] **Dinstar gateway syslog / Remote Server feature (2026-09-03 — see Build Log)**
  - [x] `GatewayEvent` model + migration, parser/classifier, receiver sidecar, ingest route + real-time alerting, 30-day retention, `/admin/system` panel + dedicated alert banner, `GATEWAY_ALERT_EMAIL` setting. All gates green.
  - [x] Deployed: `web` + `gateway-syslog-listener` rebuilt/started, migration confirmed applied by name, listener confirmed bound to the Tailscale IP only, firewall rule active.
  - [ ] Live traffic confirmed end-to-end (blocked: gateway's Diagnostic → Syslog config saves/persists but zero packets ever observed arriving; operator's SIM was ejected mid-diagnosis — retry once a SIM is back in)
  - [ ] `syslog-parse.ts`'s taxonomy re-validated/widened against real captured gateway output (built defensively without ever seeing one)
- [ ] **OpenVPN-primary / Headscale-fallback / connectivity feature (2026-09-03 — see Build Log, supersedes the syslog task's Tailscale-only descoping)**
  - [x] `GatewaySite` model + migration, OpenVPN server + bridge (no Docker socket/no PKI in Postgres design), Headscale server + Caddy subdomain, multipart config-push capability with genuine HTML read-back verification, `/admin/connectivity` page + wizard + runbook, 60s connectivity poller + alert extension, syslog listener dual-homing, cutover mechanism. Independent V1 security review found 3 real issues (stale-sentinel cleanup silently no-op'd against a read-only mount; one route missing defense-in-depth filename re-validation; cutover claimed success/set transport even when trunk-reprovisioning verification failed) — all fixed, gates re-run clean. All four gates green: typecheck, 435 tests, lint, build.
  - [x] G1 — infra deployed and healthy (`web`, `gateway-syslog-listener`, `headscale`, `openvpn-server`, `openvpn-bridge`). Not clean on the first try — 6 real bugs found live and fixed (Headscale's stock image is shell-less, a missing required config field, an IP-prefix collision then an over-correction, wrong `ovpn_genconfig` flags that silently dropped the whole legacy-cipher setup, wrong default subnet, two directives that don't exist in the server's actual OpenVPN 2.4.9 binary) — see `handoff.md`'s "OpenVPN/Headscale/connectivity, part 2" for the full blow-by-blow. 10 commits, all local+VPS (via direct scp sync). **Pushed to GitHub 2026-09-04** (`ae7094f..b11cc0c`) once the operator gave the go-ahead — GitHub/VPS/local now all in sync. CLI `git push` works again; the Windows Application Control block on `libcurl-4.dll` is gone.
  - [x] CA bootstrapped with a real (operator-chosen, never logged) passphrase — operator explicitly rejected `nopass` (CA is the root of per-customer tenant isolation, a compliance requirement). Encryption-at-rest proven live (`openssl rsa -check` fails without the passphrase). Interim hard rule in effect: `bridge-watch.sh`'s unattended signing is disabled — every new cert issued manually until "CA signing flow v2" (queued, not started, needs a plan brought to the operator first).
  - [x] First client cert issued (`cust-demo-gw-1`, per-customer CN convention `cust-<id>-gw-<n>` applied from here on) — caught a second, separate bug in the same family: the generated `.ovpn` was also silently missing `cipher`/`auth` (`ovpn_getclient` reads a different env file than the one the server-side fix touched) — found and fixed live, `init-pki.sh` updated so future generations don't need the same manual patch.
  - [ ] Manual: Cloudflare A record for `vpn.<domain>` (no existing DNS-upsert mechanism to extend — found, not fabricated).
  - [x] G2 pre-flight (2026-09-04) — server side verified end-to-end from the VPS: all four containers up, `tun0` = `10.8.0.1 peer 10.8.0.2`, `Initialization Sequence Completed`, `cipher AES-256-CBC`/`auth SHA256` confirmed present in BOTH the server config and the client `.ovpn` (the `b11cc0c` fix held), `ccd/cust-demo-gw-1` really does push `10.8.0.10`, status log empty as expected. **One real blocker found: `ufw` has no 1194/udp rule.** `openvpn-server` is `network_mode: host`, so there is no Docker publish and no `DOCKER-USER` bypass — the handshake would have been dropped at the firewall with zero server-side logging, indistinguishable from a cipher mismatch. `scripts/setup-firewall.sh:96` already has the rule; the script was never re-run after the OpenVPN work. Operator must apply it (3 commands, in `handoff.md`'s "G2 pre-flight"); do NOT re-run the script wholesale — it opens with `ufw --force reset` and the live box has deliberately diverged (tighter SIP + AMI scoping). Also retracted: the missing-syslog mystery is NOT firewall-related, the `5514/udp from 100.64.0.0/10` rule is present and correct.
  - [ ] G2 — the tunnel bring-up test is the next concrete step: push `cust-demo-gw-1.ovpn` to the real gateway, confirm a real handshake (expect cipher/auth iteration against the gateway's old embedded OpenVPN client as the first likely snag, not a crisis — its own "Download Log" button is the first diagnostic). Then: run the cutover, real inbound+outbound test call, `SYSLOG_BIND_IP_SECONDARY` + confirm syslog over the new path, only then deprecate Tailscale.
  - [ ] Unreviewed VPS-side `git stash` from the syslog deploy (~40 commits of old uncommitted local drift, backed up two ways, never dropped) — flag for review before it's ever dropped.
- [x] **Multi-tenant SaaS foundation — WAVE 1, DEPLOYED TO PRODUCTION (2026-09-04, see Build Log)** — plan: `~/.claude/plans/task-multi-tenant-saas-foundation-purring-parnas.md`
  - [x] Schema: `Tenant`/`PlatformUser`/`SupportGrant`/`PlatformAuditLog` added; `tenantId` added to all ~34 customer-owned models per the plan's §1 table; uniqueness constraints made tenant-composite exactly per that table (`Extension.number`, `Queue.name`, `Contact.numberE164`, `DoNotCallEntry.numberE164`, `Room.name`, `WaInstance.label`/`simPort`, `Activity`'s `[type,refId]`, `AppSetting.key` with nullable `tenantId`); `User.email`/`phoneE164` and `GatewaySite.name` deliberately left globally unique; `PbxRuntimeFlag`/`McpApproval`/`InboundWebhookDelivery` deliberately left platform-global with no `tenantId`.
  - [x] Migration split into 3 steps per the plan's amended §1: step 1 (additive — new tables + tenant #1 seed + nullable no-FK `tenantId` columns) is a LIVE migration folder (`prisma/migrations/20260904100000_add_tenancy/migration.sql`); step 2 is `scripts/migrate-backfill-tenancy.ts` (batched, idempotent); step 3 is written and ready (`step3_constrain.sql.template` in the same folder) but deliberately NOT a live migration folder yet — promoted only after a rehearsal reports zero orphans and a human signs off (see that file's header for why, and the promotion steps).
  - [x] `src/lib/tenant/slug.ts` + `slug.test.ts` — reserved-word list (`platform, api, www, admin, app, status, mail, support, auth, billing`), DNS-safe + `SAFE_NAME_RE`-compatible charset validation, TDD'd.
  - [x] `scripts/rehearse-tenancy-migration.ts` + `scripts/snapshot-table-counts.ts` + `scripts/lib/tenancy-tables.ts` — rehearsal runbook: before/after row-count snapshot, `prisma migrate deploy`, batched backfill, orphan check, PASS/FAIL summary.
  - [x] `e2e/tenancy-acceptance.*.spec.ts` — Requirement A acceptance additions (existing admin/agent login unchanged, contacts/CDR/SMS spot-check, screenshots); real-call test left as an explicitly skipped TODO stub (needs live Asterisk + a human, out of scope for this wave).
  - [ ] **NOT done in wave 1 (by design — wave 2+'s job, per the plan's sequencing table):** `$extends` scoped client, `auth-guard.ts`/route-handler sweep, RLS, `/platform` console, billing enforcement, domain re-scope, telephony namespacing. Consequence flagged below.
  - [x] **Rehearsed end-to-end against a Postgres snapshot restored from production (2026-09-04)** — isolated staging container on the VPS, live prod DB never touched. Full evidence in Build Log below. Found and fixed one real bug (`DROP CONSTRAINT` → `DROP INDEX`). Step 3 promotion into a live migration folder still requires **owner sign-off** per the working agreement — not done yet.
  - [x] **Owner sign-off given (2026-09-04) — prod run executed for real.** Full sequence, evidence in Build Log below: fresh encrypted snapshot taken immediately before, step 1 (`20260904100000_add_tenancy`) + `20260904120000_add_rls` applied, `migrate-backfill-tenancy.ts` run against production (996 rows across 35 tables, 0 orphans — independently re-verified with direct `SELECT count(*) WHERE "tenantId" IS NULL` on the 7 highest-risk tables, not just the script's own self-report), step 3 promoted to `20260904140000_add_tenancy_constrain` and applied (`NOT NULL`/FKs/composite-unique constraints confirmed live via `information_schema`/`pg_constraint`), `web`/`cdr-listener`/`gateway-syslog-listener` rebuilt and restarted on the tenancy-aware code. Live-verified via browser: real login, Wallboard showing real AMI-connected data, `/admin/contacts` showing all 14 real contacts. Zero 5xx in Caddy logs across the whole deploy window.
  - [ ] Playwright acceptance (`e2e/tenancy-acceptance.*.spec.ts`) and the real-call check still not run — need a running app stack + (for the real call) live Asterisk and a human.
- [x] **Multi-tenant SaaS foundation — WAVE 2a (2026-09-04, see Build Log)** — the scoping MECHANISM, infrastructure only. Plan: `~/.claude/plans/task-multi-tenant-saas-foundation-purring-parnas.md` §2.
  - [x] `src/lib/db.ts`'s global export renamed `db` → `unsafeGlobalDb` (same singleton, name only) — this is what turns `tsc` into wave 2b-2e's enforcement mechanism.
  - [x] `src/lib/tenancy/scope-rules.ts` (pure, unit-tested) + `src/lib/db-tenant.ts` (`tenantDb(tenantId)`, `$extends`-based scoped client) — injects `tenantId` into every tenant-scoped model's read/write, throws for any model not on the known list, special-cases `AppSetting`'s nullable `tenantId` (reads relaxed to "mine OR platform-default null"; writes always forced to the caller's own tenant), and runs every query inside its own `SET LOCAL app.tenant_id` transaction (parameterized via `set_config()`, never string-interpolated) so the RLS policies below actually see the GUC.
  - [x] `prisma/migrations/20260904120000_add_rls/migration.sql` — RLS on `CallDetailRecord`/`Recording`/`Contact`/`ChatMessage`, `FORCE`d so the owning role isn't exempt either. Header documents the three mandatory preconditions (SET LOCAL only, non-superuser/non-BYPASSRLS app role, PgBouncer transaction-mode compatibility) — none verifiable from this environment, must be checked at deploy time. RLS design deliberately does NOT know about `SupportGrant` — kept to a single tenantId-equality predicate; support-grant validity is documented as an application-layer (`platform-guard.ts`, later wave) concern, not a policy-level one.
  - [x] `src/lib/auth-guard.ts`'s three guards now return `{ session, db }` (scoped client) instead of `{ session }`. `session.user.tenantId` added (`next-auth.d.ts`, `auth.config.ts`, `auth.ts`'s `authorize()` and both branches of the live-reread `jwt` callback, same live-recompute pattern as `role`/`disabled`). `auth.ts` itself switched to `unsafeGlobalDb` (legitimate: login runs before any tenant is known) and its two `auditLog` writes now supply `tenantId` explicitly since `AuditLog.tenantId` is a required field.
  - [x] `TODO` left in `auth.ts` referencing plan §1 "Host-vs-user tenant mismatch" — NOT implemented this wave (deliberately out of scope; flagged for whoever does host-based tenant resolution).
  - [x] `src/lib/db-tenant.test.ts` — 20 unit tests on the pure `computeScopedArgs`/`resolveModelScope` logic (no live DB available in this environment). File header states plainly what it does NOT cover: the real two-tenant collision test and the RLS path itself both need a live Postgres and are deployment-time work for a later wave.
  - [x] `npm run test`: 51 files / 479 tests, all green, nothing broken. `npm run typecheck`: 227 errors across 135 files — every one of them is either a route handler under `src/app/api/**` still importing the old `db` export by name, or a non-route `src/lib/**` helper (`api-key-auth.ts`, `crm/*`, `dinstar/*`, `emit-event.ts`, `messaging/*`, `otp/service.ts`, `pjsip-provision.ts`, `rate-limit.ts`, `registration.ts`, `settings/service.ts`, `two-factor.ts`, `voicemail-provision.ts`) with the same import — deliberately left broken (not this wave's job) for wave 2b-2e to sweep by domain. **Correction to wave 1's scope note:** the failing set is wider than "route handlers alone" — several `src/lib/**` files import `db` directly too and will need to switch to a caller-supplied scoped client (or, where no request/session context exists, to `unsafeGlobalDb` with an explicit `tenantId` argument) as part of the 2b-2e sweep, not just the route files themselves.
- [x] **Multi-tenant SaaS foundation — WAVE 3, platform plane (2026-09-04, see Build Log)** — plan §2/§3, same plan doc as wave 1. Built concurrently with the wave-2a worktree above; stayed strictly inside new `platform`-namespace files plus read-only `db` imports, per the task brief's file-collision guard.
  - [x] Separate, parallel Auth.js v5 instance for `/platform`: `src/lib/platform-auth.config.ts` (edge-safe, own session cookie `algopbx-platform-session`, own `basePath` `/api/platform-auth`, own 4h session ceiling) + `src/lib/platform-auth.ts` (Node, Credentials provider: password + mandatory TOTP in one submit) + `src/app/api/platform-auth/[...nextauth]/route.ts`.
  - [x] TOTP (RFC 6238) via `otpauth` (added to `package.json`, chosen for zero native deps + edge/node portability): `src/lib/platform-totp.ts`. **Superseded 2026-09-05, see Build Log**: enrollment moved from the original out-of-band `create`/`confirm` script pair to an in-browser `/platform/setup` flow; the CLI-driven design below is historical.
  - [x] `src/lib/platform-guard.ts` — `requirePlatformSession()`/`requirePlatformOwner()`, mirrors `auth-guard.ts`'s `{session}|{response}` shape exactly; adds a live `PlatformUser.disabled` re-check per request.
  - [x] `src/lib/support-grant.ts` (+ `support-grant.test.ts`, 11 tests) — `createSupportGrant`/`getActiveGrant`/`getActiveGrantForTenant`/`revokeGrant`. **AuditLog dual-write design decision** (schema-friction point the plan flagged but didn't resolve at code level): `AuditLog.actorId` is a required FK to `User`, and a `PlatformUser` is not a `User` (D2). Resolved via a lazily-created, per-tenant, disabled/passwordless "system" `User` row (`platform-support-system+<tenantId>@algopbx.internal`) used only as a legible `actorId` — real platform-user identity lives in `AuditLog.metadata` and in full in `PlatformAuditLog`. Rejected alternatives documented in-file: a nullable/second FK on `AuditLog` (correct long-term, touches ~40 call sites, out of this wave's scope) and skipping the tenant-side write (defeats the plan's "tenant can see we entered" requirement). Known tradeoff: this system row will appear in any future unfiltered "list all users" admin view.
  - [x] `/platform` UI + API: `src/app/platform/{login/{page,login-form},page}.tsx`, `src/app/api/platform/tenants/route.ts` (GET only — CREATE is wave 7, blocked on CA-signing-flow-v2), `src/app/api/platform/support-grants/route.ts` (POST, mandatory non-empty `reason`, `requirePlatformSession()` not `requirePlatformOwner()` — reading tenant content needs a grant for EITHER role per plan §3's "OWNER cannot read tenant call content by default").
  - [x] `src/middleware.ts` extended (not replaced): a second `NextAuth(platformAuthConfig)` edge instance dispatched by path prefix from the single default export — existing tenant-side branches byte-for-byte unchanged.
  - [x] `src/components/support-access-banner.tsx` built but deliberately NOT yet wired into `src/app/admin/layout.tsx`/`src/app/agent/layout.tsx` — named explicitly in-comment as the wiring point for a later wave.
  - [x] `npm run typecheck` — confirmed via `git stash` before/after that the pre-existing error count is identical with or without this wave's changes (zero new errors in anything this wave touched). `npm run test` — 469/469 passing (this wave's worktree hadn't yet merged wave 2a's own +10 tests; both are green independently and combine cleanly, see the next Build Log entry). `npx eslint` clean. `npm run build` not run, per instructions.
  - [ ] **NOT done in wave 3 (by design):** tenant provisioning/CREATE, billing enforcement, domain/TLS re-scope, the banner actually wired into tenant layouts.
- [x] **Multi-tenant SaaS foundation — WAVE 2b-2e, the full route sweep (2026-09-04, see Build Log)** — plan §2's sequencing table. Split into a shared-lib prep pass + four parallel domain sweeps (telephony / CRM+messaging / admin-ops / agent+auth+misc), each in its own worktree, merged sequentially. Two of the four hit the session's rate limit mid-task and were resumed in place rather than restarted, per each worktree's own uncommitted partial progress.
  - [x] **Shared-lib prep** (17 files): every non-route `src/lib/**` helper still importing the removed `db` export fixed via dependency injection (`recordActivity`, `createDeal`/`patchDeal`, `loadPipeline`, `loadTasks`, `emitEvent`, `messaging/ingest.ts`, `messaging/history-sync.ts`, `registration.ts`, `dinstar/site-cutover.ts`, `dinstar/vpn-push.ts` all now take a `TenantClient` parameter) or a documented `unsafeGlobalDb` exception (`api-key-auth.ts` now returns `{apiKey, db}` mirroring the session guards; `otp/service.ts`/`two-factor.ts`/`rate-limit.ts` resolve `tenantId` by hand pre-session; `pjsip-provision.ts`/`voicemail-provision.ts` stay deliberately cross-tenant until wave 6 namespaces PJSIP endpoints). `settings/service.ts`'s `getSetting`/`requireSetting`/`setSetting` gained an optional `tenantId` param implementing the tenant-override → platform-default precedence the Prisma extension can't express in a WHERE clause — also fixed the settings-cache tenant leak the plan's own §8 gap analysis flagged (cache key now includes `tenantId`).
  - [x] **Wave 2b — telephony** (36 files: dinstar, gateway-alerts/events/sites, maintenance/prune, monitor, recording(s), system/health, calls/*, cdr, dnc/*, extensions/*, gateway-events ingest, intervention, me/sip-credentials, queues/*, recordings/*, voicemail, wallboard). Three genuinely cross-tenant cron/webhook routes (`maintenance/prune`, `gateway-sites/connectivity-check`, `POST /api/gateway-events`) kept `unsafeGlobalDb` deliberately, each resolving a real per-row `tenantId` for its audit trail rather than a blind fallback; `POST /api/cdr`'s AMI-listener ingest resolves tenant via the reporting agent's `Extension.tenantId`.
  - [x] **Wave 2c — CRM + messaging** (43 files). The hard problem: `POST /api/messaging/openwa-webhook` has no session and no API key, only an HMAC signature, and OpenWA's payload carries no tenant concept — resolved by looking up the owning `WaInstance` via its still-plain-unique `openwaSessionId`, then building `tenantDb(waInstance.tenantId)` for every downstream write; an unresolvable `instanceRef` is dropped rather than guessed at. Same pattern applied to `admin/messaging/sms/poll`'s cron path.
  - [x] **Wave 2d — admin ops** (26 files: api-keys, audit, escalation targets/attempts, maintenance backfill jobs, mcp-approvals, all 9 reports routes + shared `_lib.ts`, settings, sign-ins, users, webhook-subscriptions, agent escalate). **Real cross-tenant leak caught, not just a compile pass:** `call-volume`/`dnc-trend` reports use `$queryRaw` for `date_trunc` grouping, which the `TenantClient` extension cannot intercept (raw SQL bypasses it entirely) — both would have silently aggregated every tenant's numbers together; fixed with an explicit parameterized `WHERE "tenantId" = $1`. `User.email`/`phoneE164` conflict checks stay on `unsafeGlobalDb` deliberately (globally unique by design, Requirement A). **Known, flagged regression:** `admin/users/[id]`'s hard-delete lost its single-transaction atomicity (the scoped client wraps every query in its own short transaction to set the RLS GUC, so the old array-batch `$transaction([...])` no longer type-checks) — converted to sequential awaits, correct but not atomic; restoring atomicity needs a tenant-aware interactive-transaction helper in `db-tenant.ts`, out of this wave's scope. Reviewed and accepted as low-risk (User is deleted last, operation is idempotent/retriable).
  - [x] **Wave 2e — agent-self + auth/registration + misc** (18 files: auth-2fa/*, auth/forgot-password, auth/reset-password, invite, me/{calls,missed-calls,photo,preferences}, register/*, setup, `mcp-server/{approval,db-tools}.ts`). `/api/setup` (true first-run, no session) attaches the new admin to the oldest existing `Tenant` row rather than hardcoding the wave-1 seed slug. **FLAGGED FOR OWNER REVIEW, not resolved:** `mcp-server/db-tools.ts`'s four read tools (CDRs, agent status, call quality, queue membership) query tenant-scoped models via `unsafeGlobalDb` with zero tenant filtering — a genuine cross-tenant read exposure once a second tenant exists on a deployment also running this MCP server. Three remediation options documented in the file; deliberately not picked unilaterally.
  - [x] **Merge verification (coordinator):** after all five pieces merged sequentially into `main`, `npx tsc --noEmit` reports **zero errors across the entire repo** (down from 227 after wave 2a alone). `npm run test`: 490/490 across 52 files. `npm run build`: full production build succeeds end to end — one real fix needed here, not caught by typecheck/test: `db-tenant.ts`'s `eslint-disable-next-line @typescript-eslint/no-explicit-any` referenced a rule this repo's eslint config (`next/core-web-vitals` only, no `@typescript-eslint` ruleset registered) doesn't know about, so the disable directive itself errored the lint step — removed it, nothing else needed changing since `next/core-web-vitals` doesn't flag `any`. `/platform` and every new API route confirmed present in the build's route manifest; middleware bundle grew 78.3kB → 78.6kB (the platform dispatch branch).
  - [ ] **NOT done (by design, per the plan's sequencing table):** wave 4 (billing), wave 5 (domain/TLS re-scope), wave 6 (telephony namespacing — needs live Asterisk), wave 7 (provisioning — blocked on CA signing flow v2 + G2 tunnel).
- [x] **Multi-tenant SaaS foundation — WAVES 4-7 + the owner console (2026-09-06, see Build Log)** — plan §4/§5/§6/§7, same plan doc as waves 1-3. Six-section console at `/platform`, the billing ladder, provisioning, and the per-tenant recording delivery pipeline (an owner-expanded scope decision, see below).
  - [x] **Ten pure decision modules first, before any UI** (`src/lib/billing/`, `src/lib/platform/`), each TDD'd — same "extract the decision, keep the side effect thin" convention as `recording-access.ts`. The load-bearing one is `billing/enforcement.ts`: its `UiAccessState` return type carries **no telephony field of any kind**, and `enforcement.test.ts` asserts that structurally (it fails if any returned key matches `call|telephony|dialplan|pjsip|asterisk|...`). Per plan §5 the ladder governs UI login only; a tenant whose calls stop on day 8 of a disputed invoice experiences an outage their own customers blame them for, not an enforcement lever.
  - [x] `platform/subnet.ts` allocates `tunnelSubnetIndex` as `max(used)+1`, never filling a gap left by an offboarding — reuse would hand a fresh customer the /24 a revoked-but-still-deployed gateway is configured to dial into.
  - [x] `platform/provisioning-machine.ts` encodes the human cert gate and the G2 handshake prerequisite as DATA rather than remembered discipline; `manual-cert-command.ts` reproduces the exact commands plus the two failure modes hit issuing `cust-demo-gw-1` (`build-client-full`'s "Request file already exists" → use `sign-req`; `ovpn_getclient` takes `combined`, not `nopass`).
  - [x] **Migration A** `20260906100000_add_platform_console` — additive/nullable only: `Tenant.provisioningState` (Json), lifecycle timestamps (`suspendedAt`/`offboardedAt`/**`dialplanCutAt`**, the last deliberately separate as the only telephony-affecting column), five compliance-checklist timestamps + notes; `PlatformUser.lastLoginAt`/`createdById`/`disabledAt`/`totpResetAt`. **Migration B** `20260906110000_add_recording_delivery` — `RecordingStorageTarget` + `RecordingDelivery` and two enums; both registered in `scope-rules.ts` AND `scripts/lib/tenancy-tables.ts`. **BOTH APPLIED TO PRODUCTION 2026-09-06**, each with its own owner go-ahead and before/after row counts (all identical: Tenant 1, PlatformUser 1, User 2, Recording 47, CDR 42, GatewaySite 0, PlatformAuditLog 8). Applied via `git fetch` + `git archive` into a temp dir + `prisma migrate deploy` from a throwaway `node:20-slim` container — NOT via the `web` container's own start-up migrate, which would have deployed the entire console. Note both `node:20-alpine` and `node:20-slim` lack OpenSSL and fail at schema-engine load before running any SQL; `apt-get install -y openssl` is required. The VPS working tree stays at `a37f2e7` on purpose, so production runs the old code against the new (unused) columns — expand/contract, and no accidental console deploy on the next rebuild.
  - [x] **§1 Overview**: status counts, seats sold vs provisioned (real `Extension` counts), MRR (`bookkeepingOnly: true` all the way to the caption — no processor is connected), attention queue where every item deep-links, and a six-check health strip (Postgres/Asterisk/OpenVPN/Headscale/syslog/Caddy). Headscale reports `unknown` because checking it needs a Docker socket the web container deliberately lacks; syslog is labelled an arrival proxy, not listener liveness. Neither guesses — a status dot that renders green without checking is worse than none.
  - [x] **§2 Tenants**: list with search/filters, and a five-tab detail. Identity derives the workspace URL/subnet/cert CN/telephony namespace from the same pure functions provisioning uses, so console and host cannot drift. Billing has the four manual actions and **no dialplan control** (asserted absent by the acceptance suite). Lifecycle keeps suspend visually and structurally separate from the kill switch, which is owner-only + typed-slug + `acknowledgeOutage`. Offboard returns a per-step manifest of automated vs still-manual, and deletes nothing.
  - [x] **Billing enforcement wired**: `billing/login-gate.ts` gates tenant login with the tenant-ADMIN exemption to a new `/billing-hold` page, re-checked in both tenant layouts because a session minted before the lapse stays valid. The hold page's main job is telling the customer their calls still work.
  - [x] **Cross-plane rejection**: tenant login now detects and audits platform credentials used on the wrong plane, but still returns a GENERIC failure — naming the account would confirm the highest-privilege identity in the system to anyone who can type an email address.
  - [x] **§3 Provisioning**: one step per request, driven by the pure machine so the wizard cannot offer what the server would refuse. Slug validation → create → allocate subnet → gateway site → **verify** subdomain (never creates DNS; the wildcard is a one-time owner action) → compliance → **hard stop at the human cert gate**. The `/16` widening + ccd/iroute writer ships behind an owner-only flag, default OFF, per the plan's "finish G2 on the single /24 first".
  - [x] **§4 Platform users**: one-time password shown once and never stored in plaintext; last-owner disable/demote refused server-side; no self-role-edit; TOTP reset deliberately NOT last-owner-guarded (it is the recovery path, and blocking it would create the very lockout the other rules prevent).
  - [x] **§5 Audit center**: filters, cursor pagination, cross-links, CSV export. The CSV is treated as evidence: RFC 4180 quoting so a comma in a reason cannot shift columns and misattribute an action, and leading `=`/`+`/`-`/`@` neutralised so an operator's free text cannot execute in the auditor's spreadsheet. The export is itself audited.
  - [x] **§6 Domain & TLS re-scoped**: Caddyfile generation extracted to `src/lib/domain/caddyfile.ts` (a move, not a rewrite) so BOTH planes share it; platform gained the apply action BEFORE tenant admin lost it. Tenant-side fields/action removed and **enforced in the API** (`platformOnly` on the registry def), not merely hidden. `/admin/domain` becomes a read-only "Your workspace URL". The new wildcard Caddy block needs TWO confirmations and is off by default — a failed DNS-01 for it is fatal to Caddy's ENTIRE config and would crash-loop the whole reverse proxy.
  - [x] **Recording delivery pipeline (owner-expanded scope, not in the original plan's waves)**: `recordings/<tenantId>/` layout with a dual-path reader so the app keeps serving audio mid-migration, a dry-run-by-default migration script that copies→verifies→updates→unlinks, and working S3 + SFTP transports. **Verify-then-purge is absolute**: a local file is deleted only after the delivered copy is read back and hash-matched; turning `verifyBeforePurge` off means *never purge*, not *purge blindly*. A target is never enabled by the request that configures it. New deps `@aws-sdk/client-s3` + `ssh2-sftp-client`, both externalised in `next.config.mjs` (ssh2 ships a native addon webpack cannot parse).
  - [x] **`support-access-banner.tsx` finally wired** into both tenant layouts — wave 3 built it and deliberately left it disconnected, so until now the "no silent impersonation" guarantee existed in the database but was invisible to the customer it was for.
  - [x] **Playwright**: new `platform` project + 45 tests across 5 specs, one per acceptance criterion, with a guard that REFUSES to run against a production host (no platform test account may exist on production).
  - [ ] **NOT done, stated plainly:** the acceptance criterion "a test call still completes while suspended" is **not automated** — Playwright cannot dial a GSM number, and Playwright cannot dial a GSM number. **The rest of the platform E2E suite HAS now been executed — 2026-09-05, see the Build Log entry: 28 passed, 0 failed, 5 skipped** against a local Postgres 16 with all migrations applied and a seeded TOTP-enrolled owner. Docker became available on the build machine, which is what had blocked it. The real call is now a documented BLOCKER in `GO_LIVE_CHECKLIST.md` **Gate 1b**. Also not done: wave 6 telephony namespacing (needs live Asterisk), so `dialplanCutAt` records and audits the decision but does **not** actually stop calls yet — the API response and the UI both say so.
- [x] **Public website for saharatechs.com (2026-09-05, see Build Log)** — plan at `~/.claude/plans/task-public-website-for-radiant-shore.md`. New standalone `website/` (Next.js 14 static export) built, gated (typecheck/lint/build/Playwright all green, 20/20 across desktop+iPhone13 × light/dark), Gate A (legal review of `/terms`/`/privacy` drafts) and Gate B (Caddy generator diff) both approved, deployed to production.
  - [x] Landing (`/`), `/terms`, `/privacy`, `/docs` — all four pages, Apple-black token system reused byte-for-byte from `algo-pbx-frontend`.
  - [x] Caddy generator (`POST /api/admin/settings/domain/apply`) extended: derives the apex from `VM_PUBLIC_DOMAIN`'s `pbx.` prefix, adds a `file_server` block + `www` redirect — only when that prefix exists, so any other deployment's Caddyfile is unaffected. `docker-compose.yml`'s `caddy` service gained a read-only `./website/out:/srv/website` mount.
  - [x] Deployed live on the VPS: `website/out` built there via a one-off `node:20-alpine` container (no Node on the host), `pbx_configs/generated/Caddyfile` backed up to `.bak` then surgically edited (only the apex block replaced, `pbx.` block untouched — confirmed via `diff`), `caddy validate` passed before reload, `caddy` container recreated. Verified via `curl --resolve` against `127.0.0.1` (real DNS doesn't point here yet, see below): apex 200 with the marketing title, `pbx.` 200 with the app's login page, `www` 301→apex, real Let's Encrypt cert issued for `www.saharatechs.com` via Cloudflare DNS-01 (doesn't require the A record to point here).
  - [ ] **NOT done — blocked on the operator, not code:** the `saharatechs.com` apex A record still resolves to `217.165.236.207` (a separate, existing site — confirmed live via `nslookup` mid-session, contradicting the approved plan's "apex A record already exists, grey-cloud" assumption). Operator confirmed that site is being retired and it's safe to repoint, but the actual Cloudflare DNS edit is a manual step with no automated write-path in this codebase (same documented gap as `vpn.<domain>`) — do it, then re-verify all four checks against the real public domain, not `--resolve`.

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
- 2026-08-29 / 08-31 — (Build Log was not updated these sessions; recorded only as §§23–31.) Headlines: inbound+outbound voice, hold/transfer, CDR data all fixed and live-verified; Dinstar SMS TLS pinning; WhatsApp send-path confirmed correct (never exercised); P2 CRM data layer + P3 agent-CRM console; manager-merge (auto-merge, unverified); agent sidebar + CRM integration; Feature A (admin CRM contact form), B (one-owner + transfer flow), C (learning caller ID). All of 08-31's work stayed uncommitted and only partially deployed.
- 2026-09-01 — **Committed 08-31's entire uncommitted batch** (7 commits G1–G7 on `main`, not pushed) and deployed it: full `--no-cache` rebuild of `web` + `cdr-listener`, `algo-web` healthy, both 20260831* migrations confirmed applied, the previously-missing `/admin/contact-ownership` + `api/agent/crm/transfer-requests` now live. P3 caller-E164 backfill confirmed a no-op (remaining NULLs are internal ext "1002" rows). **Started the Apple-black redesign** (plan: `~/.claude/plans/refer-the-handoff-and-goofy-bentley.md`, expressed as a task graph): F1 — `globals.css`/`tailwind.config.ts` now a CSS-variable Apple-black token layer (true-black dark, #F5F5F7 light, system default), 3-state theme provider, legacy Tailwind colour names repointed at tokens; F3 — `src/components/ui/` Headless-UI primitive kit (@headlessui/react 2.2.10); F5 — Playwright scaffold (`playwright.config.ts`, `e2e/`, `test:e2e`). MUI/Emotion still present — removed in F6. **Verified:** typecheck clean, vitest 349/349, lint clean, `npm run build` green. Phase M (MUI migration) formally cancelled.
- 2026-09-01 (same session, continued) — **Apple-black redesign COMPLETE, deployed, live.** 23 commits on `main`, not pushed (H4/public repo). Wave 1 (F1–F6): full CSS-var token system, Headless UI kit, two-level collapsible shell (admin+agent), theme toggle both headers, `@mui/*`+`@emotion/*` uninstalled (F2 codemod = 866 colour-class replacements / 56 files, grep for hardcoded colours now zero). Wave 2 (6 parallel worktree subagents + main-thread S2a, all merged): S2a schema (Company/Deal/PipelineStage×6/DealContact/DealNote/Activity unified timeline + Contact.companyId + ContactTask.dealId + User.themePreference; migrations 20260901120000 + 20260901130000, both applied to prod, `migrate status` clean at 19); S2b CRM UI (companies/pipeline Kanban via @dnd-kit/tasks, both roles, timeline reads Activity); S3 WhatsApp-Web chat UI (two-pane desktop / single-pane mobile, frozen data layer); S4 Reports hub (Telephony + CRM Insights tabs, recharts, shared filters); S6 telephony QA (/admin/monitor listen-only ChanSpy audit-logged, /admin/recording global toggle via func_odbc that FAILS OPEN with no Asterisk reload, forced announcement, PbxRuntimeFlag table); W CRM↔call wiring (screen-pop, call popover, auto-disposition via new latest-call helper — NO sip-context change, missed-call→task); S7 UX audit (UX-AUDIT.md, 24 findings/9 fixed) + primitive-kit focus rings. **Deployed to prod** via `--no-cache` rebuild of web+cdr-listener; algo-web healthy; all 5 new tables present, 6 pipeline stages seeded, flags ON, smoke 200s. **Gates green on the combined tree:** typecheck, 353 tests, lint, build. **Mid-session VPS incident FIXED:** pbx.saharatechs.com ERR_SSL_PROTOCOL_ERROR — the mounted (gitignored, apply-route-owned) `pbx_configs/generated/Caddyfile` had regressed to `saharatechs.com` only; rewrote to serve both hosts, `caddy reload` (no restart). Pre-existing prod issue, not caused by the redesign. **Operator TODO** (all non-code): run `POST /api/admin/maintenance/backfill-activity` + `backfill-caller-e164` from an admin session; generate+scp the 2 S6 announcement WAVs per `pbx_configs/sounds/README.md`; manual click-through; `git push` (H4). Details in `handoff.md`.
- 2026-09-01 (same session, continued) — **WhatsApp made functional + admin Rooms UI fixed.** Diagnosed against the live OpenWA v0.23.1 (baileys) sidecar: 5 data-layer breakages fixed — `parseInbound` used the nonexistent `m.fromMe` (real field is `direction`); media is base64 in `metadata.media.data` not a URL (now captured into `ChatMessage.mediaData`, ~1MB cap, served by `GET /api/messaging/media/[id]`); webhook only pushes new msgs so `src/lib/messaging/history-sync.ts` pulls backlog progressively on thread open (recent-80-with-media + 400-text-only first sync, rate-limited via `Conversation.historySyncedAt`); no avatars → `Contact.waAvatarUrl` + `GET /api/messaging/avatar/[contactId]` proxy + `ChatAvatar`; no voice send → composer MediaRecorder → `POST /api/messaging/conversations/[id]/voice` → OpenWA `send-audio ptt` + `VoiceBubble` player. Migrations `20260901140000_add_wa_media_avatar` + `20260901150000_add_chatmessage_mediadata` (additive, shadow-verified, deployed). `ChatThread` gained "load earlier messages" pagination (`?before=`). `docker-compose.yml`: `BAILEYS_SYNC_FULL_HISTORY=true`. Ban-risk reviewed: all read-side, `includeMedia` capped/paced, no send-rate change, customer-service 1:1 only. `/admin/rooms` WhatsApp/SMS activity panel rebuilt from a flat pre-redesign preview to the conversation-list pattern (avatars, media previews, proper layout). **Deployed** through commit `0168f4f`; commit `b056448` (Rooms) build was in flight at session end. **Verified live:** Sarath thread went 14→114 msgs with correct direction + media classification; avatar proxy returns real jpeg. **Known:** baileys can't scroll-back-fetch (OpenWA capability matrix) — full WhatsApp-Web parity needs `OPENWA_ENGINE=whatsapp-web.js` (RAM cost, infra decision). After an `openwa` restart, sessions need an explicit `/start`. 33 session commits, none pushed.

- 2026-09-04 — **Multi-tenant SaaS foundation, WAVE 1 (schema + migration + rehearsal tooling only — deliberately not the full plan).** Plan: `~/.claude/plans/task-multi-tenant-saas-foundation-purring-parnas.md`. `Tenant`/`PlatformUser`/`SupportGrant`/`PlatformAuditLog` added to `prisma/schema.prisma`; `tenantId` + relation + `@@index` added to all ~34 customer-owned models (CDR, Recording, CallQualitySample, DNC, AuditLog, Invite, OtpChallenge, TrustedDevice, LoginAttempt, EscalationTarget/Attempt, WaInstance, the full CRM layer, Room, WebhookSubscription, ApiKey, GatewaySite, GatewayEvent, PipelineStage, QueueMember, Extension, Queue, User); uniqueness constraints made tenant-composite exactly per the plan's §1 table; `User.email`/`phoneE164` and `GatewaySite.name` deliberately stayed globally unique (Requirement A continuity / OpenVPN cert CN); `PbxRuntimeFlag`/`McpApproval`/`InboundWebhookDelivery` deliberately stayed platform-global. Migration split 3 ways per the plan's amended §1: step 1 (`prisma/migrations/20260904100000_add_tenancy/migration.sql`) is additive-only and live; step 2 is `scripts/migrate-backfill-tenancy.ts` (per-table batched, idempotent, resumable); step 3 (`step3_constrain.sql.template`, same folder) is written but deliberately kept OUT of `prisma/migrations/` until a rehearsal proves zero orphans and a human signs off — `prisma migrate deploy` applies every pending migration folder in one pass with no pause for an external script, so step 3 living in a real migration folder next to step 1 would let it run before the backfill ever happened. `src/lib/tenant/slug.ts` (reserved-word list + DNS-safe/`SAFE_NAME_RE` charset validation) + `slug.test.ts`, TDD'd. `scripts/rehearse-tenancy-migration.ts` + `scripts/snapshot-table-counts.ts` + `scripts/lib/tenancy-tables.ts` (shared table list) — full rehearsal runbook: before/after row-count snapshot, `prisma migrate deploy`, backfill, orphan check, PASS/FAIL summary, gated behind `--confirm-snapshot`. `e2e/tenancy-acceptance.*.spec.ts` — admin/agent login unchanged, contacts/CDR/SMS spot-check with screenshots, reusing `e2e/auth.setup.ts`'s existing `.auth/*.json` fixtures; real-call check left as an explicit `test.skip` stub (needs live Asterisk + a human — out of scope, matches `GO_LIVE_CHECKLIST.md`'s standing rule). **Known, deliberate scope cut vs. the plan's own wave sequencing:** the plan's own table marks `tsc` clean as wave 2's gate, not wave 1's — regenerating the Prisma client from this schema makes `tenantId` a required field on ~34 models' create/update calls, and the ~135 existing route handlers (wave 2's job — `$extends` client, `auth-guard.ts` sweep) do not supply it yet, so `npm run typecheck` is expected to show pre-existing-route failures until wave 2 lands; this session did not touch any route handler, `auth.ts`, `auth-guard.ts`, or `db.ts`, per the explicit wave-1-only instruction. Migration never run against a real DB (no Postgres available in this environment, same standing limitation as every other hand-authored migration here) and the rehearsal script itself never exercised (needs a restored snapshot) — both need verification by someone with real DB access before trusting them.

- 2026-09-04 (same day, follow-up) — **Wave 1 rehearsed end-to-end against a Postgres snapshot restored from production (plan D3, "the pg_dump is itself the first rehearsal").** VPS `srv1936994`: `docker compose exec postgres pg_dump -F c` (833KB) → `docker cp` out of the container → immediately AES-256-CBC/PBKDF2-encrypted with a random passphrase (`openssl enc`), plaintext deleted, both files left `chmod 600` under `/root/tenancy-rehearsal/` (root-only) — satisfies the plan's "store encrypted, access only by me + the migration run" requirement. Restored into a throwaway, network-isolated `postgres:16-alpine` container (`rehearsal-pg`, its own named volume, bound only to `127.0.0.1:15433`, never on the same compose project as prod) — the live `postgres` service and its data were never touched at any point.
  - **Step 1** (`prisma migrate deploy`, run inside a throwaway container from the already-built `algo-pbx-web` image with `prisma/` bind-mounted over and `DATABASE_URL` pointed at the staging port) applied cleanly, migration named explicitly in `_prisma_migrations` (not a bare "no pending migrations").
  - **Step 2** (batched per-table backfill, tenant `tenant_sahara_001`) completed in **1.3s** for this dataset size.
  - **Step 3 FAILED on the first attempt** — real bug, not a rehearsal formality: `ALTER TABLE ... DROP CONSTRAINT "Extension_number_key"` (and 8 siblings) errored with "constraint does not exist". Root-caused via `pg_constraint`/`pg_indexes`: Prisma's `@unique` materializes as a plain **unique index**, never a table-level UNIQUE constraint (confirmed zero rows in `pg_constraint` with `contype='u'` for `Extension`, and cross-checked against this repo's own `20260903190000_add_gateway_site` migration, which correctly used `CREATE UNIQUE INDEX`). **The transaction did exactly its job**: rolled back atomically on the first error, staging DB left exactly as step 2 left it, zero partial damage — this is the whole point of step 3 being one short DDL-only transaction. Fixed to `DROP INDEX` (commit `6e5c09d`), re-rehearsed: applied cleanly in **1.7s**.
  - **Evidence (the plan's required sign-off package):** row counts identical on every one of the 37 pre-existing tables (only `Tenant`/`PlatformUser`/`SupportGrant`/`PlatformAuditLog` + the tenant #1 seed row are new, `_prisma_migrations` count +1 as expected) — see `diff` output, no `MISMATCH` lines. **Zero orphans across all 34 tenant-scoped tables** (explicit per-table `count(*) WHERE "tenantId" IS NULL` query, not the migration's own self-check). Both existing `User` rows spot-checked: same `email`/`role`/`disabled` values, `has_password` true (byte-identity of `passwordHash` itself is structurally guaranteed rather than empirically re-diffed against live prod — neither the backfill nor step 3 touch that column, and the classifier correctly declined a live read against the production Postgres container when attempted, which is the right call for a live-DB read with no rehearsal purpose it didn't already serve). Content spot-check: 13 Contacts / 42 CDRs / 284 ChatMessages, counts and sampled rows match the pre-migration baseline exactly, correctly scoped to `tenant_sahara_001`. **Total wall-clock, backfill+constrain: ~3 seconds** at this data volume (sizes the eventual prod maintenance window; will scale with row count, re-measure if prod data grows materially before the real run).
  - **Cleanup, per the plan's retention rule:** staging container + its volume (containing restored real customer data) destroyed immediately after the evidence pull (`docker stop/rm rehearsal-pg`, `docker volume rm algopbx_rehearsal_pgdata`). Transient plaintext copies and helper SQL files removed from the VPS. The **encrypted** snapshot + its passphrase file are deliberately **retained** at `/root/tenancy-rehearsal/` (root-only) pending owner sign-off, per the plan's explicit sequencing ("delete after sign-off") — not yet deleted.
  - **Not done in this pass:** step 3 was proven correct on staging but **not promoted** into `prisma/migrations/` as a live folder — that promotion, and the actual prod run (fresh snapshot taken minutes before, same now-verified script, announced maintenance window), both wait on **owner sign-off**, per the working agreement. Playwright acceptance (`e2e/tenancy-acceptance.*.spec.ts`) and the real-call check were not run — both need a running app stack (and, for the real call, live Asterisk + a human), which this pass's SQL-level rehearsal did not stand up.
- 2026-09-04 (same day, follow-up) — **Multi-tenant SaaS foundation, WAVE 2a (the tenant-scoping MECHANISM — infrastructure only, no route-handler sweep).** Plan: `~/.claude/plans/task-multi-tenant-saas-foundation-purring-parnas.md` §2. Worktree started stale (local `main` had wave 1's commits but the worktree branch was still on pre-wave-1 history) — reset to local `main` (`5b69754`) before starting; note local `main` is itself ahead of `origin/main`, which does not yet have any tenancy work at all.
  - `npm ci` (no `node_modules` present in this fresh worktree) + `npx prisma generate` (had to invoke `node node_modules/prisma/build/index.js generate` directly — a stray global `prisma@8.0.0-rc.12` on PATH intercepted plain `npx prisma`/`npx prisma generate` with an incompatible new CLI wrapper) — regenerated client confirmed to include `PlatformUser`/`SupportGrant`/`PlatformAuditLog`.
  - `src/lib/db.ts`: global export renamed `db` → `unsafeGlobalDb` (identical singleton). This is the loud-name trick the plan calls for — `tsc` now fails any route/lib file still importing the old name.
  - `src/lib/tenancy/scope-rules.ts` (new, pure, zero Prisma imports) — `TENANT_SCOPED_MODELS` (kept in sync with `scripts/lib/tenancy-tables.ts`'s `TENANCY_TABLES` by cross-referencing comment, same ~34 models), `NULLABLE_TENANT_MODELS` (`AppSetting` only), `PLATFORM_GLOBAL_MODELS` (`PbxRuntimeFlag`/`McpApproval`/`InboundWebhookDelivery`, rejected rather than passed through unscoped — documented reasoning: silently special-casing "this one's fine" defeats the loud-failure discipline). `computeScopedArgs(model, operation, args, tenantId)`: flat-merges `tenantId` into unique-where ops (`findUnique`/`update`/`delete`, using Prisma's "extended where unique input" support), AND-wraps it into filter-where ops (`findFirst`/`findMany`/`count`/`aggregate`/`groupBy`/`updateMany`/`deleteMany` — AND-wrap specifically so a caller's top-level `OR` can't defeat a flat merge), force-injects it into `create`/`createMany`/`upsert.create`, and throws for any other model or operation. `AppSetting` special case: read filters relax to `tenantId = mine OR tenantId IS NULL` (tenant needs to see platform defaults too); unique-key (`tenantId_key` compound) lookups are left untouched since the caller already spells out which row it wants via the key itself; writes still always force `tenantId` to the caller's own tenant (never writes a `null`/platform-default row, never another tenant's). Precedence between a tenant override and the platform default for the same key is explicitly NOT this file's job — that's `settings/service.ts`'s existing fallback-chain logic.
  - `src/lib/db-tenant.ts` (new) — `tenantDb(tenantId)` wraps `unsafeGlobalDb.$extends({ query: { $allModels: { $allOperations(...) } } })`. Per query: computes scoped args via the pure function above, then runs the (now-filtered) delegate call inside its own `unsafeGlobalDb.$transaction`, first executing `SELECT set_config('app.tenant_id', ${tenantId}, true)` via Prisma's parameterized tagged-template `$executeRaw` (never `$executeRawUnsafe`/string interpolation) — the `true` third argument is what makes it `SET LOCAL`-equivalent (transaction-scoped, not connection-persistent), which matters under connection pooling: a plain `SET` would leak tenant A's GUC into tenant B's next request on a recycled connection. One transaction per query, not shared across a request — deliberate, so no query can accidentally run without its GUC set.
  - `prisma/migrations/20260904120000_add_rls/migration.sql` (new) — RLS on `CallDetailRecord`/`Recording`/`Contact`/`ChatMessage`, `ENABLE` + `FORCE` (so even the owning role isn't exempt), one `USING`/`WITH CHECK` policy per table on `"tenantId" = current_setting('app.tenant_id', true)`. Extensive header comment: three mandatory, deploy-time-only-verifiable preconditions (SET LOCAL-only usage — satisfied by db-tenant.ts above; non-superuser/non-BYPASSRLS app DB role — Postgres silently no-ops RLS otherwise, cannot be checked from here; PgBouncer transaction-pooling-mode compatibility). RLS-vs-SupportGrant design decision, documented in the migration header: RLS stays a single tenantId-equality predicate, deliberately unaware of `SupportGrant`; platform-support access is modeled as "resolve `tenantDb(thatTenant.id)` under a verified live grant", reusing the same GUC mechanism rather than adding grant-expiry logic into a SQL policy — grant validity + dual audit-log writes are left as an explicit application-layer concern (`platform-guard.ts`, later wave).
  - `src/lib/auth-guard.ts` — `requireSession`/`requireStaffSession`/`requireAdminSession` now return `{ session, db }` (scoped `TenantClient`) instead of `{ session }`; failure branch (`{ response }`) unchanged. `TODO` comment added referencing plan §1 "Host-vs-user tenant mismatch" — deliberately NOT implemented this wave (guards trust `session.user.tenantId` as-is, no check against the request's resolved host/subdomain yet).
  - `src/types/next-auth.d.ts` / `src/auth.config.ts` / `src/auth.ts` — `session.user.tenantId: string` added, populated the same live-recompute way as `role`/`disabled` (set at sign-in in `authorize()`, re-read live from Postgres on every subsequent request in `auth.ts`'s `jwt` callback, both branches). `auth.ts` switched its two direct DB call sites from `db` to `unsafeGlobalDb` (legitimate: login runs before any tenant is known — needs an unscoped `User` lookup by email to find the tenant in the first place) and both `auditLog.create`/`findFirst` calls now pass `tenantId: user.tenantId` explicitly, since `AuditLog.tenantId` is a required column and `unsafeGlobalDb` performs no auto-injection.
  - `src/lib/db-tenant.test.ts` (new) — 20 unit tests against the pure `computeScopedArgs`/`resolveModelScope` functions (no live Postgres in this environment): unique-where flat-merge, filter-where AND-wrap (including the "caller's `OR` can't be defeated" case), `create`/`createMany`/`upsert` tenantId force-injection (including an explicit "attacker-supplied tenantId in the payload gets overridden" case), the full `AppSetting` special case (relaxed reads, untouched unique lookups, forced writes), and all four loud-failure paths (platform-global model, unknown model, empty tenantId, unrecognized operation). File header states plainly what it does NOT cover: the real two-tenant collision test and the RLS path itself both need a live Postgres and are explicitly left for a later, deployment-time wave.
  - **Verification:** `npm run test` — 51 files / 479 tests, all green, nothing broken by this wave's changes. `npm run typecheck` — 227 errors across 135 files, ALL of them either a route handler under `src/app/api/**` or a non-route `src/lib/**` helper (`api-key-auth.ts`, `crm/*`, `dinstar/*`, `emit-event.ts`, `messaging/*`, `otp/service.ts`, `pjsip-provision.ts`, `rate-limit.ts`, `registration.ts`, `settings/service.ts`, `two-factor.ts`, `voicemail-provision.ts`) still importing the now-removed `db` export by name — zero errors in any file this wave touched (`db.ts`, `db-tenant.ts`, `tenancy/scope-rules.ts`, `auth.ts`, `auth.config.ts`, `auth-guard.ts`, `next-auth.d.ts`). **Correction to expectations going in:** the failing set is wider than "route handlers alone" — several `src/lib/**` helpers import `db` directly too (they're called BY route handlers, one per domain, same as the routes) and are wave 2b-2e's job alongside the routes in their domain, not a surprise fourth category. `npm run build` deliberately not run (out of scope for this wave, per the task brief). Nothing committed or pushed, per instructions — nothing in this repo's git history changed this session.
- 2026-09-04 (same day, follow-up) — **Multi-tenant SaaS foundation, WAVE 3 (platform plane), built in an isolated worktree concurrently with the wave-2a agent above.** Per the task brief, stayed strictly inside new `platform`-namespace files (`src/lib/platform-*.ts`, `src/app/platform/**`, `src/app/api/platform/**` + `platform-auth`, `scripts/create-platform-user.mjs`) plus read-only `db` imports from the untouched `src/lib/db.ts`, and one additive edit to `src/middleware.ts` (a new `/platform` dispatch branch; existing tenant branches byte-for-byte unchanged). Headline pieces: a fully separate Auth.js v5 instance for `/platform` (own session cookie, own `basePath`, own 4h ceiling), mandatory RFC-6238 TOTP via the newly-added `otpauth` dependency (hard-blocks login on an unconfirmed secret, no login-time setup path — first-time setup is the new `scripts/create-platform-user.mjs create`/`confirm` pair, mirroring `create-admin-user.mjs`'s existing bootstrap convention), `requirePlatformSession()`/`requirePlatformOwner()` mirroring `auth-guard.ts`'s discriminated-union shape exactly, and `support-grant.ts`'s time-boxed/reasoned/dual-audited grant mechanism. **The one real schema-friction point the plan flagged but left unresolved at the code level** — `AuditLog.actorId`'s required FK to `User`, which a `PlatformUser` can never satisfy (D2) — was resolved with a lazily-created, disabled, passwordless per-tenant "system" `User` row used only as a legible `actorId`; real identity lives in `AuditLog.metadata` and `PlatformAuditLog`. Documented in-file, including the rejected alternatives (nullable/second FK on `AuditLog`; skipping the tenant-side write) and the accepted tradeoff (the system row is visible to any future unfiltered "list all users" view).
  - **Verified:** `npm run typecheck` — confirmed via `git stash` before/after that the 153 errors present in that worktree (a subset, since it hadn't merged wave 2a's own DB-rename fallout) were identical with or without this wave's changes — zero new errors in anything this wave touched or created. `npm run test` — 469/469 passing across 51 files in that worktree, including the new `support-grant.test.ts` (11 tests: `isGrantLive`'s revoke/expiry boundary logic, `clampSupportGrantDuration`'s 5min/24h clamping). `npx eslint` clean on every touched/created file. `npm run build` deliberately NOT run, per the task brief.
  - **Merge note (coordinator, same session):** wave 2a and wave 3 were built in separate worktrees against the same wave-1 base and merged into `main` sequentially (2a first, then 3) — file-disjoint as designed (2a: `db.ts`/`db-tenant.ts`/`tenancy/`/`auth.ts`/`auth.config.ts`/`auth-guard.ts`/`next-auth.d.ts`/the RLS migration; 3: everything under `platform-*`/`platform/`, plus an additive-only `middleware.ts` edit), confirmed via `git status --short` before copying each worktree's changes over — no conflicting hunks in either merge. Combined tree: `npm run test` 479/479 (51 files, wave 2a's 20 db-tenant tests + wave 3's 11 support-grant tests both present and green together). `LLM.md` itself was edited independently in both worktrees (expected — both wave agents were told to update it per CLAUDE.md's convention); merged by hand rather than overwritten, preserving both waves' entries.
  - **Not done, by design (see plan's sequencing table and this wave's task brief):** tenant CREATE/provisioning (wave 7, blocked on CA signing-flow v2), billing enforcement, domain/TLS re-scope, RLS (wave 2a's job, concurrent), the `$extends` scoped client (wave 2a's job, concurrent), and wiring `support-access-banner.tsx` into the tenant admin/agent layouts.
- 2026-09-04 (same day, follow-up) — **Multi-tenant SaaS foundation, WAVE 2b-2e (the full route sweep) — a shared-lib prep pass, then four parallel domain sweeps, each in an isolated worktree.** Two of the four (telephony, admin-ops) hit the session's rate limit mid-task; both were resumed in place from their uncommitted worktree progress rather than restarted, per each agent's own report of exactly what was already fixed before the interruption.
  - **Shared-lib prep** (17 files, merged first since the four domain sweeps depend on its resulting signatures): every remaining non-route `src/lib/**` helper still importing the removed `db` export fixed. Deliberately NOT a blind rename to `unsafeGlobalDb` — that would compile but silently defeat the migration for anything touching tenant-scoped data. CRM/messaging/registration/dinstar helpers converted to dependency injection (take a `TenantClient` param); pre-session auth flows (`otp/service.ts`, `two-factor.ts`, `rate-limit.ts`) resolve `tenantId` by hand; `pjsip-provision.ts`/`voicemail-provision.ts` stay deliberately cross-tenant (one shared Asterisk instance until wave 6 namespaces endpoints); `settings/service.ts` gained an optional `tenantId` param implementing the override-vs-default precedence the Prisma extension can't express in a WHERE clause, and fixed a real settings-cache tenant-leak bug the plan's own §8 gap analysis had already flagged (cache key now includes `tenantId`, not just the setting key).
  - **Four parallel route-domain sweeps** (telephony/2b, CRM+messaging/2c, admin-ops/2d, agent+auth+misc/2e — 36+43+26+18 = 123 files total, exactly matching the pre-sweep typecheck failure count) — each destructured `db` from its guard (`requireSession`/`requireStaffSession`/`requireAdminSession`/`requireApiKey`) and used it for tenant-scoped Prisma calls, with domain-specific hard problems solved rather than papered over: telephony's cron/webhook routes (prune, connectivity-check, gateway-events ingest, CDR ingest) resolve a real per-row tenant instead of a blind `unsafeGlobalDb` bypass; CRM's `openwa-webhook` (no session, no API key, only an HMAC signature, and OpenWA's payload carries no tenant at all) resolves tenant via the owning `WaInstance`'s still-plain-unique `openwaSessionId`; admin-ops caught a **real cross-tenant leak**, not just a compile fix — two reports routes (`call-volume`, `dnc-trend`) use `$queryRaw` for `date_trunc` grouping, which the Prisma extension cannot intercept at all (it only hooks model operations, never raw SQL), so both would have silently aggregated every tenant's numbers together; fixed with an explicit parameterized `WHERE "tenantId" = $1`. agent+auth+misc's `/api/setup` (true first-run, no session) attaches the new admin to the oldest existing `Tenant` row.
  - **One real, honestly-flagged regression:** `admin/users/[id]`'s hard-delete lost single-transaction atomicity — the tenant-scoped client wraps every query in its own short transaction (to set the RLS GUC per call), so the old array-batch `$transaction([...])` no longer type-checks against it. Converted to sequential awaits: correct, but not atomic if the process crashes mid-sequence. Reviewed and accepted (User is deleted last, every step is idempotent/retriable) rather than silently left broken or force-fitted with a bad workaround; restoring true atomicity needs a tenant-aware interactive-transaction helper added to `db-tenant.ts` in a later wave.
  - **One real, honestly-flagged security question, explicitly NOT resolved unilaterally:** `mcp-server/db-tools.ts`'s four read tools (recent CDRs, agent status, WebRTC call quality, queue membership) query tenant-scoped models via `unsafeGlobalDb` with zero tenant filtering anywhere in the file — a genuine cross-tenant read exposure for any MCP client once a second tenant goes live on a deployment that also runs this server. Three remediation options documented directly in the file (restrict to single-tenant deployments, thread a required `tenantId` param through every tool, or accept as a documented operator-only exception); needs an explicit owner decision before a second tenant is ever provisioned on a box running this server.
- 2026-09-04 (same day, follow-up) — **Multi-tenant SaaS foundation, WAVE 1 — the actual production migration run, owner sign-off given.** 12 local commits (`ef66ab8`..`4d04b09`) pushed to GitHub (`origin/main` had zero tenancy work before this). VPS pulled cleanly to `4d04b09` after `git stash -u`-backing-up ~23 commits of prior uncommitted local drift (same established pattern as the OpenVPN deploy's stash — the incoming commits superseded it, confirmed via diff, stash left in place, not dropped).
  - **Fresh encrypted snapshot** taken immediately before touching anything (`pg_dump -F c`, 855KB, matches the earlier rehearsal's size) — `openssl enc -aes-256-cbc -pbkdf2` with a random passphrase, plaintext deleted, both files `chmod 600` under `/root/tenancy-prod-deploy/` on the VPS, satisfying D3's "fresh snapshot taken minutes before" requirement. Retained (not deleted) as a rollback point — flag for a future session before ever dropping it.
  - **Step 1 + RLS applied** (`20260904100000_add_tenancy`, `20260904120000_add_rls`) via `docker compose run --rm --no-deps web ... migrate deploy` against the newly-built `web` image. **Real near-miss caught and fixed live, not just noted:** `docker-entrypoint.sh` unconditionally runs `migrate deploy` *then* `exec node server.js` regardless of the command passed to `docker compose run` — the migration container kept running as a second full app server, on the same Docker network alias (`web`) as the real `algo-web` container, for roughly 2-3 minutes before this was caught and the container was killed. Checked Caddy's logs across that window for 5xx responses — none found — so no confirmed customer impact, but this was pure luck (the new server was running before the backfill had populated `tenantId`, so any request hitting it that read a required-non-null field could have thrown). **Lesson recorded so it isn't repeated:** always override `--entrypoint` (not just the command) when running `migrate deploy`/scripts one-off against this image, or use a separate non-app-serving image target.
  - **Step 2 (backfill) run for real** via a purpose-built one-off image (`docker build --target builder`, which has the full source tree + a correctly-generated Prisma client + `tsx` — the `runner`/production image deliberately has none of these, it's a Next.js standalone bundle). **Second real bug hit and fixed live:** the generated Prisma client ships both an `openssl-1.1.x` and an `openssl-3.0.x` query engine binary (per `schema.prisma`'s `binaryTargets`), and this container's runtime auto-detection picked the wrong (1.1.x) one and crashed — worked around by setting `PRISMA_QUERY_ENGINE_LIBRARY` explicitly to the `.x` binary path. The `web`/`runner` image doesn't hit this because it never needed to (its own `migrate deploy` uses a separate schema-engine binary, unaffected). 996 rows backfilled across 35 tables in 0.2s, script reported zero orphans. **Independently re-verified, not just trusted** — direct `SELECT count(*) WHERE "tenantId" IS NULL` against Postgres on the 7 highest-row-count/highest-risk tables (`User`, `CallDetailRecord`, `Recording`, `Contact`, `ChatMessage`, `Activity`, `AppSetting`): all zero.
  - **Step 3 promoted and applied**: `step3_constrain.sql.template` copied into a new live folder (`20260904140000_add_tenancy_constrain`) per its own documented promotion steps, `web` rebuilt to bake it in, applied via an isolated `docker run` (not `docker compose run`, specifically to avoid repeating the network-alias near-miss above) with `--entrypoint ''`. Deploy output named the migration explicitly (not a bare "no pending migrations"). Verified live via `information_schema.columns`/`pg_constraint`: `User.tenantId` is `NOT NULL`, FKs exist (`User_tenantId_fkey` etc.).
  - **App redeployed and live-verified**: `web`, `cdr-listener`, `gateway-syslog-listener` rebuilt and restarted on the tenancy-aware code; all three came up healthy, `migrate status` shows 26/26 migrations applied, zero errors in startup logs. Real browser login (own saved credentials via Chrome autofill, not typed/handled directly) confirmed: Wallboard shows real AMI-connected live data (1 agent online), `/admin/contacts` shows all 14 real contacts — exactly matching the backfill's own count for that table. Zero 5xx in Caddy's access logs across the entire deploy window (checked explicitly, not assumed).
  - **`handoff.md` updated same session** to reflect this deploy (it had gone stale — the PC lost power mid-session before the write-up, this follow-up session reconstructed the actual state from git history + this Build Log before doing anything further, per the operator's own instruction to "check your last log").
  - **Merge verification (coordinator, after all five pieces landed on `main` sequentially):** `npx tsc --noEmit` — **zero errors across the entire repo** (down from 227 right after wave 2a alone landed). `npm run test` — 490/490 across 52 files, unchanged through every merge step. `npm run build` — one real fix needed that typecheck/test both missed: `db-tenant.ts`'s `// eslint-disable-next-line @typescript-eslint/no-explicit-any` referenced a rule this repo's eslint config never registers (`.eslintrc.json` only extends `next/core-web-vitals`, no `@typescript-eslint` ruleset at all) — ESLint errored on the unknown-rule disable directive itself, not on the `any` it was meant to suppress. Removed the directive; nothing else needed to change, since `next/core-web-vitals` doesn't flag `any` in the first place. Full production build then succeeds end to end — `/platform`, `/platform/login`, and every new API route confirmed present in the build's route manifest, middleware bundle grew 78.3kB → 78.6kB (the platform dispatch branch compiled in).
  - **Not done, by design, per the plan's own sequencing table:** wave 4 (billing enforcement), wave 5 (domain/TLS re-scope to platform-level), wave 6 (telephony namespacing — PJSIP endpoints becoming `t<n>-1001`, needs live Asterisk to verify safely), wave 7 (provisioning pipeline — blocked on the queued CA signing flow v2 and the still-unconfirmed G2 OpenVPN tunnel handshake).

- 2026-09-05 — **Ran the platform (owner console) Playwright acceptance suite for the first time ever.** It had been written, typechecked and shelved because the build machine had no database and no Docker; Docker is available now, so it was run against a local Postgres 16 (all migrations applied clean) with a seeded, TOTP-enrolled `PLATFORM_OWNER`. First run: 20 passed / 4 failed. All four are fixed (`33b710c`), final run **28 passed, 0 failed, 5 skipped** — the skips are the tenant-role specs, which skip by design without `E2E_ADMIN_*`.
  - **One product fix.** A sole owner acting on their own account trips both the last-owner rule and the self-edit rule. Both refuse, but only one message is true: "Ask another platform owner to do it" names somebody who does not exist. `canDisable`/`canChangeRole` now report the last-owner reason when both apply, with a no-op role change answered first so it cannot borrow a demotion message. Three unit tests pin the precedence (787 total, up from 784).
  - **Three test defects, each of which had made its test unable to pass.** (1) `telephonySnapshot` serialised raw health-check objects carrying a `checkedAt` stamped at request time, so a before/after comparison could never hold — now projects `id`/`status`/`detail`. (2) `waitForURL(/provisioning\/[^/]+$/)` also matched `/provisioning/new`, the page it was already on, so it resolved instantly and `tenantId` became the literal string `"new"` — every later test then drove the create form instead of the run. (3) The cert-gate test allowed only two pause states; the honest third is "a runnable step whose last attempt failed". The invariant is now asserted where it lives: `issue_cert` must not be `done`.
  - **What the working wizard actually reports, and it is useful.** With the `"new"` bug fixed the run reaches **step 5 of 12** and stops truthfully at *Verify workspace subdomain*: `<slug>.algopbx.com does not resolve`. That is exactly the one-time `*.algopbx.com` wildcard DNS record from the handoff list, still not created. The suite now demonstrates that gap rather than merely asserting it.
  - **Environment notes for the next run.** `PLAYWRIGHT_BROWSERS_PATH` on this machine points at `E:\ms-playwright`, which does not exist — the browsers are under `%LOCALAPPDATA%\ms-playwright`; override it or every project fails at browser launch. The e2e Postgres is a throwaway container (`algo-e2e-pg`, host port 55432); `DATABASE_URL` in `.env.local` is a deliberate dud (`x:x@127.0.0.1:1/x`) and must be overridden per-run. `scripts/create-platform-user.mjs` deliberately leaves TOTP un-enrolled, so a suite-ready account needs `totpSecret`/`totpConfirmedAt` written directly. **No platform test account was created on production**, per `e2e/README.md`.
  - **Pushed to `origin/main` (`e2e6000`). NOT deployed** — the owner was asked and deferred the decision. The VPS stays at `a37f2e7`, 21 commits behind, in the expand/contract state. Pre-flight was done and is recorded in `handoff.md` item 0 so it need not be repeated: the VPS's dirty working tree is safe to discard (the alarming diff is CRLF churn; four of the ten files are byte-identical to `origin/main` and the rest are simply the old code), and the live public-website apex Caddy block is preserved upstream in `src/lib/domain/caddyfile.ts` after `0df53c9` moved it out of the domain-apply route.
  - **Still not covered, unchanged:** the real suspended-tenant call (`GO_LIVE_CHECKLIST.md` Gate 1b), and wave 6 telephony namespacing.

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

## 24. One-way audio root-caused and FIXED with live packet evidence; agent→admin session takeover fixed (2026-08-29, follow-up to §23)

Two operator reports this session, both chased to hard evidence rather than
theory, plus the inbound extension prompt re-identified.

### 24.1 Outbound one-way audio — FIXED (commit `4aed624`, deployed)

**Symptom:** outbound GSM calls connected, the far end could hear the agent,
the agent heard nothing, and every answered call ended at exactly 30s.

**Evidence chain** (all captured live on the prod VPS, not inferred):

1. The reported call was identified exactly: recording `1787994215.0.wav`,
   epoch 1787994215 = 09:03:35 UTC = **13:03:35 UAE**, matching the
   operator's "1:03:35 PM". CDR: `0504852446`, ANSWERED, 30s / 19s billsec.
2. `pjsip show channelstats` during a live reproduction:
   `1002` channel **897 rx / 0 tx**, `dinstar-trunk` **0 rx / 893 tx**.
   Zero RTP from the gateway; therefore zero to the browser.
3. `tcpdump -i tailscale0` had no `192.168.11.1 -> 100.64.32.115` flow at
   all — the return direction was absent, not merely dropped.
4. `pjsip set logger on` showed the outbound INVITE carrying
   **`c=IN IP4 100.64.32.115`** (the tailscale0 source address).
5. `CallQualitySample` rows for those calls had **every `inbound-rtp` field
   NULL** (packetsReceived/packetsLost/jitter/jitterBufferDelay) while
   `candidate-pair` RTT was populated — ICE connected, no inbound stream
   ever existed. `src/lib/webrtc-stats.ts:36-46` was read and confirmed
   correct first, so this was real absence, not a collection bug.

**Root cause:** the Tailscale subnet router SNATs tailnet→LAN traffic to its
own LAN address, and the Dinstar has no route into `100.64.0.0/10`. SIP
survived the asymmetry only because `force_rport` makes the gateway reply to
the source it actually received from; RTP follows the SDP `c=` line and was
black-holed by the office router. The 30s teardown was `rtp_timeout=30` on
`dinstar-trunk` firing on a leg receiving nothing.

**Fix:** `external_media_address=192.168.11.10` on `[transport-udp]` in
`pbx_configs/pjsip-base.conf`. Only `dinstar-trunk` uses that transport.

**Verified after deploy:** `dinstar-trunk` **1283 rx / 1287 tx**, agent leg
**1291 rx / 1283 tx**, a 2342-packet `192.168.11.1:8012 ->
100.64.32.115:14062` flow where there had been none, call survived 59s
(vs. the old hard 30s), and `CallQualitySample.packetsReceived` climbed
171→2157 with 0.7% loss and MOS 4.33. **No regression on the WebRTC leg:**
the SIP trace shows `c=IN IP4 187.53.128.252` on the SAVPF media lines and
`c=IN IP4 192.168.11.10` only on the `RTP/AVP` Dinstar leg — remote agents
are unaffected.

Commit `69194e4`'s `rtp_symmetric=yes` is **necessary but insufficient**, not
a bug: it governs where Asterisk sends and what it accepts, never where the
gateway transmits. It is what turned "no audio at all" into "one-way". Keep it.

### 24.2 Agent microphone is silent — NOT a PBX bug (open, workstation-side)

After 24.1, the operator reported neither side heard anything. Decoding the
a-law RTP payloads straight out of the pcap (`/root/rtp_rms.py` on the VPS):

- **Gateway → Asterisk: real speech** (RMS bursts 2118/1978/1762/1115 at
  t=4-7, 29-37, 40-42, 45-46s).
- **Asterisk → gateway: pure digital silence for all 47s** — every packet
  a-law `0xD5`, constant peak=8. Not quiet speech; a dead capture.
- The MixMonitor recording (`extensions.conf:146`, agent channel) contains
  the gateway's bursts and **none of the agent's voice**.

So the media path is healthy end to end and the browser is sending packets
(Asterisk counted 1291) that contain nothing. Both remaining symptoms —
far end hears nothing, agent hears nothing despite 2157 packets arriving and
decoding at MOS 4.33 — point at the agent workstation's audio devices
(muted/absent input, output to an inactive device) or a blocked autoplay
(`sip-context.tsx` already tracks `audioBlocked` + a retry control).
Note the mic DID work at 09:03 (that recording's loud audio was the agent,
since the gateway sent nothing then) and was silent at 10:19.

### 24.3 Inbound "dial an extension" prompt — the gateway, not Asterisk

`[from-dinstar]` (`extensions.conf:219-251`) is `Answer()` → `MixMonitor()` →
`Queue(support_queue,...)`. A repo-wide grep for `DISA|Background(|Read(|
WaitExten` finds nothing on the inbound path, and **no `[default]` context
exists anywhere**, so a mis-identified call would 404, never prompt.
`pjsip_dinstar.conf` correctly identifies `192.168.11.1` into `[from-dinstar]`
(verified live). The prompt is the UC2000's own DISA/second-dial-tone,
triggered by an empty **"To VOIP Hotline"** — a field that has now regressed
to empty three times. Set it to `100` on Port Group-0 (matches
`extensions.conf:220`'s `_X.` → `Goto(s,1)`; `s` also works via line 222).
This supersedes §21's RE-CORRECTION, which concluded the DISA theory was dead
because it could not be reproduced that night.

### 24.4 TURN relay was firewalled off — fixed on the VPS

`scripts/setup-firewall.sh:48-54` intends to open `3478/tcp`, `5349/tcp` and
the coturn relay range `20001:30000/udp`. **None of the three existed on the
live VPS** — the firewall had drifted from the repo's own script. coturn is
`network_mode: host`, so ufw genuinely blocked them and the TURN *relay*
fallback was dead (control on 3478/udp was open, so allocations appeared to
work). Direct media was unaffected — `10000:20000/udp` is open — so this only
ever bit agents behind a symmetric NAT. Rules added live; the script already
had them, so no code change was needed.

### 24.5 Agent→admin session takeover — FIXED (commit `d1ef7b9`, not yet deployed)

Operator reproduced an "Admin" switch inside the agent workspace with both
accounts open in one browser. **Not a broken permission check** — all 35
`/api/admin/**` routes were read and each independently calls
`requireAdminSession()`/`requireStaffSession()`. The app simply had no notion
of "this rendered page belongs to user X":

- `auth.config.ts` declares no `cookies:` block → ONE `authjs.session-token`
  at `path=/`, shared by every tab.
- `login/page.tsx` never called `auth()`; `signIn()` overwrites that cookie
  in place, browser-wide, with no sign-out.
- Layouts read `await auth()` once, so an open `/agent` tab re-rendered
  against the admin cookie and drew `agent-shell.tsx:185-189`'s ADMIN-only
  "Admin" link — which worked, because the cookie really was the admin's
  (`middleware.ts:72` only role-gates `/admin`).

Fixed: login page refuses to render the form over a live session;
`useSessionIdentityGuard` reloads a shell whose rendered user id no longer
matches the live session (sessionStorage-debounced against reload loops);
`sip-context`'s credential effect keyed on the user id (it was keyed on
`sessionStatus`, which never changes on an account swap — so a tab kept the
previous user's extension and **plaintext sipSecret** registered to Asterisk
over WSS, invisible to every server-side ACL); `SessionProvider
refetchInterval=60`; `admin/layout.tsx` checks the role itself; `callbackUrl`
open redirect closed; TEMP host-header diagnostic removed from middleware.

Plaintext password storage/display and hard user delete were deliberately
left alone (owner's standing decision, memory `owner-overrides-security-model`).

typecheck clean, **294/294 tests**, zero lint warnings, clean build.

## 25. Hold/transfer/CDR bugs fixed and deployed; inbound routing gap found on the gateway; call logs and zero-config SIM insertion scoped (2026-08-29, later same day, follow-up to §24)

Continuation of §24's session, prompted by the operator naming four more
concrete symptoms after inbound still failed: hold ends the call, transfer
doesn't work, no call logs anywhere, and SIM insertion should need zero
config. Investigated with three parallel Explore agents plus live gateway
access via Chrome, rather than working from hypothesis.

### 25.1 Inbound root cause found on the gateway — Tel->IP Routing pointed at a nonexistent SIP Server

Read live off the Dinstar UI (`https://192.168.11.1`, logged in via the
documented credentials):

| rule (index 63, "default") | Source | Destination |
|---|---|---|
| IP->Tel (outbound, works) | Trunk-0 | Port Group-0 |
| Tel->IP (inbound, broken) | Port Group-0 | SIP Server |

The gateway is in No Register mode, so "SIP Server" is not a thing that
exists for it to route to — inbound calls had nowhere to go and were
rejected as FORBID CALL at the GSM layer before any SIP was generated. This
exactly matches Section 24's finding of 211/211 requests from the gateway
being OPTIONS keepalives with zero INVITEs ever. The IP->Tel direction was
fixed to use Trunk-0 in an earlier session (handoff.md's 2026-08-27
section); Tel->IP never received the matching fix.

Fixed live: Tel->IP Routing rule 63's Destination changed from SIP Server to
sip-trunk-0 (AlgoPBX), saved, confirmed in the UI (list view now shows
Port Group-0 -> Trunk-0). No device restart needed for a routing rule
change. Not yet re-tested with a live call — a fresh call must be placed
and the Asterisk SIP trace checked for a real INVITE, not just the OPTIONS
keepalive, before this is considered proven.

If it doesn't work, next untested suspects on the Service Configuration
page (read live, both currently enabled): Enable Private Service = Yes
(gates inbound against an allow-list on some firmware; empty list forbids
everything) and Enable GSM Incoming Configuration = Yes. Also noted:
Asterisk still answers the gateway's OPTIONS keepalive with 404 —
[from-dinstar] matches only digits/s/hangup — worth fixing
(`exten => heartbeat,1,Hangup()`) regardless, since a 404'd keepalive can
make the gateway mark the trunk dead independent of the routing fix above.

Also mapped the gateway's real HTTP API this session (a plain form-post
device, not the Basic/query-auth model dinstar-discovery.ts assumed):
login at `POST /goform/IADIdentityAuth` with a `devckie` session cookie;
port config at `POST /goform/PortCfg`, one row per port 0-7 with fields
`SipAccN`, `AuthenticateIDN`, `SipAccPswN`, `SipLocalPortN`, `RegisterN`,
`TxGainN`, `RxGainN`, `OffhookAutodialN` (this is the "To VOIP Hotline"
field), `PSTNHotlineN`; and group-level config at `POST /goform/PortGroup`.
Read back live: `OffhookAutodial3=100`, all other ports empty — matches the
operator's screenshot exactly. This settles the previously-unverified
"which auth style" question in dinstar-discovery.ts: the device wants a
cookie session, not Basic or query auth.

### 25.2 Zero-config SIM insertion — mostly already true, confirmed by reading the dialplan and the live gateway

Voice never selects a GSM port anywhere. Outbound is a single
`Dial(PJSIP/${DIALNUM}@dinstar-trunk,60)` (extensions.conf:185) to one
endpoint with one AOR — the gateway itself picks the port. Inbound funnels
every called-number variant into one handler (extensions.conf:219-222).
Every simPort reference anywhere in the codebase (WaInstance.simPort, the
SIM-port board, the SMS provider's port mapping) is WhatsApp/SMS identity
plumbing, unrelated to voice.

Confirmed live: Port Group-0 "default" already spans ports 0 through 7 in
Cyclic Ascending select mode, and both routing rules are port-group-wide.
So "insert a SIM anywhere and it works" reduces to one per-port field (To
VOIP Hotline, currently set on port 3 only) plus this session's routing
fix — not a large feature. Two hardware facts no software change can
remove: only ports 0-3 on this unit have modems installed/powered, and the
modules only read SIM presence at power-on, not on hot-insertion (a reboot
is still needed after inserting a SIM).

Nothing today would ever notice a newly inserted SIM — `parsePorts()`
(dinstar-discovery.ts:274) already returns per-port simPresent (and the
gateway separately exposes per-port IMSI, which the parser discards), but
it's request-scoped and never persisted. A small DinstarPortState table
plus a poll (reusing the existing SMS-poller's cron pattern) would surface
this without any device-side config — designed, not yet built.

### 25.3 Hold silently ending the call — root cause found in the SDK, not the PBX config

`asterisk -rx "moh show classes"` returned completely empty in production
(the MOH audio directory is empty — see 25.5), which looked like the
obvious cause, but a dedicated code exploration against the installed
sip.js 0.21.2 source found the real bug and it's independent of MOH.

`toggleHold` (sip-context.tsx) set `holdInFlightRef.current = true`, then
cleared it in a plain `finally` after `await manager.hold(target)`. But
SessionManager's `hold()`/`unhold()` promise resolves the instant the
re-INVITE is sent (`Session.invite()` returns at
`this.dialog.invite(...)`, confirmed against source) — not when Asterisk
answers it. So if Asterisk 2xx'd the hold re-INVITE with an SDP answer
Chrome's `setRemoteDescription` couldn't apply, sip.js auto-ACK-and-BYEs and
transitions to Terminated — and by the time `onCallHangup` fires,
`holdInFlightRef` was already false, so `classifyTermination` read it as an
ordinary hangup and showed no message at all. The call vanished with no
explanation, exactly the "pressing hold ends the call" report. A rejected
re-INVITE cannot do this (the Web SDH's `rollbackOffer` is a no-op) — only
an accepted one with a bad answer can, which is why this reads as
config-adjacent but isn't.

Fixed (commit a2f03a2, deployed): the flag is now cleared only when the
real outcome is known — `onCallHold` firing (confirmed success) or
`onCallHangup` reading it (confirmed failure) — with a 10s safety timeout in
`toggleHold` for the case where neither delegate ever fires. The identical
bug existed twice more in attended transfer: `startAttendedTransfer`'s
`await manager.hold(target)` and `cancelAttendedTransfer`'s
`await manager.unhold(primary)` both had the same early-resolution problem,
so their "abort if hold fails" guards could never actually fire. Fixed via
a new `holdWithConfirmation()` helper that waits on the delegate instead of
the SDK promise, used in both places.

Not yet re-tested live — place a real hold, on both a plain call and
mid-attended-transfer, before trusting this closed.

### 25.4 Transfer — the block is by design, but the premise is stale and has two unguarded siblings

`src/lib/transfer-guard.ts` deliberately blocks transferring a
Dinstar-trunk-originated call to an external number — a live SIP trace
(documented in the file's own header) showed a REFER placing a second
outbound call through the same, already-occupied GSM port, correctly 503'd
by the Dinstar. This is real hardware-limit handling, not a bug, for the
scenario it covers. But two things follow from 25.2's port-group finding:

1. The guard's one-port premise is now stale — Port Group-0 already spans
   all 8 ports, so a second registered SIM makes external transfer possible.
   The guard should read live port state (from 25.2's planned polling) and
   allow the transfer when more than one SIM is available, fail closed when
   unknown. Not yet implemented — waits on 25.2's port-state table.
2. The same hole is open, completely unguarded, on two other paths.
   `POST /api/calls/conference` originates a third party with no equivalent
   check at all. Manager escalation (escalation-picker.tsx) reuses the same
   client-side `blindTransfer`, so it is blocked by this exact guard for any
   manager who has only a phoneE164 and no internal extension — meaning
   escalation is currently impossible on inbound GSM calls to an external
   manager, which is precisely the case escalation exists for. Neither
   fixed yet; both scoped in the plan file below.

### 25.5 CDR mapping — two real bugs, confirmed against live production rows, now fixed and deployed

Production rows for an outbound GSM call from 1002 showed
`direction = "internal"` and an empty `agentExtension` — both traced to
code, not data:

- `scripts/ami-cdr-listener.ts` read `event.Context` to determine dialplan
  direction. A real Asterisk Cdr event has no Context field — the CDR's
  `dcontext` is serialized as `DestinationContext`. Every call was silently
  falling through `inferDirection`'s default to "internal".
- `src/lib/cdr-mapper.ts` never assigned `agentExtension` anywhere. Now
  derived from the PJSIP channel name Asterisk reports — `event.Channel`
  (PJSIP/1002-...) for a call the agent originated, `event.DestinationChannel`
  for one they answered after the queue bridge.
- `callerNumber` also preferred `CallerID` (the full display string
  `"Algo Call Center" <1002>`, exactly what production showed stored) over
  `Source` (the bare number) — inverted; Source now wins, with CallerID
  parsed as a fallback only.

This single pair of bugs explains both of the operator's reports: no call
logs in the agent UI, and a permanently stale /admin/reports — every
agent-/report-facing query filters on agentExtension and/or direction
(/api/me/missed-calls, /api/admin/reports/agent-hours, /api/recordings's
agent scoping), while /admin/cdr's unfiltered query kept showing real data,
which is why only that one page ever looked correct.

Fixed and deployed (commit a2f03a2, 5 new regression tests using the real
production field shapes). Not yet fixed: there is still no call-log page in
the agent UI at all (never built, not merely broken) — scoped for
/agent/calls plus an own-extension /api/me/calls; the missed-calls "missed"
definition needs to move from a disposition-string match to
`billsecSec === 0`/`answeredAt: null`, since [from-dinstar] answers every
inbound call before queueing it, so a genuinely missed call is recorded
ANSWERED. Also noticed live: `docker logs algo-cdr-listener` showed
repeated "AMI connection lost, reconnecting..." cycles — any Cdr event
during a gap is lost outright, a second, independent contributor to missing
call data.

### 25.6 MOH and ringtone audio are absent in production — root cause is .gitignore

`asterisk -rx "moh show classes"` returns nothing; the MOH default
directory is empty in the container and on the host, even though
musiconhold.conf's absolute directory= and res_musiconhold.so are both
correct. .gitignore excludes moh/default/*, the frontend's public/sounds/*,
and pbx_configs/sounds/* — the dev machine has the audio files, the VPS
(deployed from a fresh clone) has none of them. Same cause explains why
inbound calls would ring silently in the agent UI. Not yet fixed — needs
either committed audio (the ignore rules were added for
licensing-provenance reasons, see each directory's README) or a deploy step
that fetches pinned files, plus a loud startup check instead of the current
silent failure.

### Deployed this session

Commits d1ef7b9 (agent-to-admin session takeover, from Section 24, not yet
on the VPS at the start of this session) and a2f03a2 (hold/transfer/CDR
fixes) were pushed to the VPS by syncing the 14 changed frontend files
directly (the VPS's git checkout has diverged local-only commits and
live-generated pbx_configs/pjsip_dynamic.conf state, so a plain git pull
was avoided), then `docker compose build web` plus
`up -d --no-deps --force-recreate web cdr-listener`. Both containers came
up healthy; cdr-listener reconnected to AMI cleanly. typecheck clean,
299/299 tests (5 new), zero lint, clean build, all before deploy.

Full plan for the remaining work (inbound re-test, MOH provisioning, the
agent call-log page, the dynamic transfer guard, the Dinstar admin-page
config feature) is in
`~/.claude/plans/see-the-ui-currently-hashed-codd.md`.

## 26. The full remaining-work plan executed end to end — all 7 sections deployed and confirmed live (2026-08-29, later same day, follow-up to §25)

Direct continuation of §25: the operator approved the plan file in full and
this session implemented, deployed, and verified all seven of its sections
against the real running production system — not just green builds. Every
item below was confirmed via the actual deployed bundle content, a live
database query, or a direct read of the running Asterisk/gateway state, per
this project's own hard-won rule that a passing build proves nothing about
what's actually running.

**1. The CDR deploy gap — fixed for real.** `cdr-listener` builds from its
own Docker image target (`docker-compose.yml:378-382`, `target:
cdr-listener`), separate from `web`. §25's CDR mapper fix had been committed
but never reached production because only `web` was rebuilt. Rebuilt
`cdr-listener` specifically and redeployed. Confirmed on a real call
(`1788016566.47`, 15:16:06): `direction=outbound`, `agentExtension=1002`,
`callerNumber=1002` — all three previously-wrong fields correct.

**2. All 4 real GSM ports configured.** Only port 3 had `To VOIP Hotline`
set; ports 0-2 were empty. Set `OffhookAutodial=100` on all three via the
gateway UI, confirmed by a fresh page reload (not trusting the save
confirmation alone) showing all of ports 0-3 at `100`.

**3. Agent inbound-call defects, all fixed and deployed:**
- The attended-transfer NOTIFY-timeout branch could leave
  `primarySessionRef`/`consultSessionRef` pointing at an already-Terminated
  sip.js session, which made `onCallReceived` silently 480 every future
  inbound call forever. Now checks `session.state` at the timeout and clears
  whichever ref is actually dead; `onCallReceived` gained the same check as
  a second line of defense.
- No `qualify_frequency` on the generated WebRTC AOR — confirmed live via
  `pjsip show aor 1002` that both of 1002's contacts showed `NonQual`
  forever. Added `qualify_frequency=30`/`qualify_timeout=3`; after a full
  Asterisk restart both contacts now show `Avail` with real RTT.
- No incoming-call UI outside `/agent` — `CallControls`' Answer/Decline was
  mounted on exactly one of five agent routes. Confirmed live: a real
  inbound call rang the full 15s `RINGNOANSWER` window and was abandoned
  while the agent was on `/agent/chat`. New `IncomingCallBanner` mounted in
  `AgentShell`, which wraps every agent route.
- Decline sent `480` (indistinguishable in Asterisk's logs from a dead
  endpoint) via the generic `hangupCall` path. New `declineCall` calls
  `Invitation.reject({statusCode: 486})` directly for an unanswered
  invitation.
- The ringtone's `play()` rejection was swallowed entirely
  (`.catch(() => undefined)`) — very likely why the `RINGNOANSWER` call
  above was never heard. Added a one-time pointerdown/keydown unlock, a
  `ringtoneBlocked` state mirroring the existing `audioBlocked` pattern, and
  a loud "Enable call sounds" banner.
- Agent status ("On Break" etc.) only ever wrote the database column —
  nothing called `pauseQueueMember`, so a break agent kept receiving real
  calls. Wired the status PATCH route to pause/unpause the queue member.
  Separately, `onServerConnect` hardcoded a reset to `AVAILABLE` on every
  reconnect, silently un-breaking an agent after any WebSocket blip — added
  `deliberateStatusRef` so a reconnect restores the agent's own last
  deliberate choice instead.

**4. Reporting and telemetry:**
- `/admin/reports` now polls every 30s and surfaces load errors, verified
  in the deployed bundle (was fetch-on-period-change-only with no error
  state, indistinguishable from "broken" while the CDR bug made it look
  permanently empty).
- CDR backfill: 25 outbound + 14 inbound historical rows corrected via a
  one-time SQL script (direction inferred from destination shape,
  `agentExtension` from the only staffed extension during the test window,
  confirmed against `queue_log`). Two genuinely ambiguous test-junk rows
  left alone deliberately.
- The CDR listener's "flapping" reclassified as **not a bug** — the one
  disconnect since redeploy lines up exactly with an Asterisk restart done
  this session; restarting Asterisk always drops every AMI connection.
- New outbound-audio telemetry: `CallQualitySample` gained
  `packetsSent`/`audioLevel`/`totalAudioEnergy` columns (migration
  `20260829010000_add_outbound_audio_telemetry`, confirmed applied in
  `_prisma_migrations`), sourced from WebRTC's `outbound-rtp` and
  `media-source` stats — previously `webrtc-stats.ts` read only
  `inbound-rtp`/`candidate-pair`, so "is the agent's mic actually producing
  sound" required manually decoding a packet capture, which happened twice
  in §24/§25.
- Confirmed (not yet fixed, flagged for later): the `getUserMedia`
  `echoCancellation`/`noiseSuppression`/`autoGainControl` constraints in
  `sip-context.tsx` are dead code against the installed sip.js source —
  they sit in a factory-options field sip.js's default factory never reads,
  while `SessionManager` separately overwrites per-call constraints from
  `media.constraints`, currently a bare `{audio:true}`. No constraint
  change can have any effect until this is fixed.

**5. GSM port ↔ agent assignment.** The exclusive, revoke-only ownership
rule the operator asked about already existed and was already correctly
enforced (`simPort`/`assignedUserId` both `@unique`, a 409 on reassigning an
owned port) — verified by an independent review pass before building
anything, which caught that an earlier draft plan for a parallel `GsmPort`
ownership table would have created two unreconciled sources of truth for
"who owns port N", the same drift class this project has already been bitten
by twice (`VM_PUBLIC_DOMAIN`, `DINSTAR_SIP_PORT`). Two real gaps fixed
instead:
- The 409 didn't name the current holder — now says
  `${name} (${email})`, confirmed in the deployed bundle.
- A port could not be assigned without first creating a real WhatsApp
  pairing session, since assignment required an existing `WaInstance` row
  and creating one normally starts OpenWA pairing. Added
  `MessageProviderKind.NONE` (migration
  `20260829020000_add_calls_only_provider_kind`, confirmed live via
  `enum_range`) for a calls-only port reservation with no messaging
  identity attached, guarded in both messaging routes so it can never be
  selected as a send provider.

**6. The transfer guard's unguarded siblings, all fixed and deployed.**
`transfer-guard.ts`'s single-GSM-port block is real, live-traced, correct
behavior — but two other paths reached the Dinstar trunk with no equivalent
check: `POST /api/calls/conference` (now detects a `PJSIP/dinstar-trunk-*`
channel in the redirect set and rejects adding an external party), and
manager escalation to a phone-only manager (now gets a specific,
actionable message instead of the generic transfer-guard text — the
underlying one-port hardware limit is real and not fixable without §7's
still-missing live SIM-count detection). Also tightened extension
provisioning to `/^[12]\d{3}$/` to match the dialplan's actual
`_1XXX`/`_2XXX` patterns, leaving every OTHER `\d{3,6}` use in the codebase
(CDR filter, voicemail mailboxes including the 9000 office-overflow box,
escalation-target extensions, click-to-call) alone since those are
genuinely different uses, not this bug. The dynamic multi-SIM guard itself
(6a) remains intentionally unimplemented — it has no live port-state source
to read from.

**7. Dinstar admin-page automation — built write-only, by necessity, not
choice.** Before writing any code, hit a real wall: the gateway's Port
Configuration page (`enPortList.htm`) does not embed per-port values in
static HTML — its field names are built by a client-side `for` loop, and
this session could not identify the real data source without further
invasive device probing. That probing was stopped deliberately (the
session's own tooling safety classifier pushed back on it, correctly), the
operator was asked, and chose write-only over the original
apply-and-verify design. The write path itself was proven, not guessed: a
standalone Node script using the exact same `node:https` + cookie-session
approach as the final code was run against the **live production gateway**
with idempotent values, and a fresh browser read confirmed the write
worked with nothing else disturbed. Shipped:
- `src/lib/dinstar/device-client.ts` — cookie-session login
  (`POST /goform/IADIdentityAuth`) via `node:https` with a dedicated
  `rejectUnauthorized:false` Agent (matching `cert-probe.ts`'s existing
  precedent rather than adding undici as a new direct dependency),
  confirmed to be a completely different login surface from
  `dinstar-discovery.ts`'s `probeDinstarCredentials()` (the
  `goip_get_status.html` SMS/status API, Basic/query auth, no cookies).
- `src/lib/dinstar/port-config.ts` — builds the exact full 8-port-row
  payload `POST /goform/PortCfg` expects, reproducing the confirmed-live
  baseline (blank SIP/registration fields, Register=No Register, +2dB/+6dB
  gains) with only the hotline changed, on ports 0-3.
- New `DINSTAR_WEBUI_USERNAME`/`PASSWORD` settings, deliberately kept
  separate from `DINSTAR_SMS_USERNAME`/`PASSWORD` — confirmed those
  authenticate the different SMS API, and this VPS's `.env` value for the
  SMS password (`change-me`) is a stale placeholder that must never be
  trusted as the real web-UI credential.
- `POST /api/admin/dinstar/ports` + a new "Apply standard SIM config"
  action on `/admin/dinstar`, replacing the old hard-coded "still manual"
  checklist.
- Deploy confirmed live: `algo-web` recreated from a no-cache build,
  healthy; the deployed bundle for the new route was grepped directly and
  contains the real write logic (`goform/PortCfg`, the `enSetOK`
  success-page check), not just a passing build.

**Explicitly deferred, not forgotten:** Section 5's optional dedicated
`/admin/gsm-ports` page (the assignment logic already works via the
existing user-edit form), Section 6a (needs live port-state detection),
and live SIM-presence detection for the Dinstar admin page (would need the
same page-scraping problem Section 7 hit and deferred).

**One unrelated anomaly noticed while checking final container health, not
investigated further as out of scope for this plan:** `algo-caddy` shows
`unhealthy` in `docker ps`, and has for ~26 hours — predates this session
and was never touched by it.

Full commit list this session, in order: `4aed624`, `69194e4` (earlier,
§24), `d1ef7b9`, `a2f03a2`, `93592f9`, `1b773d2`, `6b07728`, `025c3dd`,
`c4def00`, `c455318`, `6bed0de`, `27e3722`, `53069ab`, `59c1c26`.

## 27. P0 recon (read-only) for the MUI/CRM/WhatsApp/manager-merge plan — WhatsApp backend verdict: BROKEN, not UI, and the cause is simpler than feared (2026-08-31)

First step of the plan at `C:\Users\DK\.claude\plans\bubbly-wiggling-pudding.md`
(MUI migration → manager merge → WhatsApp fixes → CRM → agent UI rehaul → DNC →
PWA/Capacitor). Pure read-only inspection of the live production VPS, one
deliberate SQL read pass — no code changed, nothing restarted, nothing re-paired.

**Verdict: WhatsApp is backend-broken, and the fix is narrower than the plan's
worst case.** Two independent, decisive DB findings:

- **`ChatMessage` grouped by `direction`/`deliveryStatus`: 26 rows, all
  `INBOUND`/`delivered`. Zero `OUTBOUND` rows exist.** No agent has ever
  successfully sent a WhatsApp message through this system — not one. This
  confirms the operator's "sending fails" report as total, not partial, and as a
  real backend defect: P1's job is to find why every outbound attempt either never
  reaches OpenWA or is silently swallowed before the DB write (the `chatId` fix in
  `openwa-provider.ts:43` has still never been exercised by a real send — a
  session's worth of investigation, not confirmed today per the sandbox's
  live-write restrictions, see below).
- **Only 1 of 4 planned SIM ports has ever been paired.** `WaInstance` has
  **exactly one row** (`simPort: 1`, `status: CONNECTED`, number `971502644615`,
  paired 2026-08-29 05:43, `lastError` empty). Ports 2–4 have no instance at all —
  not stale, never provisioned. This is the real explanation for two things the
  old plan treated as separate mysteries: "admin Rooms shows only one chat per
  agent" (`Room` table also has exactly one row — there is structurally only one
  chat channel to show, the Rooms UI/activity route is not the bug) and "four
  accounts, everywhere" (P1's four-instance work has nothing to route between yet
  — pairing SIMs 2–4 is a prerequisite, not part of the WhatsApp bug fix).

**The re-pair-detach hypothesis (P1's #1 named risk): inconclusive by design, not
disproven.** The sidecar has reconnected automatically roughly 15 times since
pairing (Baileys `statusCode 428/515` "connection dropped; reconnecting"), and
**the same `openwaSessionId` (`eabd9bd2-…`) persisted across every one** — all 7
conversations and 26 messages are still attached to the single `WaInstance` row,
zero orphans. But this is auto-reconnect, not a true re-pair (logout + rescan a
fresh QR), which is the actual failure mode the hypothesis is about. **A real
re-pair test is still required** and must be done interactively — the sandbox's
tooling classifier blocked two live-verification steps this session on sight
(comparing the sidecar's on-disk API key against the app's configured value, and
firing one real outbound send), both correctly, since both touch production
secrets/state. Whoever runs P1 needs to do those two checks by hand.

- `algo-caddy` **has been `unhealthy` for 2+ days in `docker ps`, and it is a
  false positive**, not the outage §26 speculated it might front. Its healthcheck
  is a `docker exec`-based probe that fails to spawn at all (`"unable to start
  container process: procReady not received"`, `FailingStreak: 15260`) — a
  healthcheck-definition bug. The actual proxy is fine: `curl` returns `200`, and
  its own access logs show live authenticated agent traffic (`/agent`,
  `/api/recordings/*`) succeeding over real HTTP/3 the whole time. Inbound
  WhatsApp webhook delivery is proven independently working anyway — 26 real
  inbound messages ingested, `webhookRegisteredAt` is set. **This closes the
  question §26 raised** (does Caddy's unhealthy status block the webhook) — it
  doesn't, and the healthcheck itself should get a cheap fix (swap it for an HTTP
  probe) whenever convenient, no urgency.

**What this changes in the plan.** P1 stays ordered exactly as written (session
stability → re-pair survival → live updates → the send bug), but two things move:
pairing SIM ports 2–4 is now an explicit P1 prerequisite rather than an implicit
assumption, and the send-bug investigation has a much stronger starting fact (zero
successful sends ever, not "sometimes fails") to work from instead of guessing
among `chatId`/API-key-rotation/instance-routing as equally likely.

No code changed this session. Next: Phase M (MUI migration) per the plan, unless
the operator wants P1's WhatsApp fixes pulled forward given how narrow the finding
turned out to be — worth asking, not assuming.

## 28. WhatsApp send-path root cause found (there wasn't one), Dinstar SMS TLS pinning fixed and live-verified, Caddy healthcheck false-positive fixed (2026-08-31, same day, direct continuation of §27)

Executing the plan's pulled-forward P1-backend steps (1-7) ahead of Phase M, per
the operator's explicit reordering after §27's recon. All against production,
with gates run before every deploy.

**Step 1-2: the "agent-side sending fails" root cause — there is no code bug.**
Two live tests, both decisive:
- **1a, API key comparison**: web's OPENWA_API_KEY and the sidecar's
  /app/data/.api-key match exactly (db2d2541..., 64 chars). Zero AppSetting
  rows exist for OPENWA_API_KEY/OPENWA_BASE_URL/webhook secret, so the
  DB-first/env-fallback path (settings/service.ts) falls through to .env on
  both sides — no rotation, no override, no mismatch. Rules out the rotated-key
  hypothesis entirely.
- **1b, real send**: replicated openwa-provider.ts's exact wire call
  (POST /api/sessions/{id}/messages/send-text, chatId "<E.164 digits>@c.us")
  directly against the live sidecar, sent to the manager escalation contact
  (+971544887712, EscalationTarget row "Deepak T"). HTTP 201, real
  messageId, delivered. First-ever live confirmation the chatId fix works.
- **2, route review**: read POST /api/messaging/conversations/[id]/messages
  line by line. It always writes a ChatMessage row before checking the
  provider result — so a real failed send would still leave a
  deliveryStatus: "failed" row. Zero OUTBOUND rows exist at all (§27), and
  the pre-write 409 guards (no instance assigned / no active session /
  calls-only) don't apply to any of the 7 real conversations (all correctly
  channel: WHATSAPP, correct waInstanceId, correct openwaSessionId,
  unassigned so any agent can claim them) — confirmed by direct query.
  canSendOnConversation/canAccessConversation are correct and permissive
  for this data. Conclusion: the send path — wire format, route logic, access
  guards, and the composer's error handling — is entirely correct end to end.
  It has simply never been exercised, consistent with §27's other finding
  that only 1 of 4 SIM ports was ever paired and the operator's own testing
  likely never reached a working conversation. No code changed for this step;
  there was nothing to fix.

**Step 3: session persistence — already solid, nothing to build.** openwa_data
is already a named volume (docker-compose.yml, comment already documents this
was fixed for exactly this reason previously); API_MASTER_KEY is pinned via
.env, confirmed matching in 1a. The boot-log chmod ENOENT on
/app/data/.api-key is a harmless transient race on first-ever boot of a fresh
volume — the file exists now with correct 0600 perms and correct content.
Auto-repair on connection drops already works: Baileys has self-healed ~15 times
over 2 days with the same openwaSessionId every time, zero human intervention,
zero orphaned conversations. Step 3 required no changes.

**Step 4 (true re-pair test) and step 5 (pair ports 2-4): not yet run** — both
need the operator physically present (a phone to scan a fresh QR for port 1;
SIM cards for ports 2-4). Coordinating next.

**Step 6: algo-caddy's 2-day-plus false "unhealthy" status — fixed and
live-verified.** §27 found every probe failing "OCI runtime exec failed: ...
procReady not received" — a containerd/runc-level failure to spawn the exec'd
healthcheck process, not Caddy or wget misbehaving. Confirmed this is not a
stuck state: docker restart algo-caddy reset the accumulated FailingStreak
(was 15260) but the very next probe failed identically — proof this is a
host/runtime issue, not something a restart clears. Nothing depends on this
healthcheck (cert-sync's depends_on: caddy is condition: service_started, not
service_healthy), so docker-compose.yml's caddy.healthcheck is now
disable: true rather than left generating permanent false-alarm noise.
Deployed; docker ps now shows algo-caddy with no health column at all (as
expected for a disabled check), curl returns 200, real agent traffic
continues in Caddy's own access log throughout.

**Step 7: Dinstar SMS's DEPTH_ZERO_SELF_SIGNED_CERT block — fixed with real
certificate pinning, not NODE_TLS_REJECT_UNAUTHORIZED=0 (explicitly rejected,
per instruction) and not even the weaker per-module rejectUnauthorized:false
pattern src/lib/dinstar/device-client.ts already uses for the device's
different web-admin surface. Captured the device's real certificate live
(openssl s_client -connect 192.168.11.1:443, self-signed, sha256
7E:A4:3C:...:B7:11, valid 2019-2039) over the same Tailscale path production
traffic uses. New setting DINSTAR_TLS_CERT_PEM (settings/schema.ts,
DB-first/env-fallback like every other Dinstar setting, not secret — it's a
public cert) holds it. src/lib/messaging/dinstar-sms-provider.ts gained
pinnedAgent() + pinnedRequestJson() — node:https directly with a ca:-pinned
Agent, mirroring this repo's own established precedent of avoiding a new
undici dependency (matches device-client.ts's reasoning), used in place of
the shared fetch()-based requestJson() from ./http for this one provider's
three call sites (sendText, getStatus, pollInbound) only — every other
provider on the shared client is unaffected.

**One real bug caught in testing, not assumed away**: the device's certificate
carries no IP/DNS SAN (CN=Dinstar.com only, no 192.168.11.1), so Node's
default hostname check rejected it even with the right CA trusted
("Hostname/IP does not match certificate's altnames") — added
checkServerIdentity: () => undefined to the pinned Agent. This is not a
verification bypass in the way rejectUnauthorized:false is: ca: already
restricts trust to this one certificate's exact bytes, so the hostname it
happens to claim is redundant, not a hole.

**A second, separate bug caught in testing**: docker-compose.yml's web
environment: block does not auto-forward every .env key into the
container — only what's explicitly declared there, same as every other
DINSTAR_* line. The first deploy attempt silently ran with
DINSTAR_TLS_CERT_PEM unset (PEM present: false) despite it being in .env,
until DINSTAR_TLS_CERT_PEM: "${DINSTAR_TLS_CERT_PEM}" was added alongside the
other Dinstar lines and web was recreated again.

**Live-verified, not just built green**: after both fixes, a direct pinned-Agent
request from inside algo-web to https://192.168.11.1/goip_get_status.html
returns a real HTTP 302 to /enLogin.htm — past the TLS layer entirely
(previously DEPTH_ZERO_SELF_SIGNED_CERT before ever reaching the application
layer). The 302 itself is the already-documented, expected app-layer behavior
for an unauthenticated request (this file's own header, confirmed 2026-08-28)
— not a new problem. npx tsc --noEmit clean, npx vitest run 309/309 passed,
npx next lint clean, npx next build succeeded — run before every deploy in
this session, not just once at the end.

**Explicitly NOT fixed, flagged not assumed**: DINSTAR_SMS_PASSWORD in .env
is still the change-me placeholder confirmed stale in earlier sessions — real
SMS admin credentials have never been set. A full authenticated send/status/poll
call will still fail until real DINSTAR_SMS_USERNAME/PASSWORD are configured.
That is a credential gap, separate from and outside what this step was asked to
fix (the TLS blocker) — SMS sending is now reachable, not yet authenticated.
The auth-style ambiguity flagged in this file's own header (cookie-session
redirect vs. the Basic/query styles authHeaders() implements) also remains
open, same as before.

No code committed to git this session (holding per standing instruction not to
commit without being asked) — all changes deployed directly by copying the
changed files to /opt/algo-pbx and rebuilding, confirmed live, but not yet
reflected in a git commit on either the local working tree or the VPS's git
history. Flag this before it's forgotten: local and VPS are now ahead of the
last commit, and the two are consistent with each other but not with git log.

## 29. P2 CRM data layer + P3 agent UI rehaul, reprioritized ahead of Phase M and live-verified with a real bug caught in testing (2026-08-31, same day, follow-up to §28)

Operator explicitly reprioritized: pull P2/P3 (the actual CRM) forward ahead
of Phase M (MUI migration), since the CRM is what the operator wanted to see
working, not a styling pass on pages that already work. Built in Tailwind
against the existing glass-card language — not MUI — deliberately deviating
from the plan's original "Phase M runs first" ordering; this page converts to
MUI in Phase M like every other page, at zero extra cost since Tailwind stays
installed until that phase's last page lands regardless.

**P2 — CRM data layer, migrated to production.** New Prisma models
`ContactNote`, `ContactTask`, `CallDisposition` (+ `CallDispositionOutcome`
enum), `Contact` += `email`/`company`/`tags`/`ownerId`,
`CallDetailRecord` += indexed `callerNumberE164`. Migration
`20260831120000_add_crm_data_layer` generated via `prisma migrate diff
--from-url ... --to-schema-datamodel` run *inside* the live `algo-web`
container (not locally — this VPS's Postgres is correctly loopback-only, no
local dev DB to diff against) after discovering the container's
`/app/prisma/schema.prisma` is baked in at build time and a host-side `scp`
alone doesn't reach it — `docker cp` into the running container was needed to
generate a correct diff before rebuilding for real. The diff also produced
one unrelated line (`DROP INDEX "Recording_hiddenFromAgentAt_idx"`, pre-existing
drift between `schema.prisma` and migration history, nothing to do with this
change) — hand-trimmed out rather than silently applied. Applied via `migrate
deploy`, confirmed named in the output (not "no pending"), confirmed live via
direct row/column queries.

`CallDetailRecord.callerNumberE164` is now written at ingest time
(`POST /api/cdr`, using the same `normalizeToE164` every other normalization
in this codebase uses) so every future call is caller-ID-matchable without the
pre-existing `/api/crm/contacts/[id]/activity` route's last-2000-CDRs
in-process scan. Historical rows backfilled via a new idempotent admin route,
`POST /api/admin/maintenance/backfill-caller-e164` (same pattern as the
existing `maintenance/prune` route) — not a throwaway script, since a raw
Node script inside the container couldn't `import` `libphonenumber-js` at all
(Next's standalone output webpack-bundles it into route code rather than
keeping it as a standalone `node_modules` package — confirmed live by the
import failing with `ERR_MODULE_NOT_FOUND`), so the real, already-correct
`normalizeToE164` had to be reused via a real route, not reimplemented.

New session-authenticated routes under `/api/agent/crm/**`
(`requireSession()`, unlike the pre-existing Bearer-key-only `/api/crm/**`
which a browser session cannot call at all): `contacts` (list+search,
create), `contacts/[id]` (detail + merged calls/messages timeline using the
new indexed column, PATCH), `contacts/[id]/notes`, `contacts/[id]/tasks`
(create + complete-toggle), `dispositions` (choosing DNC also writes a
`DoNotCallEntry` in the same `$transaction`, per the plan's explicit
compliance requirement).

**P3 — the CRM agent UI.** `/agent` is now the CRM (contact list + detail:
fields, notes, tasks, a disposition bar, a merged timeline) — the plan's
actual headline deliverable. The former `/agent` softphone moved to
`/agent/call` unchanged (same components, same behavior, only the route
changed); `agent-shell.tsx`'s nav gained "Contacts" and "Call" entries.
**`IncomingCallBanner`'s suppression logic, which the plan flagged as needing
exactly this revisit, was fixed**: it used to hide on `/agent` (back when that
was the call page); now hides on `/agent/call` instead, so it correctly shows
on the CRM (now the busiest page) instead of being suppressed there.

**The CRM's Call button reuses `useSIP().makeCall()` directly — the same
function `Dialpad` already calls, no second calling mechanism.** The
WhatsApp button is a deep link to `/agent/chat?number=<E164>`, per the plan's
"if a conversation exists, open it; if not, start fresh" requirement.

**Live-verified against real production data — including a real bug the
operator's own review caught before I could over-claim it worked:**

- Contact list loaded all 7 real WhatsApp-derived contacts + one pre-existing
  one; contact detail rendered a real merged timeline (actual WhatsApp
  message bodies, not fixtures); adding a note wrote through the real API and
  reappeared attributed to the real signed-in admin, confirmed via a fresh
  fetch, not an optimistic-UI illusion.
- **The WhatsApp deep-link's first version was wrong in production despite
  passing every gate.** `resolveWhatsAppConversation()` assumed
  `POST /api/messaging/conversations` returns `{conversation:{id}}`; the real
  route (pre-existing code, not written this session) returns
  `{conversationId}` — confirmed by reading the route's actual last line, not
  assumed. This produced a live `TypeError: Cannot read properties of
  undefined (reading 'id')`, caught via `read_console_messages` in the actual
  browser session, not by the unit tests — the tests mocked the same wrong
  shape as the code assumed, so they stayed green while production broke.
  **This is exactly why this project's live-verification rule exists**: a
  passing build (and passing unit tests) proved nothing about what the real
  API actually returns. Fixed in both `resolveWhatsAppConversation()` and
  `createWhatsAppConversationWithInstance()`
  (`src/lib/messaging/whatsapp-deep-link.ts`), re-verified live end to end —
  a fresh contact with no conversation now correctly shows the admin SIM
  picker, selecting a line creates and opens the real thread, and re-clicking
  WhatsApp on that same contact now correctly finds and reopens it instead of
  re-showing the picker.
- The operator's two requested edge cases are both real, working code, not
  stubs: an agent with no assigned WhatsApp line sees an explicit "No
  WhatsApp line assigned to your account — ask your admin" state; an admin
  with no line gets a SIM picker over the real (non-calls-only) WaInstances
  and can originate a conversation from any of them. The agent-no-instance
  branch is unit-tested (`whatsapp-deep-link.test.ts`, 6 new tests) but not
  live-verified — doing so needs a second real agent session with no SIM
  assigned, not attempted this session.
- Two synthetic test contacts created during this verification
  (`+971509998877`, `+971509998878`) were deleted afterward, including their
  Conversation rows (Contact has no cascade delete for Conversation, only for
  the new ContactNote/ContactTask/CallDisposition — the FK would have
  rejected a bare Contact delete) — confirmed zero rows remain.

**Explicitly NOT done this session, stated plainly:**

- **`/admin/contacts`** is still the pre-P2 bare directory (number,
  displayName only) — the plan's "admin gets a full read + attribution view
  over all CRM data" requirement is unbuilt. A real gap, not an oversight.
- **P3's fuller scope is deferred**: the call popover as a shared view onto
  one SIP session (built instead: a plain Call button using the same
  `makeCall()`), incoming-call auto-opening the matching contact, and the
  `<900px` responsive collapse are all still open. `/agent/calls` and
  `/agent/missed` were left as separate pages, not folded together as the
  plan describes.
- **Steps 4 and 5 remain blocked on physical access**: the true re-pair test
  (logout port 1, scan a fresh QR) and pairing SIM ports 2-4 both need a real
  phone in hand for each number — no login level substitutes for scanning a
  QR code. Ports 2-4 remain in the "Pairing" state prepared in §28.

No code committed to git this session either (same standing instruction as
§27/§28) — everything above is live on the VPS, confirmed working, ahead of
`git log` on both the local tree and the VPS's own checkout.

## 30. Phase MM (manager merge), scoped down to auto-merge and deployed — NOT live-verified against a real call (2026-08-31, same day, follow-up to §29)

Operator decision: skip the QR-dependent steps (blocked on phone numbers that
don't exist yet — noted in `handoff.md`), proceed straight to Phase MM.

**Built and deployed:** `POST /api/calls/manager-merge` +
`ManagerMergePicker` (mounted in `call-controls.tsx`, next to the existing
`EscalationPicker`, both only rendered mid-call). Sourced from the same
`/api/agent/escalation-targets` list, filtered to managers with an
extension (no extension → shown, disabled, "not mergeable" — the existing
WhatsApp-ping affordance already covers that case one component up).

**Scoping decision, stated plainly rather than silently narrowed: this is
an AUTO-MERGE, not the plan's original consult-first flow.** Consult-first
needs the agent's and customer's channels split onto separate bridges
mid-call (a real private-hold mechanism) — nothing in this codebase does
that today, and inventing it and shipping it unverified against a live call
was judged too risky. What ships instead: customer + agent are AMI-Redirected
into the shared ConfBridge room first (reusing `findChannelsToRedirect`,
unchanged, from the existing generic conference route), *then* the manager
is Originated into the same room. This is what makes "the customer must
never hear hold-failure silence" true by construction — they're bridged
with the agent the entire time, including if the manager never answers, not
because of an explicit hold/unhold step.

**Manager-side caller ID** ("Conference Call - <Agent Name>", not the raw
extension) reuses the exact mechanism the generic conference route already
uses for its own third-party Originate — the AMI `CallerID` field, no
dialplan change. **No single-GSM-port guard was added**, deliberately: the
hazard that guard exists for (a second outbound call on an already-occupied
trunk port) is structurally impossible here, since this route only ever
Originates an internal `PJSIP/<extension>`, never anything routed through
Dinstar — confirmed by this reasoning before writing the route, per the
plan's own discovery pass.

**Answer/no-answer detection is best-effort, not guaranteed**: a true
blocking Originate would need `ami-client.ts`'s `send()` 5-second hardcoded
response timeout raised (out of this route's file scope), so the Originate
fires `Async: "true"` and the result is observed via `waitForEvent()`
matching `OriginateResponse`/`Exten` — the same class of "field may not be
present on this Asterisk version" caveat `findChannelsToRedirect`'s own
`BridgeId` dependency already carries in the pre-existing code. A timeout
here does not mean the merge failed, only that this observation couldn't
confirm either way in time — the response message says so explicitly.

**NOT done, stated plainly:**
- **Not live-verified against a real call** — no phone/SIP client was
  available this session to place a test call and click Merge. Deployed
  because it is fully opt-in (new route, new button, unreachable unless
  explicitly clicked) and cannot affect any existing call flow, but the
  actual merge mechanics — the Redirect, the Originate, the caller-ID
  display on the manager's phone, the `OriginateResponse` correlation —
  inherit the exact same "MEDIUM-LOW confidence, needs live testing"
  flag the underlying generic conference route has carried since Phase G.
- **MM4 (per-participant mute/hold) was not attempted, not partially built,
  not stubbed.** The plan's own risk section named this the likely-hardest
  part: the manager's leg is an `Async` Originate with no channel name ever
  captured, and per-participant mute needs an exact channel to target — "no
  channel id, no button." Attempting it without live-call verification
  ability risked shipping something that looks complete but silently
  doesn't work, which this project has been burned by before. Deliberately
  left for a session with real call access.
- **Manager "offline" detection was scoped out** — every manager with an
  extension shows selectable regardless of registration state; an
  unreachable extension surfaces as a real failure message after the
  attempt rather than a pre-emptive grey-out. Documented in the picker's
  own header comment.

All four gates (typecheck, 315 tests, lint, build) passed before every
deploy. No route-level unit tests were added — matches this codebase's
existing convention of testing pure logic in `src/lib/**`
(`findChannelsToRedirect` already has its own tests, reused unchanged) and
verifying routes live, which this route explicitly has not been yet.

No code committed to git this session (same standing instruction).

## 31. Sidebar/card-style nav + CRM integration across every agent page, deployed and live-verified — one real historical-data gap caught and left for the operator's call (2026-08-31, same day, follow-up to §30)

Operator direction: inspect the current UI (no Playwright MCP tool available
this session — substituted the already-authenticated claude-in-chrome
session, functionally equivalent for this purpose, stated plainly rather
than silently swapped in), convert the agent nav from the horizontal top-bar
links to a sidebar/card style, and integrate CRM context into the pages that
had none. Live call test explicitly deferred to last, per the operator.

**Sidebar.** `agent-shell.tsx` rewritten: the 6 nav destinations
(Contacts/Call/Calls/Voicemail/Missed/Chat) move from a single-line
horizontal text row into a fixed left `glass-card` rail with an icon,
label and badge per item, active-item highlight, matching the admin
section's own sidebar shape structurally (MUI `Drawer` there; Tailwind
here, since the agent surface hasn't gone through Phase M). Brand,
connection-status pill, Admin link, user email and sign-out all moved into
the sidebar's header/footer.

**CRM integration, four pages, all reusing the existing `Contact` id rather
than inventing a second identity scheme:**
- **`/agent/chat`** — every conversation row gets a "CRM" link to
  `/agent?contact=<id>`. Free: `GET /api/messaging/conversations` already
  returned `contact.id`, no backend change needed. The row's outer element
  changed from `<button>` to a `role="button"` `<div>` since a nested
  `<a>`/`Link` inside a real `<button>` is invalid HTML and breaks
  hydration — the link's own `onClick` stops propagation so it opens the
  contact instead of also selecting the conversation.
- **`/agent` itself** now reads `?contact=<id>` (via `useSearchParams()`)
  and auto-selects that contact on load — the landing point every other
  page's new CRM link needs. No Suspense-boundary build warning (this route
  was already fully dynamic/session-gated, not statically generated).
- **`/agent/calls` and `/agent/missed`** — `GET /api/me/calls` and
  `GET /api/me/missed-calls` both gained a `callerContactId` field (a local
  `numberE164 -> id` map built in each route, not merged into
  `src/lib/contact-display.ts`'s existing `resolveContactDisplayName()`,
  since that function's return contract — a display string — is read by
  3+ other routes and changing its shape for one new caller wasn't worth
  the churn). "View in CRM" renders only where a match exists.
- **The active/held call view (`/agent/call`)** — new
  `ActiveCallContact` component, looks up `incomingCallerId` against the
  CRM (`GET /api/agent/crm/contacts?q=`), shows "Contact: &lt;name&gt;" +
  a CRM link when found, "Unknown caller — Add to CRM" (one click, creates
  it) when not. Required one small, verified-safe fix to
  `sip-context.tsx`: `answerCall()` used to clear `incomingCallerId` the
  instant a call was answered, so the active-call view had zero identity
  to work with at all — confirmed by grepping every read site that this
  value is display-only and already gated on `callState === "ringing"`
  elsewhere, so leaving it set post-answer (only still cleared on
  hangup/decline) changes nothing else. **Not wired for outbound calls** —
  the dialed number lives inside `Dialpad`'s own local state, never shared
  up to `CallControls`; a real, separate gap, stated rather than papered
  over.

**A real, live-caught gap, not silently worked around: the
`callerNumberE164` historical backfill (built in §29,
`POST /api/admin/maintenance/backfill-caller-e164`) was built but never
actually invoked.** Confirmed via direct query: 0 of 42 `CallDetailRecord`
rows have it populated. This means `ContactDetail`'s timeline (which
filters by the stored `callerNumberE164` column) shows zero historical
calls for any contact, even though the SAME data correctly resolves and
links on `/agent/calls` (that route recomputes the match on every request
via `normalizeToE164`, never reads the stored column). **Deliberately not
fixed in-session**: running it needs an admin session, and the only
authenticated browser session available was the real agent account
`deepakt369b@gmail.com` — genuinely `Connected` with a live SIP
registration. Signing out to authenticate as admin would have dropped
that live softphone connection, and no attempt to fabricate or guess admin
credentials was made. This is a one-time, already-idempotent, one-click
fix (`POST /api/admin/maintenance/backfill-caller-e164`) waiting on either
the operator running it from `/admin` or a session where dropping the
agent connection is acceptable.

All four gates (typecheck, 315 tests, lint, build) passed before deploy.
Live-verified end to end, not just built green: the sidebar renders with
correct active-item highlighting on every page; the CRM deep link resolves
correctly from Chat, from Calls (confirmed against a real historical row,
`+971504852446`), and directly by URL; `/agent/voicemail` and
`/agent/missed` render cleanly under the new sidebar with a real,
`Connected` agent session (not the admin test account) — which also
incidentally confirmed `/api/me/calls`/`/api/me/missed-calls` work
correctly for an agent with a real linked extension, previously untested
this session since only the admin account (no extension) had been used.

No code committed to git this session (same standing instruction).

## 32. Pending deploy finished, S6 announcement WAVs generated + deployed, CRM/WhatsApp click-through pass — one real gap found (deal↔contact linking has no UI) (2026-09-03, follow-up to §31)

Resumed via `handoff.md`'s "claude continue" checklist. Live-call-specific
checks (screen-pop on a real inbound call, the disposition prompt) explicitly
deferred by the operator to a later session; everything else in the
checklist worked through.

**Deploy finished.** Commit `b056448` (admin Rooms fix)'s pending
`docker compose build` from the prior session-end was completed: `algo-web` +
`algo-cdr-listener` rebuilt and restarted on the VPS (user-approved —
production container restart), health `healthy`, 21/21 migrations applied,
none pending.

**WhatsApp session check.** `sim1-y3uzfs8s` already `ready` post-restart, no
manual kick needed. `sim2-4` remain `disconnected`/unpaired — unchanged,
operator-blocked on real phone numbers, not a regression.

**S6 recording-announcement WAVs — generated and deployed (user-approved —
production `asterisk` restart).** Neither `piper-tts` nor `sox`/`ffmpeg` were
available locally or on the VPS; installed `sox`/`ffmpeg`/`python3-venv` via
`apt` on the VPS, `piper-tts` into a throwaway venv (`/tmp/piper-venv`,
cleaned up after), downloaded the `en_US-lessac-medium` voice model from
Hugging Face. Generated both `pbx_configs/sounds/README.md`-specified
prompts, converted to 8kHz mono 16-bit PCM with `sox`, copied into
`pbx_configs/sounds/` on the VPS (gitignored, hand-deploy only — see the
README), `docker compose restart asterisk` — healthy afterward, files
confirmed present at `/var/lib/asterisk/sounds/en/custom/` inside the
container. Not yet live-call-tested (that needs an actual inbound/outbound
call through `[from-dinstar] s`/`[from-agent-common]` — deferred with the
rest of the live-call verification).

**Dinstar gateway "Failing" on `/admin/system`** — confirmed pre-existing,
not a regression: `res.status` 302 from `goip_get_status.html`, caused by
`DINSTAR_SMS_USERNAME`/`PASSWORD` still holding the stale `change-me`
placeholder (per prior-session memory, unrelated to today's Rooms/S6 work).
Left alone — not in scope, no fix requested.

**CRM + WhatsApp click-through (browser-driven, admin session via
claude-in-chrome, real prod data).** Contact detail (notes/tasks/disposition/
timeline) on `/agent`: confirmed working, a task created there appears in
the unified timeline immediately. Pipeline Kanban (`/agent/crm/pipeline`):
deal creation and cross-column drag-and-drop both work. WhatsApp
(`/agent/chat`): avatars, voice-note playback (`VoiceBubble`), inline images,
and infinite-scroll history pagination back through several weeks all
confirmed live against Sarath's and Deepak's real threads. `/admin/rooms`:
the Rooms fix from `b056448` confirmed live — avatars, "🎤 Voice message"/
"📷 Photo" previews, click-through to the `ChatThread` slide-over, all
correct. `/admin/reports`: both Telephony and CRM Insights tabs load and
correctly reflect live data (the test deal/task created during this pass
showed up immediately in the Pipeline funnel and Follow-up tasks widgets).
Test artifacts cleaned up after: task marked complete, test deal dragged to
"Qualified" (drag to "Lost" didn't take after a horizontal-scroll, deal was
left there, clearly named "click-through test deal" — harmless).
Mobile 390px viewport check was **not completed** — `resize_window` didn't
visibly affect the claude-in-chrome extension's screenshot capture, and
switching to a separate chrome-devtools MCP browser would have meant a fresh,
un-authenticated session; not chased further, low value for the time cost.

**Real gap found — deal↔contact linking has no UI**, despite being fully
supported server-side. `DealCreateSchema`
(`src/lib/crm/deals.ts`) accepts a `contactId` and links it as the deal's
primary contact on create; `createDeal()` already writes the
`DealContact`/`isPrimary` join row when given one. But
`PipelineBoard`'s "New deal" dialog (`src/components/crm/pipeline-board.tsx`)
only exposes Name and Value — no contact picker — and `DealCard` has no
click handler, so there's also no way to open a deal afterward to link a
contact retroactively (`DealPatchSchema` doesn't even accept `contactId` for
a PATCH). Net effect: the "contact → create deal … confirm it shows in the
contact's timeline" flow the operator's checklist describes doesn't
currently work end-to-end — a deal created today shows "No deals linked" on
the contact it was meant for. Not fixed this session (pending operator
priority call); flagged here and to the operator directly.

No code committed to git this session (same standing instruction — the only
changes were the two generated WAV files, which are gitignored and live only
on the VPS).

### 32.1 Deal↔contact linking fix + sidebar label fix, deployed (same day, direct follow-up)

Operator asked for two fixes off the gap found above, plus a UI nit noticed
separately: the agent sidebar labeled `/agent/calls` (call history) just
"Calls", immediately under "Call" (the dialer) — confusing. Both fixed and
deployed.

**Deal↔contact linking.** New `ContactPicker` component in
`src/components/crm/pipeline-board.tsx` — debounced search-as-you-type,
reuses the existing `/api/agent/crm/contacts`/`/api/admin/contacts` search
endpoints (no new search API; picked which one by prefix-matching `apiBase`,
since the admin one predates the `/api/admin/crm/*` namespace and isn't
under it). Wired into both the "New deal" create dialog and a new "Edit
deal" dialog, the latter opened by making `DealCard` click-to-open
(`role="button"`, guarded against firing mid-drag via `isDragging`, and the
mobile stage `<Select>` gets `stopPropagation` so it doesn't also open the
dialog). `DealPatchSchema` gained `contactId`; `patchDeal()` in
`src/lib/crm/deals.ts` replaces the deal's one linked contact (delete then
create `DealContact`, `null` unlinks) when `contactId` is present in the
patch — mirrors the existing replace-not-append shape `createDeal()` already
used.

Live-verified against production data, not just gate-green: linked Sarath
to the existing "click-through test deal" via the Edit dialog, confirmed
it showed in Sarath's contact page under Deals as `(primary)` with the
right stage — checked twice, since the *first* attempt silently failed
(turned out to be a coordinate-based UI-testing miss on my end, clicking
the wrong pixel on a shifted dialog, not a code bug — confirmed by
querying `DealContact` directly both times). Then unlinked via the
picker's ✕ and confirmed the row was gone from the DB. One operational
note for later sessions: this 2-vCPU VPS showed a PATCH stuck on
"Saving…" in the UI for several seconds under concurrent load (a
simultaneous SSH DB query) during this test — resolved on its own with a
200, not a bug, just a slow box.

**Sidebar label**: `src/components/agent-shell/agent-shell.tsx`'s nav item
for `/agent/calls` relabeled "Call History" (was "Calls"), matching the
page's own `<h1>Call history</h1>`.

Deployed: synced the 3 changed files to the VPS (tar, not a git pull —
matches this session's earlier pattern), `docker compose build web` +
restart (both user-approved — production container restart), `algo-web`
healthy. All four gates green before deploy: typecheck, 357 tests, lint,
build.

No code committed to git this session (same standing instruction).

- 2026-09-03 (same day, part 3) — **Dinstar gateway syslog (Remote Server)
  feature: built and gated green, NOT deployed, live traffic unconfirmed.**
  Descoped from an earlier, unusable draft (which assumed a Connectivity
  page / multi-site / OpenVPN model that doesn't exist in this repo — that
  remains a separate future task) down to the current single-gateway-over-
  Tailscale architecture. Live-diagnosed directly against the real
  gateway's web UI (`192.168.11.1`) and via VPS `tcpdump`: found the real
  feature is **Diagnostic → Syslog** (not the generic Tools → Remote
  Server page — no port/level fields there), configured it
  (`100.64.32.115:5514`, level INFO, Signal+System+Management Log),
  confirmed it saves and **persists through a full gateway reboot**
  (operator-approved, ~36s downtime). Confirmed no NTP on the gateway
  (its clock read `2025-12-17`). **Zero UDP/TCP traffic was ever observed
  arriving at the VPS**, despite trying a reboot, a config re-save, a
  port block/unblock toggle, and a Mobile-Call-Test attempt (each
  confirmed to have reached the device via its own on-box **Web Operation
  Log**) — the operator's SIM was ejected mid-diagnosis, deferring the
  actual root-cause resolution to a later session with a real GSM event
  available to trigger. New: `GatewayEvent` model + migration (hand-
  authored `migration.sql`, explicitly flagged unverified — needs a real
  `prisma migrate diff`/`migrate deploy` per §P2's pattern before trust);
  `src/lib/dinstar/syslog-parse.ts` (defensive RFC-3164-shaped parser,
  built WITHOUT a real captured sample — header says so explicitly, 28
  synthetic-fixture unit tests); `scripts/gateway-syslog-listener.ts` (dumb
  UDP forwarder, host-networked, Tailscale-IP-only bind) + its Docker
  target/compose service/ufw rule; `POST /api/gateway-events` ingest
  (bearer-secret auth) which also triggers real-time alerts via new
  `src/lib/dinstar/gateway-alerts.ts` (pure, unit-tested; first version
  alerts on first occurrence per critical type rather than the plan's
  burst/duration thresholds — no historical state yet to compute those);
  30-day retention folded into the existing prune route
  (`COMPLIANCE.md`, new file, PDPL note on phone numbers in gateway
  messages); `/admin/system` "Gateway events" panel + a **dedicated** new
  alert banner (deliberately not reusing the top-bar `HealthPill`, already
  pinned "fail" by the unrelated pre-existing `DINSTAR_SMS_*` `change-me`
  gap); `GATEWAY_ALERT_EMAIL` registered in the settings UI. **Merge-step
  verification (independent re-check of the parallel build, not just
  trusting the workers' self-report) caught two real bugs before they
  shipped**: (1) `web`'s own `docker-compose.yml` environment block was
  missing `GATEWAY_INGEST_SECRET` — the receiver's service block had it,
  `web`'s didn't, so `isAuthorizedIngest()` would have read `undefined` and
  401'd every real ingest in production; fixed by adding it to `web`'s
  block alongside `CDR_INGEST_SECRET`. (2) the alert gate's
  `resendConfigured` check used `Boolean(await getSetting("RESEND_API_KEY"))`,
  which treats the literal `"change-me"` placeholder as a configured key
  (non-empty string) — meaning alerts would silently attempt a real,
  doomed Resend API call instead of cleanly no-op'ing per the plan's
  explicit "ship in-app alerts only, record blocked-on-secret" requirement;
  fixed with a new `isConfiguredSecret()` helper in `gateway-alerts.ts`
  (4 new unit tests) that treats the placeholder as unconfigured. Also
  de-duplicated a hardcoded `CRITICAL_TYPES` copy in
  `/api/admin/gateway-alerts` into a shared `CRITICAL_ALERT_TYPES` export.
  All four gates green after these fixes: typecheck, 397 tests, lint,
  build. Full detail in `handoff.md`'s "2026-09-03 session, part 3". Not
  deployed, not committed to git.

- 2026-09-03 (same day, part 4) — **Syslog feature deployed; Extensions/
  Dinstar merge deployed; admin-visibility + full country-code fix built,
  deployed, live-verified; `git push` H4 resolved (operator approved,
  `1a469a6`/`1289099`/`ba3273f`/`f2fbe54` all pushed).** Syslog deploy:
  VPS git tree had ~40 commits of uncommitted local drift from past
  sessions — backed up via BOTH `git stash -u` (kept, not dropped — still
  unreviewed on the VPS, flagged for a future session) and an independent
  patch-file export before a clean fast-forward pull; `web` +
  `gateway-syslog-listener` rebuilt/started, `20260903180000_add_gateway_event`
  confirmed applied by name, listener confirmed bound to the Tailscale IP
  only via `ss -ulnp`, firewall rule active. Live traffic still
  unconfirmed (SIM ejected mid-diagnosis). Extensions/Dinstar merge:
  `/admin/dinstar` now tabs Gateway/Extensions, `/admin/extensions`
  redirects, `web` rebuilt, no migration. Admin-visibility fix: operator
  reported (screenshots) Admin showing as a normal user on `/admin/users`
  and as a selectable contact owner — `/admin/users` now filters
  `role !== "ADMIN"` before rendering (operator explicitly chose "hide
  entirely" via `AskUserQuestion`), `admin/contacts/page.tsx`'s
  `activeAgents` excludes ADMIN too (fixes every owner-assignment surface
  in that file from one change); new `src/lib/countries.ts` builds the
  full ~245-country list via `libphonenumber-js`'s `getCountries()` +
  `Intl.DisplayNames`, both Contacts and DNC bulk-import switched from a
  2-country `<select>` to the existing searchable `Combobox` primitive.
  Live-verified via `claude-in-chrome` against production. Mid-session:
  CLI `git` got blocked by a Windows Application Control policy
  (`error launching git: An Application Control policy has blocked this
  file` — Bash and PowerShell both, and the operator's own terminal hit
  the identical error; not visible in Windows Security's Protection
  history since WDAC/AppLocker log elsewhere). PowerShell's `git`
  recovered on its own partway through and was used for the rest of the
  session; Bash's stayed blocked. Full detail in `handoff.md`'s
  "2026-09-03 session, part 4".

- 2026-09-03 (same day) — **OpenVPN-primary / Headscale-fallback /
  connectivity feature: BUILT, all four gates green, NOT deployed.**
  Explicitly supersedes the syslog task's earlier Tailscale-only
  descoping — operator decision. Task graph (7 subagent nodes, one retry
  after Node G's first run did no real work — echoed a coordinator-style
  status instead of building — caught immediately since I independently
  verify every worker's actual files rather than trusting self-reports,
  same discipline that caught 2 bugs in the syslog task's merge).
  Live-verified before building: gateway LAN IP is `192.168.11.1` (not
  the stale `.20` from old notes — confirmed by ping from both this
  machine and the VPS); the Dinstar's embedded OpenVPN client is old
  firmware (its VPN Parameter page offers zero cipher/auth negotiation —
  a fixed-suite old client), so the server config deliberately targets
  legacy compatibility (`AES-256-CBC`/`SHA256`/`tls-version-min 1.0`)
  instead of modern AEAD defaults that would silently fail to handshake;
  the live VPN form is genuine static HTML (unlike the SIM-port page's
  documented unverifiable gap), so a real GET-and-parse read-back
  verification was buildable and was built; `DINSTAR_WEBUI_USERNAME/
  PASSWORD` already existed as global settings and already satisfied the
  "unify credentials" requirement with zero new fields;
  `provisionDinstarConfig()` already does everything the cutover needs
  (both the SIP trunk and the SMS provider move together, AMI-verified)
  and was reused completely unmodified. Built: `GatewaySite` model +
  migration; `openvpn-server`+`openvpn-bridge` (kylemanna/openvpn, a
  file-drop PKI-request bridge so the web app never holds a Docker socket
  or stores private keys in Postgres); `headscale` server + a `vpn.<domain>`
  Caddy block (extending the existing `domain/apply` render function, not
  a parallel mechanism — real gap found and flagged: no existing
  Cloudflare DNS-upsert to extend, so the A record is a documented manual
  step, not fabricated automation); a hand-built RFC 2388 multipart push
  capability with genuine HTML read-back verification; `/admin/connectivity`
  (site table, Add-site wizard following the existing `gateway-tab.tsx`
  Step-union pattern, an always-visible runbook); a 60s connectivity
  poller extending the existing `gateway-alerts.ts` pipeline (two honest
  deviations: TCP:80 probe instead of ping since Alpine has no ping
  binary, and Headscale node status returns null/"not checked" rather
  than fabricated, since checking it needs a Docker socket the app
  deliberately doesn't have); syslog-listener dual-homing for the
  transition window; a cutover mechanism that's grep-confirmed reachable
  from nowhere automated. **Independent V1 security review (fresh
  subagent, no prior context) found 3 real issues, all fixed, gates
  re-run clean**: (1) medium — a stale-sentinel cleanup silently no-op'd
  against a directory mounted read-only into `web` by design, fixed by
  moving the cleanup into the bridge script which has real write access;
  (2) low — one route was missing the defense-in-depth filename
  re-validation its siblings all had (currently unexploitable, fixed
  anyway); (3) medium — the cutover function claimed success and set
  `transport: "OPENVPN"` even when trunk-reprovisioning verification
  failed, fixed to gate `transport` on `provision.verified` and return
  HTTP 502 on an unverified push — deliberately without an automatic
  `DINSTAR_LAN_IP` rollback, since an unverified rollback could leave
  Postgres and the live Asterisk config in a worse disagreement than
  surfacing the failure for the human G2 operator. All four gates green:
  typecheck, 435 tests, lint, build. **Not deployed, not committed.** G1
  (infra deploy, reversible, no call-path risk) awaiting operator
  go-ahead; G2 (the live, human-supervised cutover) explicitly deferred
  to a joint session per the plan's own framing — same pattern as the
  syslog task's live diagnosis. Full detail in `handoff.md`'s "OpenVPN/
  Headscale/connectivity" session; plan at
  `~/.claude/plans/currently-we-need-a-nifty-lightning.md`.
- 2026-09-03 — **OpenVPN/Headscale G1 deployed + CA bootstrapped (part 2).**
  Committed the merged feature (`ae7094f`) and pushed G1 to the VPS; not
  clean on the first live try — 6 real bugs found and fixed only by
  actually running the containers, none of them caught by the gates
  (typecheck/tests/lint/build can't see a shell-less base image, a wrong
  CLI flag, or an OpenVPN directive that doesn't exist in the installed
  binary version): (1) `headscale/headscale:0.23.0` is a `ko`-built
  distroless image with no shell at all — the custom `Dockerfile.headscale`
  (`apk add gettext`) couldn't work, deleted it and switched to a host-side
  `render-headscale-config.sh` + static bind-mount, mirroring
  `render-caddy-env.sh`'s existing pattern; (2) Headscale wouldn't start —
  missing required `noise.private_key_path`, added alongside
  `private_key_path`; (3) IP-prefix churn — first tried `100.100.0.0/16`
  (correct), I second-guessed it as a Tailscale-range collision and
  "corrected" to `10.100.0.0/16`, Headscale itself rejected that as
  unsupported, reverted to `100.100.0.0/16` (its own preference is the
  stronger signal than generic collision instinct — doesn't overlap the
  real Tailscale peers anyway); (4) `init-pki.sh`/`bridge-watch.sh`
  committed without the executable bit (Windows doesn't track it) — fixed
  via `git update-index --chmod=+x`; (5) **the big one** — `ovpn_genconfig
  -c AES-256-CBC -a SHA256` was flat wrong: `-c` is actually a boolean
  client-to-client flag, not a cipher flag, so the generated
  `openvpn.conf` had neither `cipher` nor `auth` at all, silently defeating
  the entire legacy-client-compatibility point of this feature; also no
  `-s` was passed so the subnet was kylemanna's default
  (`192.168.255.0/24`) instead of the `10.8.0.0/24` every other piece of
  this feature assumes. Fixed by passing `-s 10.8.0.0/24 -d -b -D` and
  appending `cipher`/`auth`/`tls-version-min` directly to the config
  instead of trusting genconfig flags a second time; (6) two directives
  that don't exist on the server's actual installed OpenVPN 2.4.9 binary
  crash-looped the container in turn — `data-ciphers-fallback` (2.5+) and
  `status-cadence` (2.6+) — both removed, `status`/`status-version 2`
  alone is sufficient. Server then came up clean (`tun0` at `10.8.0.1`,
  UDP 1194 listening). **CA bootstrap**: operator explicitly rejected
  `nopass` — the CA is the root of per-customer tenant isolation, a
  compliance requirement, not just a nicety — so the CA key is
  passphrase-protected, typed interactively by the operator, never
  written to any file/env/log by me. Encryption-at-rest proven live
  (`openssl rsa -in pki/private/ca.key -check -noout` fails without the
  passphrase). **Interim hard rule** added to `bridge-watch.sh`:
  unattended cert issuance is disabled outright (not worked around) —
  every new cert is issued by an admin typing the CA passphrase manually
  — until a separately-planned "CA signing flow v2" task (not started,
  must be brought to the operator for review before any building begins).
  First cert issued (`cust-demo-gw-1`, establishing the `cust-<id>-gw-<n>`
  per-customer CN convention) surfaced a 7th, related bug: the generated
  `.ovpn` was also silently missing `cipher`/`auth` — `ovpn_getclient`
  reads `ovpn_env.sh`, a different file than the one the server-side fix
  touched. Patched `ovpn_env.sh` directly and folded the fix into
  `init-pki.sh` so future deploys don't need the same manual patch;
  confirmed via grep the generated `.ovpn` now carries
  `cipher AES-256-CBC`/`auth SHA256` with no `redirect-gateway`. All
  services confirmed healthy on the VPS (`web`, `gateway-syslog-listener`,
  `headscale`, `openvpn-server`, `openvpn-bridge`). 10 local commits
  (`c2fe808`..`b11cc0c`), deployed to the VPS directly; **not yet pushed
  to GitHub** (CLI `git push` intermittently blocked by a Windows
  Application Control policy on `libcurl-4.dll` all session — ask fresh
  next session). Next: G2 — push `cust-demo-gw-1.ovpn` to the real
  gateway and confirm a real tunnel handshake. Full blow-by-blow in
  `handoff.md`'s "OpenVPN/Headscale/connectivity, part 2" section.
- 2026-09-05 — **Public website for saharatechs.com — built, gated green, and deployed to production.** Plan: `~/.claude/plans/task-public-website-for-radiant-shore.md`. New standalone `website/` (Next.js 14.2.35, `output: "export"`, own `package.json`/build — never shares a build failure with `algo-pbx-frontend`), reusing the app's Apple-black CSS-variable token system and theme-provider pattern verbatim (distinct localStorage key `saharatechs-theme-mode`). Four pages: landing (hero/how-it-works-as-inline-SVG/features/one AED-500-per-month pricing card/FAQ via Headless UI `Disclosure`/contact), `/terms`, `/privacy` (both PDPL-aligned drafts with `[ENTITY]`/`[JURISDICTION]` placeholders — support-access language matches the real `SupportGrant`/`PlatformAuditLog` mechanism in `prisma/schema.prisma`, not an aspiration), `/docs`. Gates: `npx tsc --noEmit` clean, `next lint` clean (after escaping a handful of unescaped quotes/apostrophes JSX flagged), `npm run build` clean static export, Playwright 20/20 (Desktop Chrome + iPhone 13 × light/dark for all 4 pages, no horizontal scroll at 375px, all internal links resolve) — screenshots visually spot-checked. Confirmed `algo-pbx-frontend`'s own `npm run typecheck` stays clean (CLAUDE.md's "prove the app is unaffected" requirement).
  Caddy generator change: `renderCaddyfile()` in `POST /api/admin/settings/domain/apply/route.ts` now derives an apex domain by stripping a `pbx.` prefix off `VM_PUBLIC_DOMAIN` (returns `null`/no-op otherwise, so a deployment without that prefix gets byte-identical output to before) and, when present, adds `http(s)://<apex>` (`file_server` on `/srv/website`) plus a `www.<apex>` redirect — the `pbx.` block itself is untouched. `docker-compose.yml`'s `caddy` service gained one new read-only bind mount (`./website/out:/srv/website:ro`).
  Both plan gates run for real, not skipped: **Gate A** (legal review) — operator approved the drafts with `[ENTITY]`/`[JURISDICTION]` left as placeholders rather than blocking on it. **Gate B** (Caddy diff) — diff + a dry-run render shown before touching anything; `caddy validate` couldn't run locally (no `caddy` binary or Docker on this dev machine) so it ran for real on the VPS instead, against the actual `algo-pbx-caddy` image with the real `caddy.env`, and passed ("Valid configuration") before any file was touched.
  **Real blocker found mid-session, not assumed away:** live `nslookup` showed `saharatechs.com` resolving to `217.165.236.207` — a separate, already-existing site — directly contradicting the approved plan's premise that the apex A record was already free. This matches a standing memory from an earlier session warning explicitly never to repoint that record at the PBX. Stopped and asked the operator rather than proceeding on the plan's stale assumption; operator confirmed the other site is being retired and repointing is fine, but the actual Cloudflare DNS edit is a manual step (no automated Cloudflare write-path exists anywhere in this codebase, same gap already documented for `vpn.<domain>`) — **not done this session, and not something I hold the credential for.**
  **Deploy, done for real on the VPS, not just gated:** the live `pbx_configs/generated/Caddyfile` turned out to be the hand-patched 2026-09-01-incident recovery version (its own header says so) — its `saharatechs.com` block was reverse-proxying to `web:3000` (the PBX app itself), not serving a separate site, and it was missing the Headscale `vpn.` block the current generator code would otherwise emit. To keep blast radius minimal, edited the **live file surgically** (only the apex block replaced with the file_server + www blocks; the `pbx.` block copied byte-for-byte, confirmed via `diff` against the pre-edit backup) rather than regenerating the whole file fresh — avoids reintroducing or removing unrelated drift. Sequence: `website/out` built inside a one-off `node:20-alpine` container (no Node on the VPS host itself, matches the established pattern for one-off builds against this stack), `Caddyfile` copied to `Caddyfile.bak`, new file `caddy validate`'d clean, installed, `docker compose up -d --no-deps caddy` (also picks up the new bind mount from the already-synced `docker-compose.yml`). Verified with `curl --resolve <name>:443:127.0.0.1` (since public DNS doesn't route here yet): apex 200 serving the real marketing `<title>`, `pbx.` 200 serving the app's login page, `www` 301-redirects to the apex, and Caddy's own log shows a genuine Let's Encrypt cert issued for `www.saharatechs.com` via Cloudflare DNS-01 (which doesn't require the A record to point here — DNS-01 only needs the API token). Confirmed the WebSocket-regression class from 2026-09-01 structurally cannot recur here since the `pbx.` block was never touched (verified via `diff`, not just claimed) — separately noted the actual agent WSS console connects directly to Asterisk on `:8089`, an entirely different port from anything Caddy's HTTP(S) blocks touch, so it was never at risk from this change regardless.
  Committed locally (`054fdcd`, not pushed — same standing "no push without explicit go-ahead" instruction) and synced to the VPS via `scp`/tar (same established pattern as prior unpushed-commit deploys this week), matching the VPS's existing worktree exactly (`git status --short` clean apart from the same pre-existing untracked migration folder from wave 1). **Remaining, blocked on the operator alone:** the actual Cloudflare A-record repoint for `saharatechs.com`, and a re-verification of all four checks against the real public domain (not `--resolve`) once that's done.

- 2026-09-05 — **First SaaS owner account bootstrapped (`algopbx@saharatechs.com`, PLATFORM_OWNER)**, plus a redesign of Wave 3's platform enrollment flow to get there safely. The original `scripts/create-platform-user.mjs create`/`confirm` pair (2026-09-04) took the new account's password as a CLI argument and did TOTP enrollment out-of-band via a second script invocation — workable, but the operator explicitly wanted the script to generate its own one-time password (never passed as an arg, never logged) and wanted TOTP enrollment to happen in-browser at first login, where the authenticator app actually is. Changes, all committed (`a3f3f17`, not pushed):
  - **Schema**: `PlatformUser.mustChangePassword Boolean @default(false)` (migration `20260905090000_add_platform_user_must_change_password`, additive-only — every already-onboarded row is unaffected since the default is false).
  - **`scripts/create-platform-user.mjs` rewritten**: now `--email`/`--role`/`--name`/`--reason` flags, no password argument at all — generates a 24-byte random one-time password itself (`crypto.randomBytes(24).toString("base64url")`), prints it to the terminal exactly once, sets `mustChangePassword: true` and clears any existing `totpSecret`/`totpConfirmedAt` (so a re-run for password reset also forces re-enrollment). Writes a `PlatformAuditLog` row (`action: "platform.user.create"`, caller-supplied `reason`, `platformUserId: null` — the actor is the script itself, not the not-yet-logged-in account, recorded instead in `metadata.actor`). The old `confirm` subcommand is gone entirely; TOTP enrollment no longer happens here.
  - **`platform-auth.ts`'s `authorize()`**: the TOTP `code` field is now optional (schema: `z.union([regex, z.literal("")]).optional().default("")`). An account with `totpConfirmedAt` already set still requires a valid code, exactly as before — unenrolled accounts may log in on password alone, producing a session that `requirePlatformSession()` immediately restricts.
  - **`platform-guard.ts`**: split into `requireLiveSession()` (session-shape + `disabled` check only) underlying two exported guards — `requirePlatformSession()` (used by every real console route; now ALSO 403s with `{setupRequired: true}` unless `totpConfirmedAt` is set AND `mustChangePassword` is false) and the new `requirePlatformSetupSession()` (session-valid-and-not-disabled only, no completion requirement — used exclusively by the setup screen and its two APIs, since requiring setup-complete of the setup flow itself would be circular).
  - **New `/platform/setup` screen** (`src/app/platform/setup/{page,setup-form}.tsx`): server component generates-and-persists a TOTP secret idempotently (reused across reloads, never regenerated once set) and renders whichever step is still outstanding — password change first, then TOTP (otpauth URI shown as selectable text, no QR image library added, matching `platform-totp.ts`'s existing "text is sufficient" design note). Two new guarded routes: `POST /api/platform/setup/password` (12-char minimum — stricter than the tenant plane's 8, since this is the highest-privilege account in the system) and `POST /api/platform/setup/totp/confirm`; both audit-log under the authenticated user's own id (`platform.user.password_change` / `platform.user.totp_confirmed`, reason `"self-service setup"`). `/platform/page.tsx` now routes through `requirePlatformSetupSession()` first and redirects to `/platform/setup` when either flag is still outstanding, `/platform/login` only when there's no session at all.
  - `npm run typecheck` / `npm run test` (490/490) / `npm run build` all clean before deploy.
  - **Deployed for real** (operator confirmed via `AskUserQuestion` before any VPS action): the 11 changed files synced to `/opt/algo-pbx` via the same scp/tar pattern as the apex-site deploy above (git working tree on the VPS already had unrelated uncommitted edits from that session — confirmed zero file overlap before copying, so nothing there was touched). `docker compose build web` + `docker compose up -d --no-deps web` — the container's own entrypoint ran `prisma migrate deploy` on start and applied exactly the one new migration cleanly, then came up healthy. Bootstrap script run via a one-off `docker build --target builder` image (the `runner`/production image has no `scripts/` directory at all, confirmed the hard way first — `MODULE_NOT_FOUND`), `--entrypoint node` override (never plain `docker compose run`, per the standing lesson in the wave-1-migration entry above about the entrypoint script otherwise falling through to a second live app server), on the actual `algo-pbx_algo-net` network (name confirmed via `docker inspect`, not assumed) with `PRISMA_QUERY_ENGINE_LIBRARY` pointed at the `openssl-3.0.x` engine binary explicitly (same musl/openssl auto-detection bug the wave-1 backfill hit, same fix). Temporary builder image and tar files cleaned up after.
  - **Verification evidence collected**: `PlatformUser` row confirmed via direct `psql` query (email/role correct, `mustChangePassword=true`, TOTP unconfirmed, not disabled — passwordHash/totpSecret not selected/shown). `PlatformAuditLog` row confirmed (`platform.user.create`, reason `"initial owner bootstrap"`, actor recorded in metadata). `SELECT count(*) FROM "User" WHERE email=...` returned 0, confirming structurally (not just by inspection) that this account cannot authenticate at the normal tenant login page — `src/auth.ts` only ever queries the `User` table, never `PlatformUser`.
  - **Still the operator's own step, not something I can do for them**: logging in at `https://pbx.saharatechs.com/platform` with the one-time password, completing the forced password change, and confirming TOTP with their own authenticator app — that live 6-digit code can only come from a device I don't have access to. A screenshot of the owner console loading after that is the operator's to capture, not mine.

- 2026-09-05 (same day, follow-up) — **Owner login actually verified live, and a real pre-existing bug found + fixed in the process, not just the password typo the operator hit first.** During the operator's first-login attempt, the password kept failing even after (a) confirming via direct `psql`/`bcrypt.compare` that the stored hash matched the given one-time password exactly, and (b) reproducing a SUCCESSFUL login via raw `curl` straight to `/api/platform-auth/callback/credentials` on both `localhost:3000` and the real public `https://pbx.saharatechs.com` domain. That split (backend proven correct, browser still failing) pointed at the client, not the server. Loaded `mcp__chrome-devtools__*` and drove the actual login page directly: `list_network_requests` showed the real POST going to **`/api/auth/callback/credentials`** — the TENANT plane's endpoint — not `/api/platform-auth/*` at all, despite `login-form.tsx`'s `signIn("credentials", {..., basePath: "/api/platform-auth"})` call appearing to target the platform instance.
  **Root cause, read directly from `node_modules/next-auth/react.js` (v5.0.0-beta.32, not assumed):** `signIn()`'s `options` object has no `basePath` handling at all — any `basePath` key passed in silently falls through into `...signInParams` and gets sent as an inert POST body field. The URL `signIn()` actually posts to is always built from a **module-level singleton**, `__NEXTAUTH.basePath`, which is set only by whichever `<SessionProvider basePath="...">` last rendered. The root layout's tenant-plane `AuthSessionProvider` (`src/app/layout.tsx`, wraps the ENTIRE app including `/platform`) sets that singleton to the tenant default (`/api/auth`) and nothing under `/platform` ever overrode it. So every platform login attempt, since Wave 3 was first built on 2026-09-04, was authenticating against the tenant `User` table's Credentials provider, not `PlatformUser` — silently doomed to fail (or worse, succeed against a same-email tenant `User` row, had one existed) regardless of password correctness. This was never caught before because the account never existed until this session.
  **Fix** (`971345d`): rewrote `login-form.tsx`'s submit handler to bypass `next-auth/react`'s `signIn()` entirely for this form — a direct `fetch()` of `/api/platform-auth/csrf` then `/api/platform-auth/callback/credentials`, mirroring exactly what `signIn()` does internally but hardcoded to the right base path, so it's immune to the shared-global-singleton hazard regardless of provider mount order or which layouts happen to be mounted. Verified by driving the real fix myself end-to-end via `mcp__chrome-devtools__*` (fill email/password, click submit, `take_snapshot` confirmed a clean redirect to `/platform/setup`) before handing back to the operator, who then completed the real password change and TOTP enrollment with their own authenticator app. Final DB check: `mustChangePassword=false`, `totpConfirmedAt` set, `disabled=false` — operator confirmed the owner console loaded.
  **Lesson for any future NextAuth v5-beta code with more than one instance in one app**: never trust `signIn()`/`signOut()`'s options object for anything beyond `redirect`/`callbackUrl`/provider-specific credentials — cross-check against the installed version's actual `react.js` source before assuming an option like `basePath` does what its name suggests, and prefer a direct `fetch()` of the known endpoint when more than one NextAuth instance shares a page tree.
