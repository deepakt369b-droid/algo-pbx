# ai-voice-agent

Python 3.10+ AudioSocket-based AI voice agent sidecar for Algo PBX.

This is a fork/rewrite derived architecturally from the public MIT-licensed
[ictinnovations/asterisk-ai-voice-agent](https://github.com/ictinnovations/asterisk-ai-voice-agent)
(AudioSocket TCP server on port 9092, HTTP pre-registration on port 9091,
20ms audio-frame pacing, barge-in support), reimplemented here with:

- expanded provider support: OpenAI-compatible LLMs (OpenAI, Groq,
  OpenRouter, Together, Sarvam-M, Azure OpenAI), Deepgram STT, Sarvam
  (saaras/bulbul) STT+TTS for Hindi/Hinglish, ElevenLabs and Cartesia TTS,
  Gemini (`generateContent` + Live speech-to-speech), and OpenAI Realtime
  speech-to-speech;
- integration with Algo PBX's internal `agent-config`/`sessions` APIs (see
  `.agents/hybrid-ai/contracts.md` in the repo root);
- AMI-based human handoff (`Redirect` action), mirroring the shape of
  `algo-pbx-frontend/src/lib/ami-client.ts`.

See `LICENSE` for the MIT license text and attribution.

## Layout

- `main.py` - entrypoint; starts the 9091 HTTP pre-registration server and
  the 9092 AudioSocket TCP server.
- `config_client.py` - `GET /api/internal/ai/agent-config`.
- `session_reporter.py` - `POST /api/internal/ai/sessions`.
- `audiosocket/protocol.py` - AudioSocket binary frame codec, 20ms pacing,
  barge-in energy detection.
- `pipeline/` - STT -> LLM -> TTS cascade and realtime speech-to-speech,
  provider-pluggable (`pipeline/providers/`, selected via `pipeline/registry.py`).
- `handoff.py` - AMI client + `Redirect` action for transferring to a human.
- `tests/` - pytest unit tests.

## Running

```
pip install -r requirements.txt
python main.py
```

Environment variables: `NEXTJS_BASE_URL`, `AI_SIDECAR_SHARED_SECRET`,
`AMI_HOST`/`AMI_PORT`/`AMI_USERNAME`/`AMI_SECRET`, `AUDIOSOCKET_PORT` (default
9092), `PREREG_PORT` (default 9091).

Note: this directory intentionally has no Dockerfile - that is owned by a
separate node wiring `ai-voice-agent/Dockerfile` and the docker-compose
service in parallel.

## Testing

```
python -m pytest ai-voice-agent/tests -v
```

## Assumptions made without internet access

See the module docstrings in `audiosocket/protocol.py`,
`pipeline/providers/deepgram.py`, `pipeline/providers/sarvam.py`,
`pipeline/providers/elevenlabs.py`, `pipeline/providers/cartesia.py`,
`pipeline/providers/gemini.py`, `pipeline/providers/openai_realtime.py`, and
`main.py` for each provider/protocol detail reconstructed from spec
description and general knowledge rather than verified against a live
endpoint or the original reference project's source.
