#!/bin/sh
# Loop B3b — render the two config files that must carry a real secret
# from .env at container start, instead of shipping them hand-templated
# in the repo (where a full `git ls-files` re-sync silently reverts them
# to their committed REPLACE_ME_* placeholders — a recurring live-deploy
# failure recorded in LLM.md §15/§16).
#
# The repo files are bind-mounted READ-ONLY at *.tmpl paths (see
# docker-compose.yml); this writes the real, container-local files
# Asterisk/unixODBC actually read. Nothing sensitive is ever committed.
set -e

render() {
  src="$1"; dst="$2"
  [ -f "$src" ] || return 0
  sed \
    -e "s|REPLACE_ME_AMI_SECRET|${AMI_SECRET:-REPLACE_ME_AMI_SECRET}|g" \
    -e "s|REPLACE_ME_CDR_LISTENER_AMI_SECRET|${CDR_AMI_SECRET:-REPLACE_ME_CDR_LISTENER_AMI_SECRET}|g" \
    -e "s|REPLACE_ME_POSTGRES_PASSWORD|${POSTGRES_PASSWORD:-REPLACE_ME_POSTGRES_PASSWORD}|g" \
    "$src" > "$dst"
}

render /etc/asterisk/manager.conf.tmpl /etc/asterisk/manager.conf
render /etc/odbc.ini.tmpl /etc/odbc.ini

# Fail loudly if a placeholder survived (a missing env var) rather than
# letting Asterisk boot with a literal REPLACE_ME_ secret.
if grep -q "REPLACE_ME_" /etc/asterisk/manager.conf 2>/dev/null; then
  echo "FATAL: manager.conf still contains REPLACE_ME_ after templating — check AMI_SECRET / CDR_AMI_SECRET in the environment." >&2
  exit 1
fi

exec /usr/sbin/asterisk -f -vvv
