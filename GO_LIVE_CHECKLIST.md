# Algo PBX — Go-Live Checklist

Everything that must be **verified on the real Linux VM** before the system
carries customer traffic, in dependency order. Nothing here can be signed
off from a dev machine: the single biggest risk in this project is code
that compiles and typechecks but has never touched a live Asterisk.

Legend: each item needs a ✅ with date + initials when done. "Blocker" items
stop go-live; "pre-live" items should be done but a documented exception is
acceptable for an internal trial.

---

## Gate 0 — Deploy hygiene

- [ ] **BLOCKER** `.env` bootstrap section fully filled; every `change-me`
      / `REPLACE_ME_*` gone:
      `POSTGRES_PASSWORD`, `SETTINGS_ENCRYPTION_KEY`, `COTURN_AUTH_SECRET`,
      `AMI_SECRET`, `CDR_AMI_SECRET`, `CDR_INGEST_SECRET`, `AUTH_SECRET`,
      `OPENWA_API_MASTER_KEY` (≥32 chars), `OPENWA_WEBHOOK_SECRET`,
      `SMS_POLL_SECRET`; runtime secrets via `/admin/settings`.
- [ ] **BLOCKER** `grep -r REPLACE_ME pbx_configs/` returns nothing.
- [ ] **BLOCKER** Real TLS cert in `pbx_configs/keys/` (Let's Encrypt via
      DNS-01 per `DEPLOYMENT.md §2`); browser trusts `https://` AND a
      softphone registers over `wss://` without certificate warnings.
- [ ] Certbot renewal cron installed **with the deploy hook restarting
      asterisk + coturn + caddy** (`DEPLOYMENT.md §2`) — otherwise all three
      serve the expired cert after ~60 days and the outage will confuse
      everyone.
- [ ] `docker compose up -d`: all seven containers healthy
      (`postgres coturn asterisk web cdr-listener openwa caddy`);
      `/admin/system` green on every check.
- [ ] Prisma migrations verified: `prisma migrate diff` (or `migrate status`
      in-container) clean against the live DB; no drift errors in web logs.
- [ ] Leftover test account deleted: `verify-admin@algopbx.local`
      (`PATCH /api/admin/users/[id]` disable → then remove via DB, or leave
      disabled if kept deliberately).
- [ ] `scripts/setup-firewall.sh` applied; from an outside network confirm:
      443/8089/3478 reachable, 5060/5038/5432 NOT reachable publicly,
      5060 reachable over Tailscale only.

## Gate 1 — Live call path (the highest-priority verification in this repo)

Nothing below Gate 1 matters until one call works end to end.

- [ ] **BLOCKER** Provision a dummy agent via `/admin/users` (password +
      auto extension). Confirm `pjsip_dynamic.conf` gained the endpoint and
      `pjsip show endpoints` (AMI) shows it available after browser login.
- [ ] **BLOCKER** Outbound: agent dials a real UAE number → Dinstar SIM →
      two-way audio. Check jitter/MOS in CallQualitySample table afterwards.
- [ ] **BLOCKER** Inbound: call a SIM → `from-dinstar` → queue → agent rings
      → answer → two-way audio.
- [ ] Hold/resume plays MOH to the other party (`moh/default/` has files!),
      silence otherwise (known gap until operator adds licensed audio).
- [ ] Blind transfer completes; attended transfer completes and cancels
      cleanly; 3-way conference merges (this exercises `BridgeId` +
      ConfBridge redirect — the least-verified path in the codebase).
- [ ] Supervisor listen/whisper/barge on a live call, correct channel picked
      from `/api/channels`.
- [ ] Wallboard active-calls count matches reality during a call (verifies
      `Linkedid` presence on CoreShowChannels).
- [ ] CDR row appears within seconds of hangup (cdr-listener → /api/cdr);
      recording file exists under `recordings/` and plays back in admin CDR
      view.
- [ ] Agent-side recordings list shows own calls; Hide works; hidden
      recording unreachable by direct URL as another agent.
- [ ] Voicemail: let a call time out → message lands → agent sees it in
      workspace → playback + delete work (delete is destructive by design).

## Gate 2 — Messaging & OTP

- [ ] OpenWA sidecar healthy; pair ONE instance end-to-end (QR or pairing
      code); status CONNECTED; survives `docker compose restart openwa`
      (persistent volume).
- [ ] **BLOCKER** OTP round trip: register a fresh agent with
      `OTP_CHANNEL=OPENWA` — code arrives, verifies, login 2FA challenges on
      new device and passes.
- [ ] Login 2FA skip works for trusted device (30-day cookie) and for
      admin-verified phones.
- [ ] Inbound WhatsApp message reaches the conversation panel;
      agent reply sends and delivers.
- [ ] Dinstar SMS: Test connection passes in `/admin/settings`; SMS poll
      cron delivers inbound SIM SMS without manual clicks
      (`SMS_POLL_SECRET` + host crontab line from `.env.example`).
- [ ] Sensitive-SMS flow: an inbound OTP-shaped SMS hides its body from
      agents; request→approve reveals it time-boxed.

## Gate 3 — Compliance sign-offs (human decisions, carried unresolved)

- [ ] **DNC fail-open**: dialplan allows calls if ODBC errors. Accepted?
      Verify ODBC actually loads first: `asterisk -rx "odbc show"`.
- [ ] **DNC normalization gap**: stored `+97150...` won't match dialed
      `050...`. Decide: dialing-convention policy vs AGI-based check.
- [ ] **Voicemail delete is destructive** (recordings are hide-only).
      Confirm this asymmetry is intended for your operators.
- [ ] Recording consent/notice for callers (UAE PDPL / Indian IT rules);
      legality of GSM termination via personal SIMs for business traffic on
      the chosen UAE carrier.
- [ ] WhatsApp unofficial-engine ban risk acknowledged; `OTP_WA_INSTANCE_ID`
      isolation decided (dedicate one SIM to OTP or not).

## Gate 4 — Operations

- [ ] Backup cron running (`scripts/backup.sh`); **one restore drill
      completed** into a scratch directory; paired WhatsApp survived.
- [ ] Monitoring story decided at minimum: external uptime probe on
      `https://domain/api/health`, log rotation (compose logging driver
      max-size), who gets paged when the health pill goes red.
- [ ] Capacity sanity noted: expected concurrent calls vs VM size; resource
      limits in compose reviewed against actual VM RAM/CPU.
- [ ] Image pinning policy executed (coturn pinned to 4.17-alpine; consider
      digest-pinning all images once verified).
- [ ] Admin runbook handed over: `/setup` locked (first admin exists),
      invite flow tested, disabled-user toggle kills sessions within one
      request, `/admin/system` understood by whoever is on call.
