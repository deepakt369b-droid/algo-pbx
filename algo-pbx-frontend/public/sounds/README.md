# Sounds

`ringtone.wav` (referenced by `src/contexts/sip-context.tsx` as
`/sounds/ringtone.wav`, played on every inbound call) is **now here** —
supplied and authorized for use by the operator (2026-08-27), converted
from "On Hold Ringtone.wav" (part of the same pack `moh/default/music-box.wav`
came from) to 8kHz mono 16-bit PCM. `.wav`, not `.mp3` as originally
planned — nothing here can encode MP3, and WAV needs no codec support
browsers don't already have.

Gitignored, same reasoning as `moh/README.md`: this file exists on
whichever machine converted it and must be copied to any other deploy
target separately; it is NOT in git history.

Until a file exists at this path, inbound calls fall back to the browser
Notification (`Notification.permission === "granted"`) as the only alert
— which itself needs the agent to have granted notification permission
once (prompted from the agent shell). Both together are the intended
belt-and-suspenders alert; neither alone is sufficient for a backgrounded
tab in every browser.
