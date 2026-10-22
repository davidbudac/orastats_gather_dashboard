#!/usr/bin/env python3
"""Generate the statistics-gathering Kibana objects under kibana/:

  data-views.ndjson               data view orastats-gather-* (UTC timestamps,
                                  durations formatted from seconds)
  dashboards/10-overview.ndjson   Statistics gathering - Overview
  dashboards/20-run.ndjson        Statistics gathering - Run detail
  dashboards/30-stale.ndjson      Statistics gathering - Needs statistics

Every panel/column id is md5-derived from a stable name, so a rebuild is
byte-identical unless this file changed. Edit this builder, not the output.
"""
import json
import os

from lens_lib import (
    AMBER, DASH_OVERVIEW, DASH_RUN, DASH_STALE, DATAVIEW, GREEN, GREY, KQL_LATEST,
    RED, DashboardBuilder, add_nav_panel, alarm_when_nonzero, cell_colors,
    col_count, col_date_histogram, col_last_value, col_max, col_metric,
    col_palette_steps, col_sum, col_terms, col_unique_count, fmt_number,
    heatmap_state, metric_state, table_state, xy_data_layer, xy_multi_state,
)

HERE = os.path.dirname(os.path.abspath(__file__))
RANGE = {"time_from": "now-31d", "time_to": "now"}

OPS = "gs.record:operation"
AUTO = "gs.record:operation and gs.op.kind:auto"
GATHERS = "gs.record:operation and gs.op.kind:(auto or gather)"
TASKS = "gs.record:task"
APP = "gs.oracle_maintained:false"
STALE_NOW = f'gs.record:stale and {KQL_LATEST}'
STATUS_NOW = f'gs.record:status and {KQL_LATEST}'
DUR = {"id": "duration", "params": {"inputFormat": "seconds", "outputFormat": "humanizePrecise",
                                    "outputPrecision": 1, "showSuffix": True, "useShortSuffix": True}}


def col_total(field, label, **kw):
    """A sum that shows 0, not N/A, when every value is zero (KPI tiles)."""
    c = col_metric("sum", field, label, **kw)
    c["params"]["emptyAsNull"] = False
    return c


def col_max_date(field, label):
    return col_metric("max", field, label, data_type="date")


def write_data_view():
    secs = ["gs.op.secs", "gs.op.cpu_secs", "gs.objects.secs", "gs.task.secs",
            "gs.win.secs", "gs.win.planned_secs"]
    fmt = {f: DUR for f in secs}
    fmt["gs.obj.pct_changed"] = {"id": "number", "params": {"pattern": "0,0.0"}}
    fmt["gs.status.hours_since_last_auto"] = {"id": "number", "params": {"pattern": "0,0.0"}}
    # Friendly names; dashboard controls show these as their titles
    labels = {
        "gs.db": "Database", "gs.con": "Container", "gs.owner": "Schema",
        "gs.oracle_maintained": "Oracle-maintained schema", "gs.record": "Record",
        "gs.op.key": "Run", "gs.op.kind": "Kind", "gs.op.outcome": "Outcome",
        "gs.op.name": "Operation", "gs.op.secs": "Run time", "gs.op.window": "Window",
        "gs.task.target": "Object", "gs.task.secs": "Object time", "gs.task.status": "Object status",
        "gs.obj.key": "Object", "gs.obj.category": "Reason", "gs.obj.pct_changed": "Changed %",
    }
    dv = {
        "attributes": {
            "name": "Statistics gathering",
            "fieldAttrs": json.dumps({f: {"customLabel": l} for f, l in labels.items()}, sort_keys=True),
            "title": "orastats-gather-*",
            "timeFieldName": "@timestamp",
            "fieldFormatMap": json.dumps(fmt, sort_keys=True),
            "allowNoIndex": True,
        },
        "coreMigrationVersion": "8.8.0",
        "id": DATAVIEW,
        "managed": False,
        "references": [],
        "type": "index-pattern",
        "typeMigrationVersion": "8.0.0",
    }
    path = os.path.join(HERE, "data-views.ndjson")
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(dv, separators=(",", ":")) + "\n")
    print(f"wrote {path}")


