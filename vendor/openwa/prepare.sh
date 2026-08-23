#!/usr/bin/env bash
# Fetches the pinned OpenWA commit into vendor/openwa/upstream/ so
# docker-compose.yml can build straight from upstream's own Dockerfile
# instead of us re-deriving it (upstream's build is a two-stage,
# multi-arch, Chromium/ffmpeg/postgres-client image with several
# backport patches applied at image-build time — reimplementing it by
# hand goes stale the moment any of that changes upstream).
#
# Run this before `docker compose build openwa` (and again whenever
# OPENWA_COMMIT below is bumped). Re-review and re-pin deliberately —
# this is NOT wired to auto-update.
set -euo pipefail

# Verify against a live tip with:
#   git ls-remote https://github.com/rmyndharis/OpenWA main
OPENWA_COMMIT="99874630c9d386340d71f191b310c8bd8aa52ee3"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$DIR/upstream"

if [ -d "$TARGET/.git" ]; then
  CURRENT="$(git -C "$TARGET" rev-parse HEAD)"
  if [ "$CURRENT" = "$OPENWA_COMMIT" ]; then
    echo "vendor/openwa/upstream already at pinned commit $OPENWA_COMMIT"
    exit 0
  fi
  echo "vendor/openwa/upstream is at $CURRENT, re-pinning to $OPENWA_COMMIT"
  rm -rf "$TARGET"
fi

git clone https://github.com/rmyndharis/OpenWA.git "$TARGET"
git -C "$TARGET" checkout --detach "$OPENWA_COMMIT"
RESOLVED="$(git -C "$TARGET" rev-parse HEAD)"
if [ "$RESOLVED" != "$OPENWA_COMMIT" ]; then
  echo "FATAL: checked out $RESOLVED, expected $OPENWA_COMMIT" >&2
  exit 1
fi
echo "vendor/openwa/upstream pinned at $RESOLVED"
