# Music on Hold — `default` class

Drop royalty-free/licensed audio files here (`.wav` recommended — 8kHz/16-bit
mono for widest Asterisk codec-transcoding compatibility, though Asterisk
can also read `.mp3`/`.ogg` with the right codec modules installed).

**`music-box.wav` is now here** — supplied and authorized for use by the
operator (2026-08-27), converted from the original 44.1kHz stereo source
to 8kHz mono 16-bit PCM (matching the alaw/ulaw codec path toward the
Dinstar trunk, no transcoding needed). Gitignored per this file's own
policy below — it exists on whichever machine converted it and must be
copied to any other deploy target (VM, etc.) separately; it is NOT in git
history.

This repo intentionally ships no audio files IN GIT — sourcing/licensing
music is an operator decision, not something to bundle into source
control, even once a real file exists locally (see `.gitignore`). With
this directory empty, `[default]`'s MOH class (`pbx_configs/musiconhold.conf`)
has nothing to play; Asterisk logs a warning and callers get silence
instead of hold music, not an error — that was the state before
`music-box.wav` was added.

Referenced by:
- `pbx_configs/musiconhold.conf`'s `[default]` class (`directory=default`)
- `pbx_configs/queues.conf`'s `musicclass=default` on `support_queue`
