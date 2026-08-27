#!/bin/sh
# Loop A5 — the `web` container runs the Next.js process as the non-root
# `nextjs` user (uid 1001), but the generated Asterisk/Caddy config files
# it must rewrite (extension provisioning, Dinstar wizard, domain apply)
# are bind-mounted from the host owned by whatever user did the deploy,
# usually at mode 644 — so every regenerate failed with EACCES, and a
# full repo re-sync silently reset any manual `chmod` workaround.
#
# This entrypoint starts as root, fixes ownership of exactly the
# RW-mounted paths the app writes, then drops to `nextjs` via su-exec for
# the actual process. Nothing else runs as root.
set -e

for p in \
  /pjsip_dynamic.conf \
  /pjsip_dinstar.conf \
  /voicemail_dynamic.conf \
  /generated \
  /recordings \
  /voicemail \
  /agent-photos
do
  if [ -e "$p" ]; then
    chown -R nextjs:nodejs "$p" 2>/dev/null || true
  fi
done

# migrate deploy, then the server — both as the unprivileged user.
su-exec nextjs:nodejs node node_modules/prisma/build/index.js migrate deploy
exec su-exec nextjs:nodejs node server.js
