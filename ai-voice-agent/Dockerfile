# ai-voice-agent — Hybrid AI + Human plan (LLM.md decision, 2026-09-14)
#
# Sidecar Python service that speaks Asterisk's AudioSocket protocol
# (extensions.conf's [from-dinstar-ai]/[ai-agent-internal] contexts,
# AudioSocket(${UNIQUEID},127.0.0.1:9092)) and a small HTTP pre-registration
# API (127.0.0.1:9091) — ports fixed by .agents/hybrid-ai/contracts.md, do
# not renumber. Runs with network_mode: host (see this repo's docker-compose.yml)
# specifically so 127.0.0.1:9092/9091 resolve to the SAME host Asterisk's
# own network_mode: host binds them on (CLAUDE.md/LLM.md §2 hard constraint
# — Asterisk's networking is never containerized, and this sidecar has to
# meet it on that same host network to use loopback at all).
#
# OWNERSHIP: this Dockerfile is W5's (dialplan/compose node) — it is only a
# build skeleton, wired into docker-compose.yml so the stack builds and
# starts. The actual Python application under this directory
# (audiosocket/, pipeline/, config_client.py, session_reporter.py, and the
# eventual main.py entrypoint referenced below) is W4's, landing in
# parallel and NOT written by this Dockerfile. requirements.txt does not
# exist yet either as of this commit — both are expected to appear from
# W4's work; this file just needs to keep building once they do. If W4
# lands a different entrypoint name/module path than `main.py`, update the
# CMD below to match rather than renaming their file.
FROM python:3.11-slim

WORKDIR /app

# System deps for common realtime-audio/codec Python packages (audioop
# replacements, numpy/scipy wheels, etc.) some STT/TTS/realtime provider
# SDKs pull in transitively. Kept minimal; extend here only if a real build
# failure demands it once requirements.txt exists.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Copied and installed as its own layer, before the rest of the source, so
# an unchanged requirements.txt keeps Docker's build-cache hit on
# `pip install` even when application code changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# W4's actual Python source (audiosocket/, pipeline/, config_client.py,
# session_reporter.py, main.py, tests/, etc.) lands here.
COPY . .

# AudioSocket (audio, TCP) and HTTP pre-registration ports — see
# .agents/hybrid-ai/contracts.md. Documentation only: network_mode: host
# (docker-compose.yml) means these EXPOSE lines don't publish anything by
# themselves, they're just a record of the fixed contract.
EXPOSE 9092 9091

# Plausible entrypoint name — W4 has not landed main.py as of this
# Dockerfile; update this CMD if the sidecar's real entrypoint module/path
# differs once it lands.
CMD ["python", "main.py"]
