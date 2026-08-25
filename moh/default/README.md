# Music on Hold — `default` class

Drop royalty-free/licensed audio files here (`.wav` recommended — 8kHz/16-bit
mono for widest Asterisk codec-transcoding compatibility, though Asterisk
can also read `.mp3`/`.ogg` with the right codec modules installed).

This repo intentionally ships **no audio files** — sourcing/licensing music
is an operator decision, not something to bundle into source control. With
this directory empty, `[default]`'s MOH class (`pbx_configs/musiconhold.conf`)
will have nothing to play; Asterisk logs a warning and callers get silence
instead of hold music, not an error. Add at least one file before relying
on this in anything beyond a bring-up/smoke test.

Referenced by:
- `pbx_configs/musiconhold.conf`'s `[default]` class (`directory=default`)
- `pbx_configs/queues.conf`'s `musicclass=default` on `support_queue`
