#!/usr/bin/env bash
# Algo PBX — backup everything that is not reproducible from git.
#
#   sudo bash scripts/backup.sh [output-dir]
#
# Default output: /var/backups/algo-pbx/<timestamp>/
#
# What gets captured:
#   - algopbx_db        (Postgres dump: users, extensions, CDRs, settings...)
#   - openwa            (Postgres dump: WhatsApp session metadata)
#   - recordings/       (call audio)
#   - voicemail/        (voicemail spool)
#   - agent-photos/     (profile photos)
#   - openwa volume     (WhatsApp session credentials + media — without this
#                        every paired SIM must re-scan a QR after a restore)
#   - .env              (bootstrap secrets — the encrypted AppSetting values
#                        in the DB dump are useless without SETTINGS_ENCRYPTION_KEY)
#
# RESTORE (fresh VM):
#   1. git clone, cp .env from backup, docker compose build, start postgres only:
#         docker compose up -d postgres
#   2. Databases:
#         cat algopbx_db.sql.gz    | docker compose exec -T postgres psql -U $POSTGRES_USER -d $POSTGRES_DB
#         cat openwa.sql.gz        | docker compose exec -T postgres psql -U $POSTGRES_USER -d openwa
#   3. Files: rsync recordings/ voicemail/ agent-photos/ back into the repo dir.
#   4. OpenWA volume:
#         docker run --rm -i -v algo-pbx_openwa_data:/restore -v "$PWD":/backup alpine \
#           sh -c 'cd /restore && tar xzf /backup/openwa_data.tgz'
#      (volume name prefix = compose project dir name; check with `docker volume ls`)
#   5. docker compose up -d ; verify /admin/system is green and a paired
#      WhatsApp instance still shows CONNECTED.
#
# Cron suggestion (2am daily, keep 14 days):
#   0 2 * * * root /opt/algo-pbx/scripts/backup.sh >> /var/log/algo-pbx-backup.log 2>&1
#   0 3 * * * root find /var/backups/algo-pbx -maxdepth 1 -mtime +14 -exec rm -rf {} \;
#
# An untested backup is a hope, not a backup: run one restore drill before go-live.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_BASE="${1:-/var/backups/algo-pbx}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$OUT_BASE/$STAMP"

if [[ $EUID -ne 0 ]]; then echo "run as root (sudo)"; exit 1; fi
cd "$REPO_DIR"

# Pull env vars out of .env without sourcing arbitrary code.
PG_USER="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)"
PG_DB="$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)"

mkdir -p "$OUT"
echo "==> backing up into $OUT"

echo "-- database: ${PG_DB}"
docker compose exec -T postgres pg_dump -U "$PG_USER" "$PG_DB" | gzip > "$OUT/${PG_DB}.sql.gz"

echo "-- database: openwa"
# May not exist on brand-new deployments; tolerate and continue.
docker compose exec -T postgres pg_dump -U "$PG_USER" openwa | gzip > "$OUT/openwa.sql.gz" \
  || echo "   (openwa db missing — skipping; expected only before first pairing)"

for d in recordings voicemail agent-photos; do
  if [[ -d "$REPO_DIR/$d" ]]; then
    echo "-- files: $d/"
    tar czf "$OUT/$d.tgz" -C "$REPO_DIR" "$d"
  fi
done

echo "-- volume: openwa_data"
docker run --rm -v algo-pbx_openwa_data:/src:ro -v "$OUT":/backup alpine \
  sh -c 'tar czf /backup/openwa_data.tgz -C /src .' \
  || echo "   (openwa_data volume missing — skipping; expected only before first build)"

echo "-- secrets: .env (keep the backup location access-controlled)"
cp .env "$OUT/env.backup" && chmod 600 "$OUT/env.backup"

echo "==> done:"
du -sh "$OUT"/*
