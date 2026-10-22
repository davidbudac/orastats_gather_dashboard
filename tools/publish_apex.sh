#!/bin/sh
# Install/update the APEX app, or publish only a newer collector snapshot.
# This writes only to the local APEX database, never to the monitored database.
set -eu
cd "$(dirname "$0")/.."
report=${1:?Usage: tools/publish_apex.sh report.html [--snapshot-only]}
mode=${2:-}
case "$mode" in ''|--snapshot-only) ;; *) echo 'Unknown option' >&2; exit 2 ;; esac
container=${APEX_CONTAINER:-23cfree}
pdb=${APEX_PDB:-FREEPDB1}
python3 apex/build.py "$report" --workspace "${APEX_WORKSPACE:-MONITORING}" \
  --schema "${APEX_SCHEMA:-MONITORING}" --app-id "${APEX_APP_ID:-101}"
docker exec "$container" mkdir -p /tmp/orastats-apex
docker cp apex/build/. "$container:/tmp/orastats-apex/"
script=install.sql
if [ "$mode" = --snapshot-only ]; then script=snapshot.sql; fi
# The existing container supplies ORACLE_PWD. Never print it or store it in source.
docker exec -i -u oracle "$container" bash -lc '
  set -eu
  cd /tmp/orastats-apex
  sqlplus -s "system/${ORACLE_PWD}@localhost:1521/$1" "@$2"
' sh "$pdb" "$script" <<'SQL'
exit
SQL
echo 'Published. Reload the APEX page to view the snapshot.'
