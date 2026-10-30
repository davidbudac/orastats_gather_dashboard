#!/bin/sh
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
# Plain POSIX sh, so it runs on Linux (bash, dash) and AIX (ksh): no bash
# syntax, mktemp, sed -E, grep -m, du -h or fractional sleep.
#
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

case ${1:-} in
    ''|-h|--help)
        sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
        exit 1 ;;
esac
type sqlplus >/dev/null 2>&1 || { echo "sqlplus not found on PATH (set ORACLE_HOME and PATH, e.g. . oraenv)" >&2; exit 2; }

conn=$1
days=${2:-31}
max_tasks=${3:-2000}
max_backlog=${4:-5000}
quiet=${QUIET:-0}

mkdir -p "$SCRIPT_DIR/reports"
out="$SCRIPT_DIR/reports/gather_dashboard_$(date +%Y%m%d_%H%M%S).html"
# What SQL*Plus prints to the terminal (login errors), kept next to the
# report while it runs
sqllog="${out%.html}.log"
trap 'rm -f "$sqllog"' 0

# UTF-8 client character set: the page declares charset=utf-8.
NLS_LANG=${NLS_LANG:-AMERICAN_AMERICA.AL32UTF8}
export NLS_LANG

# ------------------------------------------------------------- progress
# SQL*Plus spools straight into the HTML, so it cannot print to the
# terminal meanwhile.  The first dataset (D.meta) showing up in the
# report means it has connected.
say() { [ "$quiet" = 1 ] || printf '%s\n' "$*"; }
# The D.meta line carries the database details; pull one JSON field out of it
metafield() { printf '%s\n' "$meta" | sed -n 's/.*"'"$1"'":"\{0,1\}\([^",}]*\).*/\1/p'; }
meta=''
connected() {
    [ -z "$meta" ] && [ -f "$out" ] || return 0
    meta=$(awk '/^<script>D\.meta = / { print; exit }' "$out")
    [ -n "$meta" ] || return 0
    say "Connected to $(metafield db) $(metafield version) as $(metafield user) in $(metafield con)"
    say "Running SQL script (last $days days) ..."
}

masked=$(printf '%s\n' "$conn" | sed 's#^\([^/@ ]*\)/\([^@ ][^@ ]*\)#\1/****#')
say "Connecting as $masked${PDB:+, container $PDB} ..."
start=${SECONDS:-}
cd "$SCRIPT_DIR"
sqlplus -S -L "$conn" > "$sqllog" 2>&1 <<SQL &
${PDB:+ALTER SESSION SET CONTAINER = $PDB;}
@gather_dashboard.sql $days $max_tasks $max_backlog $out
EXIT
SQL
pid=$!
while kill -0 "$pid" 2>/dev/null; do
    connected
    sleep 1
done
rc=0
wait "$pid" || rc=$?
connected

if [ ! -s "$out" ]; then
    echo "error: no report written (SQL*Plus exit code $rc):" >&2
    cat "$sqllog" >&2
    exit 3
fi
size=$(wc -c < "$out" | awk '{ s = $1; u = "bytes"
    if (s >= 1048576) { s = s / 1048576; u = "MB" } else if (s >= 1024) { s = s / 1024; u = "KB" }
    if (u == "bytes") printf "%d %s", s, u; else printf "%.1f %s", s, u }')
took=''
# ksh93 counts SECONDS with decimals; dash has no SECONDS at all
[ -z "$start" ] || took=$(awk -v a="$start" -v b="$SECONDS" 'BEGIN { printf " in %d s", b - a + 0.5 }')
say "Done$took: $out ($size)"
[ "$quiet" != 1 ] || echo "$out"

# SQL*Plus errors start a line; ORA- texts inside the data (failed
# gathers) are inside JSON strings and never do.
if grep -E '^(ORA|SP2)-[0-9]|^ERROR at line' "$out" >/dev/null; then
    echo "warning: some sections failed (they show as 'not collected' in the page):" >&2
    grep -E '^(ORA|SP2)-[0-9]' "$out" | sort | uniq -c >&2
fi
# Anything SQL*Plus printed besides the closing message (e.g. a failed
# ALTER SESSION SET CONTAINER) goes to the terminal too.
noise='^Report written to |^Session altered\.$|^$'
if grep -Ev "$noise" "$sqllog" >/dev/null; then
    echo "SQL*Plus said:" >&2
    grep -Ev "$noise" "$sqllog" >&2
fi
