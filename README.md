# Statistics gathering dashboard (Oracle 19c)

One SQL*Plus script that writes one self-contained HTML page about the optimizer
statistics gathering on a database: every automatic-job run and every manual or
custom `DBMS_STATS` gather in the last N days, what each run did object by object,
how long it took, what failed, and what still needs statistics now.

Read-only (SELECT only, nothing installed), no Python, no network: the page works
from `file://` offline.

## Run it

```bash
./run_gather_dashboard.sh user/pw@svc                # last 31 days -> reports/
./run_gather_dashboard.sh '/ as sysdba' 7            # OS auth, last 7 days (quote it)
PDB=PDB1 ./run_gather_dashboard.sh '/ as sysdba'     # one PDB from a root connection
QUIET=1 ./run_gather_dashboard.sh '/ as sysdba'      # cron: only warnings and the report path
```

The wrapper says when it has connected (database, user, container), when the SQL
script is running, and when it is done (time, report path and size). A failed login
or a section that failed shows with its ORA- error. The password in a connect string
is masked.

Or from SQL*Plus / SQLcl directly (all arguments optional):

```
SQL> @gather_dashboard.sql [days] [max_tasks_per_run] [max_backlog] [output_file]
```

| Argument | Default | Meaning |
|---|---|---|
| days | 31 | History shown. Stats history retention is 31 days by default; older runs are already purged. |
| max_tasks_per_run | 2000 | Per-object rows embedded per run (failed first, then slowest). Run totals are always exact. |
| max_backlog | 5000 | Objects still needing statistics, columns with doubtful statistics, and tables for the Table view embedded (application schemas first). |
| output_file | `gather_dashboard_<db>_<con>_<time>.html` | |

Scope follows the connection: in `CDB$ROOT` as a common user it covers every open
container; inside a PDB, that PDB; on a non-CDB, the database. It reads the `CDB_*`
views, so `SELECT_CATALOG_ROLE` (plus `CONTAINER_DATA` for other PDBs from root) is
enough. A section that fails (missing grant) shows as "not collected"; the rest works.

Set `NLS_LANG=.AL32UTF8` when calling `gather_dashboard.sql` yourself (the wrapper does).

## What the page shows

- **Overview** - findings ranked by severity, totals, a timeline of every run against
  the maintenance windows (per container), run time and objects per automatic run,
  recurring failures, the most expensive objects.
- **Runs** - every operation, filterable by kind (automatic / manual / all DBMS_STATS
  calls), container, outcome, text. The text also matches the objects a run gathered,
  so a table name lists the runs that took it.
- **Run detail** - start/end, scheduler job status and CPU, the window it ran in and how
  much of it was used, the resolved parameters, objects by type (gathered / failed / not
  processed / with histograms / time), objects over time (concurrent ones stack), and
  every object with duration, histograms created, extended stats and error.
- **Still needs stats** - stale or missing statistics now, each classified:
  last gather failed; missed by the last automatic run (its DML was recorded before the
  run started); locked; never gathered; stale since the last run (expected);
  subpartitions without statistics; fixed objects. Below it, what is close to stale:
  at least half of `STALE_PERCENT` changed by the flushed DML counters alone.
- **Columns** - column statistics of analyzed tables that lag behind or cannot describe
  the column: a column without statistics (added after the last gather), statistics over
  an hour older than the table's (the last gather left the column out), height-balanced
  histograms (a fixed `ESTIMATE_PERCENT`), hybrid or top-frequency histograms with under
  half the buckets they could have, and frequency histograms missing values.
- **Table** - one table at a time (every object name in the page links here): its
  statistics now, the preferences in force (table over global), an incremental-statistics
  check (partitioned, `INCREMENTAL`, `PUBLISH`, `ESTIMATE_PERCENT`, `GRANULARITY`,
  synopses present, and what the gathers actually did), every gather that touched it on a
  timeline, and a partitions-per-gather matrix that shows whether only changed partitions
  are regathered.
- **Setup** - automatic task status per container, scheduler windows, global and table
  preferences, history retention, and per container how fresh the DML-monitoring
  counters are and `STATISTICS_LEVEL`.

A run's outcome: **complete** (every object it picked was gathered), **some objects
failed**, or **failed / timed out / never finished / objects not processed**. Known
harmless failures (`X$LOGMNR_CONTENTS`) are reported but do not mark runs as failed.

## Data sources

`DBA_OPTSTAT_OPERATIONS`, `DBA_OPTSTAT_OPERATION_TASKS`, `DBA_AUTOTASK_JOB_HISTORY`,
`DBA_AUTOTASK_CLIENT`, `DBA_SCHEDULER_JOB_RUN_DETAILS`, `DBA_SCHEDULER_WINDOWS`,
`DBA_SCHEDULER_WINDOW_DETAILS`, `DBA_TAB_STATISTICS`, `DBA_TAB_MODIFICATIONS`,
`DBA_TAB_STAT_PREFS`, `DBA_TABLES`, `DBA_TAB_COLS`, `DBA_PART_TABLES`, `DBA_INDEXES`,
`DBMS_STATS.GET_PREFS` (all through their `CDB_*` versions), `V$PARAMETER`, and
`SYS.WRI$_OPTSTAT_SYNOPSIS_HEAD$` for the incremental-statistics synopses (needs SYSDBA
or `SELECT ANY DICTIONARY`; without it the Table view says synopses were not checked).

Staleness is as of the last DML-monitoring flush; the script does not flush (it stays
read-only). The page shows when the newest counters were written, and lists what is
close to stale so that changes still in memory are less of a blind spot. Column checks
cover table-level column statistics only, not partition-level ones.

## Development

See [CLAUDE.md](CLAUDE.md).

## Oracle APEX application

[Statistics Observatory](apex/README.md) presents a published dashboard snapshot
inside Oracle APEX 26.2, with sign-in, interactive charts, and run drilldowns.
Its installer and snapshot publisher are separate from the read-only collector.

## Elastic Stack integration

[`elastic/`](elastic/README.md) ships the same history to Elasticsearch: a
read-only exporter writes NDJSON on the DB host, Filebeat and Logstash carry it
into the `orastats-gather-*` indices, and three Kibana dashboards (overview,
run detail, needs statistics) sit on top. The step-by-step deployment is in
[elastic/README.md](elastic/README.md#deploy).
