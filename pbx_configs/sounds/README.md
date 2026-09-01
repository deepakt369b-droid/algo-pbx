# pbx_configs/sounds/

Custom Asterisk prompts, mounted read-only at
`/var/lib/asterisk/sounds/en/custom/` (see `docker-compose.yml`'s
`asterisk` service). Referenced from dialplan/`queues.conf` as
`custom/<name>` — no file extension, Asterisk picks the right format
itself.

Same licensing-is-an-operator-concern reasoning as `moh/default/` and
`algo-pbx-frontend/public/sounds/` — gitignored except this README.

- `please-hold.wav` — `queues.conf`'s `periodic-announce`, played every
  60s to a caller waiting in `support_queue`. 8kHz mono 16-bit PCM
  (converted from a source file the operator supplied and authorized for
  use — see `handoff.md`/`LLM.md`'s Loop D1 follow-up entry for
  provenance).

## S6 prompts — REQUIRED, must be deployed to the VPS by hand

`pbx_configs/sounds/*` is git-ignored (only this README is tracked), so
these WAVs cannot ride along in a commit or a `git pull` on the VPS. After
deploying the S6 dialplan changes you MUST copy both files into this
directory on the host and `docker compose restart asterisk` (or
`asterisk -rx "module reload"` — unreliable on this VPS, prefer restart).
Until they exist Asterisk logs a warning and plays nothing; the call still
proceeds (Playback failure is non-fatal), so recording/DNC/permission
logic is never blocked by a missing prompt.

- `this-call-may-be-recorded.wav` — the recording declaration. Played to
  the caller before `Dial()` (outbound, `[from-agent-common]`) and before
  `Queue()` (inbound, `[from-dinstar] s`), gated by
  `func_odbc.conf`'s `RECORDING_ANNOUNCE_ENABLED` — which
  `POST /api/admin/recording` forces on whenever recording is on. Suggested
  script: *"This call may be recorded for quality and training purposes."*
- `call-cannot-be-completed.wav` — replaces the old
  `sorry-cant-let-you-do-that` placeholder for BOTH `dnc-blocked` and
  `dial-permission-blocked`. Suggested script: *"This call cannot be
  completed. Please contact your administrator."*

### Generating them with Piper (MIT, offline)

```
# one-time: pip install piper-tts  (or use the release binary)
echo "This call may be recorded for quality and training purposes." \
  | piper --model en_US-lessac-medium --output_file /tmp/rec.wav
# Asterisk wants 8 kHz mono 16-bit PCM:
sox /tmp/rec.wav -r 8000 -c 1 -b 16 this-call-may-be-recorded.wav
echo "This call cannot be completed. Please contact your administrator." \
  | piper --model en_US-lessac-medium --output_file /tmp/blk.wav
sox /tmp/blk.wav -r 8000 -c 1 -b 16 call-cannot-be-completed.wav
```

`asterisk-extra-sounds` was checked first: it ships `conf-now-recorded`
("this conference is now being recorded") but nothing that fits a 1:1 call
declaration, so a generated prompt is used.
