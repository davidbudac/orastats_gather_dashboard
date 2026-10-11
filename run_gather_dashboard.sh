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
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 || $1 == -h || $1 == --help ]]; then
    sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
fi
command -v sqlplus >/dev/null || { echo "sqlplus not found on PATH" >&2; exit 2; }

conn=$1
days=${2:-31}
max_tasks=${3:-2000}
max_backlog=${4:-5000}

mkdir -p "$SCRIPT_DIR/reports"
out="$SCRIPT_DIR/reports/gather_dashboard_$(date +%Y%m%d_%H%M%S).html"

# UTF-8 client character set: the page declares charset=utf-8.
export NLS_LANG=${NLS_LANG:-AMERICAN_AMERICA.AL32UTF8}

cd "$SCRIPT_DIR"
sqlplus -S -L "$conn" <<SQL
${PDB:+ALTER SESSION SET CONTAINER = $PDB;}
@gather_dashboard.sql $days $max_tasks $max_backlog $out
EXIT
SQL

# SQL*Plus errors start a line; ORA- texts inside the data (failed
# gathers) are inside JSON strings and never do.
if grep -q '^ORA-[0-9]\|^SP2-[0-9]\|^ERROR at line' "$out"; then
    echo "warning: some sections failed (they show as 'not collected' in the page):" >&2
    grep '^ORA-[0-9]\|^SP2-[0-9]' "$out" | sort | uniq -c >&2
fi
