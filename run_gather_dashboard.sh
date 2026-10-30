#!/usr/bin/env bash
#
# Run gather_dashboard.sql and write the HTML into reports/.
#
# Usage:
#   ./run_gather_dashboard.sh <connect_string> [days] [max_tasks_per_run] [max_backlog]
#
# Examples:
#   ./run_gather_dashboard.sh user/pw@svc
#   ./run_gather_dashboard.sh '/ as sysdba' 7          # OS auth, last 7 days (quote it)
#   PDB=PDB1 ./run_gather_dashboard.sh '/ as sysdba'   # one PDB from a root connection
#
# PDB=<name> switches container before the run (needs SET CONTAINER).
# QUIET=1 prints only warnings and the report path (for cron).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 || $1 == -h || $1 == --help ]]; then
    sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
fi
command -v sqlplus >/dev/null || { echo "sqlplus not found on PATH (source oraenv first)" >&2; exit 2; }

conn=$1
days=${2:-31}
max_tasks=${3:-2000}
max_backlog=${4:-5000}
quiet=${QUIET:-0}

mkdir -p "$SCRIPT_DIR/reports"
out="$SCRIPT_DIR/reports/gather_dashboard_$(date +%Y%m%d_%H%M%S).html"
sqllog=$(mktemp "${TMPDIR:-/tmp}/gather_dashboard.XXXXXX")
trap 'rm -f "$sqllog"' EXIT

# UTF-8 client character set: the page declares charset=utf-8.
export NLS_LANG=${NLS_LANG:-AMERICAN_AMERICA.AL32UTF8}

# ------------------------------------------------------------- progress
# SQL*Plus spools straight into the HTML, so it cannot print to the
# terminal meanwhile.  The first dataset (D.meta) showing up in the
# report means it has connected.
say() { [[ $quiet == 1 ]] || printf '%s\n' "$*"; }
# The D.meta line carries the database details; pull one JSON field out of it
metafield() { sed -n 's/.*"'"$1"'":"\{0,1\}\([^",}]*\).*/\1/p' <<<"$2"; }
meta=''
connected() {
    [[ -z $meta && -f $out ]] || return 0
    meta=$(grep -m1 '^<script>D\.meta = ' "$out" || true)
    [[ -n $meta ]] || return 0
    say "Connected to $(metafield db "$meta") $(metafield version "$meta") as $(metafield user "$meta") in $(metafield con "$meta")"
    say "Running SQL script (last $days days) ..."
}

say "Connecting as $(sed -E 's#^([^/@ ]*)/([^@ ]+)#\1/****#' <<<"$conn")${PDB:+, container $PDB} ..."
start=$SECONDS
cd "$SCRIPT_DIR"
sqlplus -S -L "$conn" > "$sqllog" 2>&1 <<SQL &
${PDB:+ALTER SESSION SET CONTAINER = $PDB;}
@gather_dashboard.sql $days $max_tasks $max_backlog $out
EXIT
SQL
pid=$!
while kill -0 "$pid" 2>/dev/null; do
    connected
    sleep 0.2
done
rc=0
wait "$pid" || rc=$?
connected

if [[ ! -s $out ]]; then
    echo "error: no report written (SQL*Plus exit code $rc):" >&2
    cat "$sqllog" >&2
    exit 3
fi
say "Done in $((SECONDS - start)) s: $out ($(du -h "$out" | cut -f1))"
[[ $quiet == 1 ]] && echo "$out"

# SQL*Plus errors start a line; ORA- texts inside the data (failed
# gathers) are inside JSON strings and never do.
if grep -q '^ORA-[0-9]\|^SP2-[0-9]\|^ERROR at line' "$out"; then
    echo "warning: some sections failed (they show as 'not collected' in the page):" >&2
    grep '^ORA-[0-9]\|^SP2-[0-9]' "$out" | sort | uniq -c >&2
fi
# Anything SQL*Plus printed besides the closing message (e.g. a failed
# ALTER SESSION SET CONTAINER) goes to the terminal too.
noise='^Report written to \|^Session altered\.$\|^$'
if grep -v "$noise" "$sqllog" | grep -q .; then
    echo "SQL*Plus said:" >&2
    grep -v "$noise" "$sqllog" >&2
fi
