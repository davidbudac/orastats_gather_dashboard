# CLAUDE.md

Guidance for agent sessions. `AGENTS.md` is a symlink to this file.

## What this is

`gather_dashboard.sql` (SQL*Plus) spools one self-contained HTML report about
DBMS_STATS gathering on Oracle 19c. Read-only invariant: SELECTs and print-only
PL/SQL; no DDL/DML, no flush of monitoring info. Keep it that way.

## Layout

```
gather_dashboard.sql    driver: settings, positional args, SPOOL, sections
run_gather_dashboard.sh wrapper: args, NLS_LANG, reports/, error check
sql/00_head.sql         <head>, @@_css.sql, `var D = {}`
sql/10_meta.sql         D.meta, D.cons, D.omu, D.prefs, D.atc, D.wcfg
sql/20_operations.sql   D.ops   (CDB_OPTSTAT_OPERATIONS)
sql/30_tasks.sql        D.tagg (exact totals), D.tasks (capped per run)
sql/40_jobs_windows.sql D.ajh, D.sjr, D.win
sql/50_backlog.sql      D.blagg (exact counts), D.bl (capped), D.tprefs
sql/60_columns.sql      D.colagg (exact), D.cols (capped), D.mon, D.near (capped)
sql/70_tables.sql       D.tabs (capped), D.idx (index -> table), D.syn (synopses)
sql/90_app.sql          @@_app.sql, </body>
sql/_css.sql, _app.sql  GENERATED from web/style.css, web/app.js
web/app.js, style.css   page source (no libraries)
web/dev.html            dev harness: loads dev-data.js + source files
tools/build_assets.sh   web/* -> sql/_*.sql  (--check for staleness)
tools/extract_data.sh   report -> web/dev-data.js
tools/run_on_dbmint.sh  sync to the dbmint lab VM, run, copy report back
elastic/                Elastic Stack export: export.sh + export_gather.sql (NDJSON),
                        Filebeat input, Logstash conf, index template, Kibana builder;
                        see elastic/README.md
```

## Rules that break a run if ignored

- Joins between big `CDB_` views run per row across containers (minutes, TEMP).
  Read each view once in a `/*+ MATERIALIZE */` WITH clause, then join those.

- Each dataset is printed as `<script>D.x = [` rows `];</script>`, one JSON_ARRAY
  per row with a trailing comma. Always `NULL ON NULL` (the default ABSENT ON NULL
  shifts positions) and `REPLACE(..., '</', '<\/')` on rows carrying free text.
  Row arrays are positional: change SQL and the matching parser in app.js together.
- A failed section spools `ORA-` lines into its own script tag; the page reports
  the dataset as not collected. The wrapper greps `^ORA-|^SP2-` to warn.
- web/*.js and *.css must be ASCII (SQL*Plus re-encodes; write `→`), no `~'`,
  no line >= 2400 chars. `tools/build_assets.sh` enforces all three.
- Run `tools/build_assets.sh` after editing web/*, and commit the generated files.
- No `&` in SQL files except substitution variables (`&days`, `&cutoff`, `&ts_fmt`,
  `&dbtz`, `&max_tasks`, `&max_backlog`); the generated asset blocks use SET DEFINE OFF.
- All timestamps go out as UTC ISO strings; DATE columns are converted with the
  DB host offset (`&dbtz`). The page converts to the chosen time zone.

## Dev loop

```bash
tools/run_on_dbmint.sh [days] [PDB]       # real report into reports/
tools/extract_data.sh reports/<file>.html # then open web/dev.html over http
tools/build_assets.sh                     # before the next real run
```
The dbmint lab DB is shared with other experiments; counts can change between
sections of one run.
