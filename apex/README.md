# Statistics Observatory for Oracle APEX 26.2

APEX application 101 in workspace `MONITORING`, parsing schema `MONITORING`.

Open <http://100.108.246.57:8023/ords/r/monitoring/statistics-observatory/overview>
and sign in with a workspace end-user account. The installed `ORASTATS_VIEWER`
account has no App Builder privileges; its password is supplied separately.

The app uses Universal Theme, APEX account authentication, a server-rendered
dashboard region, application static files, and one local snapshot table.
The shared `web/app.js` renderer supplies the interactive timelines, filters,
run details, backlog, and setup views. `observatory.css` adds the APEX presentation.
No iframe or separate web server is required.

## Data and refresh

This is a **published snapshot**, not a live connection to CDB1. The header shows
the source database and collection time. Reload snapshot reloads the most recently
published data; it does not run a collection. No refresh schedule is installed.

The published snapshot is `reports/gather_dashboard_20261022_102158.html`, collected
on 2026-10-22 at 10:21 UTC, covering 31 days and 9,042 operations in CDB1.

After collecting a new report with the normal read-only collector:

```sh
tools/publish_apex.sh reports/your_new_report.html --snapshot-only
```

Snapshot publication replaces the single row in `MONITORING.GD_REPORT_SNAPSHOT`
in the local APEX database. It does not change APEX definitions or end sessions.
Report data is emitted only on the authenticated page, never in public static
files. The builder parses JSON rows without executing the report's JavaScript;
it preserves positional nulls and escapes HTML delimiters before embedding JSON.
Failed datasets remain absent so the renderer reports them as not collected.

## Install or update the presentation

```sh
tools/publish_apex.sh reports/your_report.html
```

This creates the snapshot table if necessary and replaces **this app's** definition.
It refuses to overwrite an application ID belonging to another app/workspace.
Updating the definition ends existing app sessions. Existing apps are untouched.
The scripts use the configured `ORACLE_PWD` within the local `23cfree` container,
without printing it. Docker access is required.

Overrides: `APEX_CONTAINER`, `APEX_PDB`, `APEX_WORKSPACE`, `APEX_SCHEMA`,
`APEX_APP_ID`. The workspace and schema must already exist. The schema needs no
catalog grants or connection to the monitored database.

To generate SQL for another installation without Docker:

```sh
python3 apex/build.py reports/your_report.html --workspace MONITORING \
  --schema MONITORING --app-id 101
```

Run `apex/build/install.sql` from its directory in SQL*Plus as an APEX administrator.
The generated `application.sql` also imports in App Builder, after the table/data
have been installed. `build/` is ignored because it contains the report snapshot.
No passwords are committed. Creating workspace users is a separate admin action.

The `apex/` SQL files are installation metadata, separate from the original
SELECT-only collector. They use `SET DEFINE OFF` in the generated installer.

Validation: `python3 -m unittest discover -s apex -p 'test_*.py'`,
`node --check apex/observatory.js`, and `tools/build_assets.sh --check`.
