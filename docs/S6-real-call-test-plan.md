# S6 — real-call test plan

Nothing in S6 is trusted on a green build. Each of the three features below
must be proved against a live call on the production VPS (Asterisk 20,
Dinstar UC2000 GSM trunk over Tailscale, an agent softphone in India).

## Pre-req: deploy

1. Deploy the web image (new routes only, no new deps).
2. `docker exec algo-web node node_modules/prisma/build/index.js migrate deploy`
   — must name `20260901120000_add_pbx_runtime_flags`.
   Verify: `SELECT * FROM "PbxRuntimeFlag";` → two rows, both `enabled = t`.
3. Copy `pbx_configs/{extensions.conf,func_odbc.conf,queues.conf}` to the
   host and `docker compose restart asterisk`.
4. Copy `this-call-may-be-recorded.wav` and `call-cannot-be-completed.wav`
   into `pbx_configs/sounds/` on the host (see that README), restart asterisk.
5. `docker exec algo-asterisk asterisk -rx "odbc show"` → `algopbx-dnc`
   connected. `... "dialplan show RECORDING_ENABLED"` is N/A (it's a
   function) — instead `asterisk -rx "core show function RECORDING_ENABLED"`.

## 1. Global recording toggle

### 1a. Default (recording ON) — outbound
- Agent dials a UAE mobile, talks 10s, hangs up.
- Expect: `/var/spool/asterisk/monitor/<uniqueid>.wav` exists and has audio;
  the recording appears under Admin → Telephony → Recordings.

### 1b. Default (recording ON) — inbound
- Call the SIM from an outside phone, an agent answers, talk 10s.
- Expect: one `<uniqueid>.wav` with the full call (not two files — the
  `queues.conf` `monitor-type` removal means no duplicate queue recording).

### 1c. Turn recording OFF
- Admin → Configuration → Call recording → toggle "Record all calls" off.
  Confirm `SELECT enabled FROM "PbxRuntimeFlag" WHERE key='recording_enabled'`
  → `f`, and an `AuditLog` row `action='recording.toggle'`.
- Place a new outbound call and a new inbound call.
- Expect: NO new `.wav` files created. Existing recordings untouched.
- `asterisk -rx "core show channels verbose"` during the call → no
  `MixMonitor` on the channel.

### 1d. Fail-open proof
- With recording OFF, stop Postgres: `docker compose stop postgres`.
- Place an outbound call (internal-to-internal is fine so the trunk isn't needed).
- Expect: the call still connects AND a `.wav` is written — a broken lookup
  records. Restart postgres, re-confirm 1c behaviour returns.

### 1e. Toggle back ON
- Toggle recording on; confirm the announcement toggle flips on with it and
  is disabled in the UI; confirm recording resumes on the next call.

## 2. Recording declaration

### 2a. Plays before the call connects
- Recording ON. Outbound call: the agent should hear
  "this call may be recorded…" before ringback / answer.
- Inbound call: the caller hears it before entering the queue / MOH.

### 2b. Locked on with recording
- With recording ON, `POST /api/admin/recording {"announcementEnabled":false}`
  directly (curl, admin cookie) → 409, DB unchanged.

### 2c. Independent when recording is OFF
- Recording OFF, announcement OFF (both rows `f`): place a call → no prompt.
- Recording OFF, announcement ON: place a call → prompt still plays.

### 2d. Blocked-call prompt
- Add the dialled number to the DNC list, dial it.
- Expect: `call-cannot-be-completed.wav` plays, then hangup (not silence,
  not the old missing-file warning). Repeat for a satellite prefix
  (`+8701...`) to hit `dial-permission-blocked`.

## 3. Live monitoring

### 3a. Listen-only
- Agent A on a live call. Admin opens Admin → Telephony → Live monitor,
  sees the channel, clicks Listen.
- Expect: the admin's extension rings; on answer the admin hears both
  parties; neither party hears the admin or a beep (`,q`).
- Confirm an `AuditLog` row `action='monitor.listen'`, `targetId` = the
  channel, `metadata.monitorExtension` = the admin's extension — written
  even if the Originate then fails.

### 3b. Guards
- A plain AGENT session `GET /api/admin/monitor` → 403.
- `POST /api/admin/monitor {"targetChannel":"PJSIP/evil-00000001"}` (well-formed
  but not live) → 404, and no Originate attempted.
- CR/LF injection: `{"targetChannel":"PJSIP/1001-1\r\nAction: Command"}` →
  400 (shape regex) — and ami-client's frameAction rejects it as backstop.
- An admin with no linked extension → 409 with a clear message.

### 3c. No whisper/barge
- Confirm the monitor route has no mode parameter and cannot send `w`/`B`
  ChanSpy flags — those remain only on `/api/intervention`.