def kpi(b, name, title, x, y, w, h, col, query, pal=None, color=None):
    m = b.uid(f"col:{name}")
    b.add_lens(name, title, x, y, w, h, "lnsMetric",
               metric_state(m, color=color, pal=pal), {m: col}, [m], query=query)


def cid(b, panel, name):
    return b.uid(f"col:{panel}-{name}")


# ------------------------------------------------------------------ overview
def overview():
    b = DashboardBuilder(
        "orastats-gather-overview", DASH_OVERVIEW, "Statistics gathering - Overview",
        "DBMS_STATS statistics gathering on Oracle 19c: automatic runs, manual and "
        "custom gathers, what failed, what took longest, and whether maintenance "
        "windows ran the job.", **RANGE)
    add_nav_panel(b)
    b.add_controls([("gs.db", "Database"), ("gs.con", "Container"), ("gs.op.kind", "Kind"),
                    ("gs.op.outcome", "Outcome"), ("gs.oracle_maintained", "Oracle-maintained schema")])

    b.add_markdown("header", 0, 0, 16, 12, (
        "**Did the automatic statistics job run, and did it gather everything?**\n\n"
        "Each **automatic run** is one `gather_database_stats (auto)` in a "
        "maintenance window. **Outcome** is *complete*, *objects_failed* (some "
        "objects failed), *incomplete* (objects left unprocessed, usually the "
        "window closed), *timed_out*, *failed*, *never_finished* or *running*.\n\n"
        "`X$LOGMNR_CONTENTS` fails in every run by design; it is counted as "
        "*expected* and never as a failure. Click a run in **Automatic runs** "
        "to open it in *Run detail*. Times are UTC."))

    tiles = [
        ("kpi-auto", "Automatic runs", col_count("Runs", fmt=fmt_number(0)), AUTO, None, None),
        ("kpi-bad", "Automatic runs with problems",
         col_count("Runs", kql="not gs.op.outcome:(complete or running)", fmt=fmt_number(0)),
         AUTO, alarm_when_nonzero(), None),
        ("kpi-since", "Hours since the last automatic run (worst container)",
         col_max("gs.status.hours_since_last_auto", "Hours", fmt=fmt_number(1)),
         STATUS_NOW, col_palette_steps(30, 50), None),
        ("kpi-stale", "Application objects needing statistics now",
         col_unique_count("gs.obj.key", "Objects", fmt=fmt_number(0)),
         f"{STALE_NOW} and {APP} and not gs.obj.category:missing_subpartition", alarm_when_nonzero(AMBER), None),
        ("kpi-gathered", "Objects gathered",
         col_total("gs.objects.gathered", "Objects", fmt=fmt_number(0)), GATHERS, None, None),
        ("kpi-failed", "Objects that failed",
         col_total("gs.objects.failed", "Objects", fmt=fmt_number(0)), GATHERS, alarm_when_nonzero(), None),
        ("kpi-time", "Time spent gathering",
         col_total("gs.op.secs", "Time"), GATHERS, None, None),
        ("kpi-nowin", "Maintenance windows without an automatic run",
         col_count("Windows", kql="gs.win.has_auto_run:false", fmt=fmt_number(0)),
         "gs.record:window and gs.win.maintenance:true", alarm_when_nonzero(AMBER), None),
    ]
    for i, (name, title, col, q, pal, color) in enumerate(tiles):
        kpi(b, name, title, 16 + (i % 4) * 8, (i // 4) * 6, 8, 6, col, q, pal=pal, color=color)

    p = "runs-outcome"
    x, n, k = cid(b, p, "x"), cid(b, p, "n"), cid(b, p, "k")
    b.add_lens(p, "Automatic runs per day, by outcome", 0, 12, 24, 12, "lnsXY",
               xy_multi_state([xy_data_layer("bar_stacked", x, [n], split=k)]),
               {x: col_date_histogram(), n: col_count("Runs"),
                k: col_terms("gs.op.outcome", "Outcome", n, size=8)},
               [k, x, n], query=AUTO)

    p = "run-time"
    x, m, c = cid(b, p, "x"), cid(b, p, "max"), cid(b, p, "con")
    b.add_lens(p, "Longest automatic run per day, by container", 24, 12, 24, 12, "lnsXY",
               xy_multi_state([xy_data_layer("line", x, [m], split=c)]),
               {x: col_date_histogram(empty_rows=False), m: col_max("gs.op.secs", "Run time"),
                c: col_terms("gs.con", "Container", m, size=10)},
               [c, x, m], query=AUTO)

    p = "heat"
    x, y, n = cid(b, p, "x"), cid(b, p, "hour"), cid(b, p, "n")
    b.add_lens(p, "When automatic runs start: hour of day by day", 0, 24, 24, 13, "lnsHeatmap",
               heatmap_state(x, y, n),
               {x: col_date_histogram(empty_rows=True), n: col_count("Runs", fmt=fmt_number(0)),
                y: col_terms("gs.op.hour", "Hour", None, size=24, direction="asc")},
               [y, x, n], query=AUTO)

    p = "objects"
    x, s, k = cid(b, p, "x"), cid(b, p, "sum"), cid(b, p, "kind")
    b.add_lens(p, "Objects gathered per day, automatic vs manual", 24, 24, 24, 13, "lnsXY",
               xy_multi_state([xy_data_layer("bar_stacked", x, [s], split=k)]),
               {x: col_date_histogram(), s: col_sum("gs.objects.gathered", "Objects"),
                k: col_terms("gs.op.kind", "Kind", s, size=3)},
               [k, x, s], query=GATHERS)

    p = "runs"
    key, con, st, oc, secs, tot, fl, win = (cid(b, p, n) for n in
                                            ("key", "con", "start", "outcome", "secs", "total", "failed", "win"))
    cols = {
        st: col_max_date("gs.op.start", "Started"),
        key: col_terms("gs.op.key", "Run", st, size=200),
        con: col_last_value("gs.con", "Container", data_type="string"),
        oc: col_last_value("gs.op.outcome", "Outcome", data_type="string"),
        secs: col_max("gs.op.secs", "Run time"),
        tot: col_sum("gs.objects.total", "Objects", fmt=fmt_number(0)),
        fl: col_sum("gs.objects.failed", "Failed", fmt=fmt_number(0)),
        win: col_last_value("gs.op.window", "Window", data_type="string"),
    }
    order = [key, st, con, oc, secs, tot, fl, win]
    b.add_lens(p, "Automatic runs, newest first (click a run to open it)", 0, 37, 24, 16, "lnsDatatable",
               table_state(order, st, page_size=12, overrides={
                   fl: cell_colors(alarm_when_nonzero())}),
               cols, order, query=AUTO, drill_to=[DASH_RUN], drill_label=["Open run detail"])

    p = "windows"
    x, n, k = cid(b, p, "x"), cid(b, p, "n"), cid(b, p, "ran")
    b.add_lens(p, "Maintenance windows per day: with and without an automatic run", 24, 37, 24, 16, "lnsXY",
               xy_multi_state([xy_data_layer("bar_stacked", x, [n], split=k)]),
               {x: col_date_histogram(), n: col_count("Windows"),
                k: col_terms("gs.win.has_auto_run", "Automatic run in it", n, size=2, data_type="boolean")},
               [k, x, n], query="gs.record:window and gs.win.maintenance:true")

    p = "failures"
    tgt, con, n, err, last = (cid(b, p, x) for x in ("target", "con", "n", "err", "last"))
    cols = {
        n: col_count("Runs", fmt=fmt_number(0)),
        tgt: col_terms("gs.task.target", "Object", n, size=100),
        con: col_terms("gs.con", "Container", None, size=20),
        last: col_max_date("@timestamp", "Last"),
        err: col_last_value("gs.task.error.keyword", "Last error", data_type="string"),
    }
    order = [tgt, con, n, last, err]
    b.add_lens(p, "Objects that failed (expected failures left out)", 0, 53, 24, 14, "lnsDatatable",
               table_state(order, n, page_size=10, overrides={tgt: {"width": 230}, con: {"width": 100},
                                                               n: {"width": 60}, last: {"width": 150}}),
               cols, order, query=f"{TASKS} and gs.task.status:FAILED and gs.task.expected:false")

    p = "slowest"
    tgt, con, n, tot, mx = (cid(b, p, x) for x in ("target", "con", "n", "total", "max"))
    cols = {
        tot: col_sum("gs.task.secs", "Total time"),
        tgt: col_terms("gs.task.target", "Object", tot, size=100),
        con: col_terms("gs.con", "Container", None, size=20),
        n: col_count("Gathers", fmt=fmt_number(0)),
        mx: col_max("gs.task.secs", "Longest"),
    }
    order = [tgt, con, n, tot, mx]
    b.add_lens(p, "Slowest objects: total gather time", 24, 53, 24, 14, "lnsDatatable",
               table_state(order, tot, page_size=10, overrides={tgt: {"width": 260}}),
               cols, order, query=TASKS)

    b.write("10-overview.ndjson")


# ------------------------------------------------------------------ one run
def run_detail():
    b = DashboardBuilder(
        "orastats-gather-run", DASH_RUN, "Statistics gathering - Run detail",
        "One DBMS_STATS operation (pick it in the Run control, or click a run on the "
        "overview): what it gathered, what failed, where the time went. With no run "
        "picked, every run in the time range adds up.", **RANGE)
    add_nav_panel(b)
    b.add_control("gs.op.key", "gs.op.key", 0, single=True, width="large", title="Run")
    b.add_control("gs.con", "gs.con", 1, title="Container")
    b.add_control("gs.op.kind", "gs.op.kind", 2, title="Kind")

    b.add_markdown("header", 0, 0, 16, 12, (
        "**One run, object by object.** Pick a run in the **Run** control "
        "(`container:operation id`), or click one in *Automatic runs* on the "
        "overview. Objects come from `DBA_OPTSTAT_OPERATION_TASKS`; times add "
        "up to more than the run took when objects ran concurrently.\n\n"
        "Widen the time range if the run is older than the picker."))

    tiles = [
        ("kpi-secs", "Run time", col_max("gs.op.secs", "Run time"), OPS, None),
        ("kpi-total", "Objects", col_total("gs.objects.total", "Objects", fmt=fmt_number(0)), OPS, None),
        ("kpi-gathered", "Gathered", col_total("gs.objects.gathered", "Gathered", fmt=fmt_number(0)), OPS, None),
        ("kpi-failed", "Failed", col_total("gs.objects.failed", "Failed", fmt=fmt_number(0)), OPS, alarm_when_nonzero()),
        ("kpi-notdone", "Not processed", col_total("gs.objects.not_processed", "Objects", fmt=fmt_number(0)), OPS,
         alarm_when_nonzero()),
        ("kpi-hist", "With histograms", col_total("gs.objects.histograms", "Objects", fmt=fmt_number(0)), OPS, None),
        ("kpi-cpu", "Scheduler CPU", col_max("gs.op.cpu_secs", "CPU"), OPS, None),
        ("kpi-outcome", "Outcome", col_last_value("gs.op.outcome", "Outcome", data_type="string"), OPS, None),
    ]
    for i, (name, title, col, q, pal) in enumerate(tiles):
        kpi(b, name, title, 16 + (i % 4) * 8, (i // 4) * 6, 8, 6, col, q, pal=pal)

    p = "by-type"
    t, n, s, f = cid(b, p, "type"), cid(b, p, "n"), cid(b, p, "secs"), cid(b, p, "failed")
    cols = {
        s: col_sum("gs.task.secs", "Time"),
        t: col_terms("gs.task.type", "Object type", s, size=10),
        n: col_count("Objects", fmt=fmt_number(0)),
        f: col_count("Failed", kql="gs.task.status:FAILED and gs.task.expected:false", fmt=fmt_number(0)),
    }
    order = [t, n, f, s]
    b.add_lens(p, "By object type", 0, 12, 16, 12, "lnsDatatable",
               table_state(order, s, page_size=10, overrides={f: cell_colors(alarm_when_nonzero())}),
               cols, order, query=TASKS)

    p = "by-schema"
    o, s = cid(b, p, "owner"), cid(b, p, "secs")
    b.add_lens(p, "Time by schema", 16, 12, 16, 12, "lnsXY",
               xy_multi_state([xy_data_layer("bar_horizontal", o, [s], colors={s: "#6a5acd"})], legend=False),
               {s: col_sum("gs.task.secs", "Time"), o: col_terms("gs.owner", "Schema", s, size=12)},
               [o, s], query=TASKS)

    p = "status"
    st, n = cid(b, p, "status"), cid(b, p, "n")
    b.add_lens(p, "Objects by status", 32, 12, 16, 12, "lnsXY",
               xy_multi_state([xy_data_layer("bar_horizontal", st, [n], colors={n: GREY})], legend=False),
               {n: col_count("Objects"), st: col_terms("gs.task.status", "Status", n, size=6)},
               [st, n], query=TASKS)

    p = "objects"
    tgt, ty, st, secs, size, hist, err, start = (cid(b, p, x) for x in
                                                 ("target", "type", "status", "secs", "size", "hist", "err", "start"))
    cols = {
        secs: col_sum("gs.task.secs", "Time"),
        tgt: col_terms("gs.task.target", "Object", secs, size=1000),
        ty: col_last_value("gs.task.type", "Type", data_type="string"),
        st: col_last_value("gs.task.status", "Status", data_type="string"),
        start: col_max_date("gs.task.start", "Started"),
        size: col_max("gs.task.size", "Size (blocks)", fmt=fmt_number(0)),
        hist: col_max("gs.task.histograms", "Histograms", fmt=fmt_number(0)),
        err: col_last_value("gs.task.error.keyword", "Error", data_type="string"),
    }
    order = [tgt, ty, st, start, secs, size, hist, err]
    b.add_lens(p, "Objects, slowest first", 0, 24, 48, 20, "lnsDatatable",
               table_state(order, secs, page_size=20, overrides={tgt: {"width": 300}}),
               cols, order, query=TASKS)

    p = "params"
    key, name, tgt, job, win, start, oc = (cid(b, p, x) for x in
                                           ("key", "name", "target", "job", "win", "start", "oc"))
    cols = {
        start: col_max_date("gs.op.start", "Started"),
        key: col_terms("gs.op.key", "Run", start, size=50),
        name: col_last_value("gs.op.name", "Operation", data_type="string"),
        tgt: col_last_value("gs.op.target", "Target", data_type="string"),
        job: col_last_value("gs.op.job", "Job", data_type="string"),
        win: col_last_value("gs.op.window", "Window", data_type="string"),
        oc: col_last_value("gs.op.outcome", "Outcome", data_type="string"),
    }
    order = [key, start, name, tgt, oc, job, win]
    b.add_lens(p, "Runs in view", 0, 44, 48, 10, "lnsDatatable",
               table_state(order, start, page_size=8), cols, order, query=OPS)

    b.write("20-run.ndjson")


# ------------------------------------------------------------------ stale now
def stale():
    b = DashboardBuilder(
        "orastats-gather-stale", DASH_STALE, "Statistics gathering - Needs statistics",
        "Tables, partitions and subpartitions that are stale or have no statistics "
        "in the latest export, why, and how that changed day by day.", **RANGE)
    add_nav_panel(b)
    b.add_controls([("gs.con", "Container"), ("gs.owner", "Schema"), ("gs.obj.category", "Reason")])

    b.add_markdown("header", 0, 0, 16, 11, (
        "**What still needs statistics, and why.** From the latest export "
        "(last 26 h).\n\n"
        "**missed**: changed before the last automatic run started, yet that "
        "run did not gather it. **locked**: statistics locked; the job skips it. "
        "**missing**: never gathered. **fresh**: changed after the last "
        "automatic run; the next one should pick it up. "
        "**missing_subpartition**: usually by design (GRANULARITY AUTO). "
        "**fixed**: X$ tables, gathered only by GATHER_FIXED_OBJECTS_STATS.\n\n"
        "Application schemas only: Oracle-maintained schemas (SYS, SYSTEM, ...) "
        "are left out."))

    tiles = [
        ("kpi-missed", "Missed by the last automatic run", "missed", RED),
        ("kpi-locked", "Stale or missing, but locked", "locked", AMBER),
        ("kpi-missing", "No statistics at all", "missing", AMBER),
        ("kpi-fresh", "Stale since the last automatic run", "fresh", None),
    ]
    for i, (name, title, cat, color) in enumerate(tiles):
        col = col_unique_count("gs.obj.key", "Objects", kql=f"gs.obj.category:{cat}", fmt=fmt_number(0))
        kpi(b, name, title, 16 + i * 8, 0, 8, 6, col, f"{STALE_NOW} and {APP}",
            pal=alarm_when_nonzero(color) if color else None)

    p = "cons"
    con, ts, hrs, last, st, mi, lk = (cid(b, p, x) for x in ("con", "task", "hrs", "last", "stale", "missing", "locked"))
    cols = {
        con: col_terms("gs.con", "Container", None, size=50),
        ts: col_last_value("gs.status.task_status", "Automatic task", data_type="string"),
        last: col_max_date("gs.status.last_auto_start", "Last automatic run"),
        hrs: col_max("gs.status.hours_since_last_auto", "Hours since", fmt=fmt_number(1)),
        st: col_max("gs.status.app_stale", "App stale", fmt=fmt_number(0)),
        mi: col_max("gs.status.app_missing", "App missing", fmt=fmt_number(0)),
        lk: col_max("gs.status.app_locked", "App locked", fmt=fmt_number(0)),
    }
    order = [con, ts, last, hrs, st, mi, lk]
    b.add_lens(p, "Containers (latest export)", 16, 6, 32, 5, "lnsDatatable",
               table_state(order, con, direction="asc", page_size=5, overrides={
                   hrs: cell_colors(col_palette_steps(30, 50))}),
               cols, order, query=STATUS_NOW)

    p = "trend"
    x, n, k = cid(b, p, "x"), cid(b, p, "n"), cid(b, p, "cat")
    b.add_lens(p, "Objects needing statistics per export day, by reason", 0, 11, 48, 12, "lnsXY",
               xy_multi_state([xy_data_layer("bar_stacked", x, [n], split=k)]),
               {x: col_date_histogram(), n: col_unique_count("gs.obj.key", "Objects"),
                k: col_terms("gs.obj.category", "Reason", n, size=8)},
               [k, x, n], query=f"gs.record:stale and {APP}")

    p = "now"
    key, cat, ty, rows, pct, dml, ana, dts, lock = (cid(b, p, x) for x in
                                                   ("key", "cat", "type", "rows", "pct", "dml", "ana", "dts", "lock"))
    cols = {
        pct: col_max("gs.obj.pct_changed", "Changed %", fmt=fmt_number(1)),
        key: col_terms("gs.obj.key", "Object", pct, size=1000, missing=False),
        cat: col_last_value("gs.obj.category", "Reason", data_type="string"),
        ty: col_last_value("gs.obj.type", "Type", data_type="string"),
        rows: col_max("gs.obj.rows", "Rows", fmt=fmt_number(0)),
        dml: col_max("gs.obj.dml", "Rows changed", fmt=fmt_number(0)),
        ana: col_max_date("gs.obj.last_analyzed", "Last analyzed"),
        dts: col_max_date("gs.obj.dml_ts", "Last DML"),
        lock: col_last_value("gs.obj.locked", "Locked", data_type="string"),
    }
    order = [key, cat, ty, rows, dml, pct, ana, dts, lock]
    b.add_lens(p, "Needing statistics now (latest export)", 0, 23, 48, 20, "lnsDatatable",
               table_state(order, pct, page_size=20, overrides={
                   key: {"width": 320},
                   pct: cell_colors(col_palette_steps(10, 50, colors=(GREEN, AMBER, RED)))}),
               cols, order, query=f"{STALE_NOW} and {APP}")

    b.write("30-stale.ndjson")


if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "dashboards"), exist_ok=True)
    write_data_view()
    overview()
    run_detail()
    stale()
