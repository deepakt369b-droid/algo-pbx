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

Still needed, not yet recorded (`extensions.conf`'s placeholders):
- The Do Not Call block announcement (`dnc-blocked`).
- The dial-permission-blocked announcement (toll-fraud/premium-rate
  guard, Loop C2).

Both currently reference `Playback(sorry-cant-let-you-do-that)`, a
placeholder name with no corresponding file anywhere — Asterisk will log
a warning and play nothing until real prompts are recorded/supplied and
added here.
