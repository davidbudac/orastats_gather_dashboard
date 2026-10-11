#!/bin/sh
#
# tools/run_on_dbmint.sh -- dev helper: sync the project to the dbmint lab
# VM, run the dashboard there and copy the report back into reports/.
#
# Usage: tools/run_on_dbmint.sh [days] [PDB]
#
set -eu
cd "$(dirname "$0")/.."
port=${DBMINT_PORT:-2200}
days=${1:-31}
pdb=${2:-}
rsync -az --delete --exclude='.git/' --exclude='reports/' --exclude='web/dev-data.js' \
    ./ "oracle@dbmint:~/orastats_gather_dashboard/" -e "ssh -p $port"
ssh -p "$port" oracle@dbmint "export ORACLE_SID=cdb1 ORAENV_ASK=NO; . oraenv >/dev/null 2>&1;
    cd ~/orastats_gather_dashboard && rm -f reports/*.html && PDB='$pdb' ./run_gather_dashboard.sh '/ as sysdba' $days"
rsync -az -e "ssh -p $port" "oracle@dbmint:~/orastats_gather_dashboard/reports/" ./reports/
ls -t reports/*.html | head -1
