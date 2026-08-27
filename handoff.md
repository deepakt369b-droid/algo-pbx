# Handoff — FIRST CALL CARRIED. Six-bug root cause of "no call ever worked" found & fixed.

Last updated: 2026-08-27 (third same-day follow-up). Full detail in
`LLM.md §17` and the plan file
`~/.claude/plans/objective-currently-there-is-virtual-catmull.md`.

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

## Still pending (plan order)

1. Deploy the rebuilt Asterisk image (A5 + B3b entrypoints, res_srtp).
2. **Track C gateway config** — log into the Dinstar web UI at
   `192.168.11.1`, set the inbound route to a fixed destination and turn
   OFF two-stage dial / secondary dialtone (the "rings once then asks for
   an extension" symptom — issue #6). Then a real inbound GSM test call.
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
