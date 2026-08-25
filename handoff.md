# Handoff — VirtualBox-aware port guide rewrite

Last updated: 2026-08-25. Full changelog in `LLM.md` Build Log (newest entry);
this file tracks what was done and what still needs a human.

## What was asked (latest session, 2026-08-25)

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
