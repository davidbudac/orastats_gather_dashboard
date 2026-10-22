--
-- elastic/export_gather.sql
-- Statistics gathering as NDJSON for the Elastic Stack: one JSON document per
-- line, each with a deterministic "id" so a re-run overwrites instead of
-- duplicating.  Run through elastic/export.sh (which defines gs_days and
-- gs_source and validates every line against the index template).
--
-- Read-only like the HTML report: SELECTs only, on the CDB_* views, so it
-- covers every container when run in CDB$ROOT.
--
-- Records (gs.record), each routed by Logstash to orastats-gather-<record>:
--   operation  one per DBMS_STATS operation started in the last gs_days days
--   task       one per object an operation touched (gather operations only)
--   stale      one per table/partition/subpartition stale or without
--              statistics now, per export day (a daily snapshot)
--   window     one per scheduler window opened in the last gs_days days
--   status     one per container per export hour: task status, last
--              automatic run, stale counts
-- Every timestamp is UTC.  DATE columns are converted with the DB host offset.
--

SET ECHO OFF
SET VERIFY OFF
SET FEEDBACK OFF
SET HEADING OFF
SET PAGESIZE 0
SET LINESIZE 32767
SET TRIMOUT ON
SET TAB OFF
SET SQLBLANKLINES ON
SET DEFINE ON

COLUMN p_dbtz NEW_VALUE gs_dbtz NOPRINT
SELECT TO_CHAR(SYSTIMESTAMP, 'TZH:TZM') p_dbtz FROM dual;
DEFINE ts_fmt = 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'
DEFINE gs_cutoff = "SYSTIMESTAMP - NUMTODSINTERVAL(&gs_days, 'DAY')"

-- ------------------------------------------------------------- operations
WITH ops AS (
    SELECT o.con_id, o.id, o.operation, o.target, o.start_time, o.end_time,
           o.status, o.job_name, o.session_id,
           SUBSTR(o.notes, 1, 4000) AS notes,
           CASE WHEN o.operation = 'gather_database_stats (auto)' THEN 'auto'
                WHEN o.operation LIKE 'gather\_%' ESCAPE '\'
                 AND o.operation NOT LIKE '%reporting mode%' THEN 'gather'
                ELSE 'other' END AS kind,
           REGEXP_SUBSTR(REPLACE(o.target, '"'), '[^.]+', 1, 1) AS owner
    FROM cdb_optstat_operations o
    WHERE o.start_time >= &gs_cutoff
),
agg AS (
    SELECT t.con_id, t.opid,
           COUNT(*) AS n,
           SUM(CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN t.status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN t.status = 'FAILED' AND t.target LIKE '%X$LOGMNR_CONTENTS%' THEN 1 ELSE 0 END) AS expected,
           SUM(CASE WHEN t.status NOT IN ('COMPLETED', 'FAILED') THEN 1 ELSE 0 END) AS not_done,
           SUM(CASE WHEN t.notes LIKE '%<histograms>_%' AND t.notes NOT LIKE '%<histograms></histograms>%'
                    THEN 1 ELSE 0 END) AS hist,
           SUM(EXTRACT(DAY FROM (t.end_time - t.start_time)) * 86400
             + EXTRACT(HOUR FROM (t.end_time - t.start_time)) * 3600
             + EXTRACT(MINUTE FROM (t.end_time - t.start_time)) * 60
             + EXTRACT(SECOND FROM (t.end_time - t.start_time))) AS secs
    FROM cdb_optstat_operation_tasks t
    WHERE (t.con_id, t.opid) IN (SELECT con_id, id FROM ops)
    GROUP BY t.con_id, t.opid
),
ajh AS (
    SELECT h.con_id, h.job_name, MAX(h.window_name) AS window_name, MAX(h.job_status) AS job_status
    FROM cdb_autotask_job_history h
    WHERE h.client_name = 'auto optimizer stats collection'
      AND h.job_start_time >= &gs_cutoff - NUMTODSINTERVAL(1, 'DAY')
    GROUP BY h.con_id, h.job_name
),
sjr AS (
    SELECT r.con_id, r.job_name,
           MAX(EXTRACT(DAY FROM r.cpu_used) * 86400 + EXTRACT(HOUR FROM r.cpu_used) * 3600
             + EXTRACT(MINUTE FROM r.cpu_used) * 60 + EXTRACT(SECOND FROM r.cpu_used)) AS cpu
    FROM cdb_scheduler_job_run_details r
    WHERE r.log_date >= &gs_cutoff - NUMTODSINTERVAL(1, 'DAY')
      AND (r.con_id, r.job_name) IN (SELECT con_id, job_name FROM ops WHERE job_name IS NOT NULL)
    GROUP BY r.con_id, r.job_name
),
shaped AS (
    SELECT ops.*, a.n, a.done, a.failed, a.expected, a.not_done, a.hist, a.secs AS obj_secs,
           ajh.window_name, ajh.job_status, sjr.cpu,
           EXTRACT(DAY FROM (NVL(ops.end_time, ops.start_time) - ops.start_time)) * 86400
             + EXTRACT(HOUR FROM (NVL(ops.end_time, ops.start_time) - ops.start_time)) * 3600
             + EXTRACT(MINUTE FROM (NVL(ops.end_time, ops.start_time) - ops.start_time)) * 60
             + EXTRACT(SECOND FROM (NVL(ops.end_time, ops.start_time) - ops.start_time)) AS secs,
           REGEXP_SUBSTR(ops.notes, '<error>(.*?)</error>', 1, 1, 'n', 1) AS err_raw,
           CASE WHEN ops.status = 'FAILED' THEN 'failed'
                WHEN ops.status = 'TIMED OUT' THEN 'timed_out'
                WHEN ops.end_time IS NULL AND ops.status IN ('IN PROGRESS', 'PENDING')
                 AND ops.start_time < SYSTIMESTAMP - NUMTODSINTERVAL(1, 'DAY') THEN 'never_finished'
                WHEN ops.status = 'IN PROGRESS' THEN 'running'
                WHEN NVL(a.not_done, 0) > 0 THEN 'incomplete'
                WHEN NVL(a.failed, 0) - NVL(a.expected, 0) > 0 THEN 'objects_failed'
                ELSE 'complete' END AS outcome,
           c.name AS con_name, d.name AS db_name,
           (SELECT 'Y' FROM cdb_users u
            WHERE u.con_id = ops.con_id AND u.username = ops.owner AND u.oracle_maintained = 'Y') AS om
    FROM ops
    LEFT JOIN agg a ON a.con_id = ops.con_id AND a.opid = ops.id
    LEFT JOIN ajh ON ajh.con_id = ops.con_id AND ajh.job_name = ops.job_name
    LEFT JOIN sjr ON sjr.con_id = ops.con_id AND sjr.job_name = ops.job_name
    LEFT JOIN v$containers c ON c.con_id = ops.con_id
    CROSS JOIN v$database d
)
SELECT JSON_OBJECT(
    'id' VALUE 'op|&gs_source|' || con_id || '|' || id,
    '@timestamp' VALUE TO_CHAR(SYS_EXTRACT_UTC(start_time), '&ts_fmt'),
    'gs' VALUE JSON_OBJECT(
        'record' VALUE 'operation',
        'source' VALUE '&gs_source',
        'db' VALUE db_name,
        'con' VALUE NVL(con_name, db_name),
        'con_id' VALUE con_id,
        'owner' VALUE CASE WHEN kind = 'auto' THEN NULL ELSE owner END,
        'oracle_maintained' VALUE CASE WHEN om = 'Y' OR operation LIKE '%dictionary%' OR operation LIKE '%fixed_objects%'
                                        OR operation LIKE '%system_stats%' THEN 'true' ELSE 'false' END FORMAT JSON,
        'exported_at' VALUE TO_CHAR(SYS_EXTRACT_UTC(SYSTIMESTAMP), '&ts_fmt'),
        'op' VALUE JSON_OBJECT(
            'id' VALUE id,
            'key' VALUE NVL(con_name, db_name) || ':' || id,
            'name' VALUE operation,
            'kind' VALUE kind,
            'target' VALUE CASE WHEN kind = 'auto' THEN NULL ELSE REPLACE(target, '"') END,
            'status' VALUE status,
            'outcome' VALUE outcome,
            'start' VALUE TO_CHAR(SYS_EXTRACT_UTC(start_time), '&ts_fmt'),
            'end' VALUE TO_CHAR(SYS_EXTRACT_UTC(end_time), '&ts_fmt'),
            'secs' VALUE ROUND(secs, 3),
            'hour' VALUE TO_CHAR(start_time, 'HH24'),
            'job' VALUE job_name,
            'session_id' VALUE session_id,
            'window' VALUE window_name,
            'job_status' VALUE job_status,
            'cpu_secs' VALUE ROUND(cpu, 2),
            'error' VALUE SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(err_raw,
                CHR(38) || 'quot;', '"'), CHR(38) || 'apos;', ''''), CHR(38) || 'lt;', '<'),
                CHR(38) || 'gt;', '>'), CHR(38) || 'amp;', CHR(38)), 1, 1000)
            ABSENT ON NULL),
        'objects' VALUE JSON_OBJECT(
            'total' VALUE NVL(n, 0),
            'gathered' VALUE NVL(done, 0),
            'failed' VALUE NVL(failed, 0) - NVL(expected, 0),
            'failed_expected' VALUE NVL(expected, 0),
            'not_processed' VALUE NVL(not_done, 0),
            'histograms' VALUE NVL(hist, 0),
            'secs' VALUE ROUND(NVL(obj_secs, 0), 3))
        ABSENT ON NULL)
    RETURNING VARCHAR2(4000))
FROM shaped
ORDER BY start_time, con_id, id;

-- ------------------------------------------------------------- tasks
WITH ops AS (
    SELECT o.con_id, o.id, o.operation, o.job_name, o.start_time,
           CASE WHEN o.operation = 'gather_database_stats (auto)' THEN 'auto' ELSE 'gather' END AS kind
    FROM cdb_optstat_operations o
    WHERE o.start_time >= &gs_cutoff
      AND o.operation LIKE 'gather\_%' ESCAPE '\'
      AND o.operation NOT LIKE '%reporting mode%'
),
t AS (
    SELECT t.con_id, t.opid, REPLACE(t.target, '"') AS target, t.target_type, t.target_size,
           t.start_time, t.end_time, t.status,
           SUBSTR(t.notes, 1, 4000) AS notes,
           ops.operation, ops.job_name, ops.kind,
           EXTRACT(DAY FROM (t.end_time - t.start_time)) * 86400
             + EXTRACT(HOUR FROM (t.end_time - t.start_time)) * 3600
             + EXTRACT(MINUTE FROM (t.end_time - t.start_time)) * 60
             + EXTRACT(SECOND FROM (t.end_time - t.start_time)) AS secs
    FROM cdb_optstat_operation_tasks t
    JOIN ops ON ops.con_id = t.con_id AND ops.id = t.opid
),
shaped AS (
    SELECT t.*,
           REGEXP_SUBSTR(t.target, '[^.]+', 1, 1) AS owner,
           REGEXP_SUBSTR(t.target, '[^.]+', 1, 2) AS obj,
           REGEXP_SUBSTR(t.target, '[^.]+', 1, 3) AS part,
           REGEXP_SUBSTR(t.target, '[^.]+', 1, 4) AS subpart,
           REGEXP_SUBSTR(t.notes, '<histograms>([^<]*)</histograms>', 1, 1, NULL, 1) AS hist,
           REGEXP_SUBSTR(t.notes, '<error>(.*?)</error>', 1, 1, 'n', 1) AS err_raw,
           c.name AS con_name, d.name AS db_name,
           (SELECT 'Y' FROM cdb_users u
            WHERE u.con_id = t.con_id AND u.username = REGEXP_SUBSTR(t.target, '[^.]+', 1, 1)
              AND u.oracle_maintained = 'Y') AS om
    FROM t
    LEFT JOIN v$containers c ON c.con_id = t.con_id
    CROSS JOIN v$database d
)
SELECT JSON_OBJECT(
    'id' VALUE 'task|&gs_source|' || con_id || '|' || opid || '|'
               || RAWTOHEX(STANDARD_HASH(target || '|' || TO_CHAR(start_time, 'YYYYMMDDHH24MISSFF6'), 'MD5')),
    '@timestamp' VALUE TO_CHAR(SYS_EXTRACT_UTC(NVL(start_time, SYSTIMESTAMP)), '&ts_fmt'),
    'gs' VALUE JSON_OBJECT(
        'record' VALUE 'task',
        'source' VALUE '&gs_source',
        'db' VALUE db_name,
        'con' VALUE NVL(con_name, db_name),
        'con_id' VALUE con_id,
        'owner' VALUE owner,
        'oracle_maintained' VALUE CASE WHEN om = 'Y' THEN 'true' ELSE 'false' END FORMAT JSON,
        'exported_at' VALUE TO_CHAR(SYS_EXTRACT_UTC(SYSTIMESTAMP), '&ts_fmt'),
        'op' VALUE JSON_OBJECT(
            'id' VALUE opid,
            'key' VALUE NVL(con_name, db_name) || ':' || opid,
            'name' VALUE operation,
            'kind' VALUE kind,
            'job' VALUE job_name
            ABSENT ON NULL),
        'task' VALUE JSON_OBJECT(
            'target' VALUE target,
            'object' VALUE obj,
            'partition' VALUE part,
            'subpartition' VALUE subpart,
            'type' VALUE LOWER(target_type),
            'status' VALUE status,
            'start' VALUE TO_CHAR(SYS_EXTRACT_UTC(start_time), '&ts_fmt'),
            'end' VALUE TO_CHAR(SYS_EXTRACT_UTC(end_time), '&ts_fmt'),
            'secs' VALUE ROUND(secs, 3),
            'size' VALUE target_size,
            'histograms' VALUE CASE WHEN hist IS NULL THEN 0
                                    ELSE REGEXP_COUNT(hist, '[^;]+') END,
            'expected' VALUE CASE WHEN status = 'FAILED' AND target LIKE '%X$LOGMNR_CONTENTS%'
                                  THEN 'true' ELSE 'false' END FORMAT JSON,
            'error' VALUE SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(err_raw,
                CHR(38) || 'quot;', '"'), CHR(38) || 'apos;', ''''), CHR(38) || 'lt;', '<'),
                CHR(38) || 'gt;', '>'), CHR(38) || 'amp;', CHR(38)), 1, 1000)
            ABSENT ON NULL)
        ABSENT ON NULL)
    RETURNING VARCHAR2(4000))
FROM shaped
ORDER BY con_id, opid, start_time NULLS LAST;

-- ------------------------------------------------------------- stale snapshot
WITH last_auto AS (
    SELECT o.con_id, MAX(o.start_time) AS start_time
    FROM cdb_optstat_operations o
    WHERE o.operation = 'gather_database_stats (auto)'
    GROUP BY o.con_id
),
bl AS (
    SELECT s.con_id, s.owner, s.table_name, s.partition_name, s.subpartition_name,
           s.object_type, s.num_rows, s.blocks, s.last_analyzed, s.stale_stats, s.stattype_locked,
           m.inserts, m.updates, m.deletes, m.truncated, m.timestamp AS dml_ts,
           NVL(u.oracle_maintained, 'N') AS om,
           FROM_TZ(CAST(m.timestamp AS TIMESTAMP), '&gs_dbtz') AS dml_tstz,
           la.start_time AS last_auto
    FROM cdb_tab_statistics s
    LEFT JOIN cdb_users u
           ON u.con_id = s.con_id AND u.username = s.owner
    LEFT JOIN cdb_tab_modifications m
           ON m.con_id = s.con_id
          AND m.table_owner = s.owner
          AND m.table_name = s.table_name
          AND DECODE(m.partition_name, s.partition_name, 1, 0) = 1
          AND DECODE(m.subpartition_name, s.subpartition_name, 1, 0) = 1
    LEFT JOIN last_auto la ON la.con_id = s.con_id
    WHERE (s.stale_stats = 'YES' OR s.last_analyzed IS NULL)
      AND s.table_name NOT LIKE 'BIN$%'
      AND NOT EXISTS (
          SELECT 1 FROM cdb_tables t
          WHERE t.con_id = s.con_id AND t.owner = s.owner AND t.table_name = s.table_name
            AND t.temporary = 'Y')
      AND NOT EXISTS (
          SELECT 1 FROM cdb_external_tables x
          WHERE x.con_id = s.con_id AND x.owner = s.owner AND x.table_name = s.table_name)
),
shaped AS (
    SELECT bl.*,
           bl.owner || '.' || bl.table_name
             || CASE WHEN bl.partition_name IS NOT NULL THEN '.' || bl.partition_name END
             || CASE WHEN bl.subpartition_name IS NOT NULL THEN '.' || bl.subpartition_name END AS name,
           NVL(bl.inserts, 0) + NVL(bl.updates, 0) + NVL(bl.deletes, 0) AS dml,
           CASE WHEN bl.stattype_locked IS NOT NULL THEN 'locked'
                WHEN bl.object_type = 'FIXED TABLE' THEN 'fixed'
                WHEN bl.last_analyzed IS NULL AND bl.object_type = 'SUBPARTITION' THEN 'missing_subpartition'
                WHEN bl.last_analyzed IS NULL THEN 'missing'
                WHEN bl.dml_ts IS NOT NULL AND bl.last_auto IS NOT NULL AND bl.dml_tstz < bl.last_auto THEN 'missed'
                WHEN bl.dml_ts IS NOT NULL AND bl.last_auto IS NOT NULL THEN 'fresh'
                ELSE 'stale' END AS category,
           c.name AS con_name, d.name AS db_name
    FROM bl
    LEFT JOIN v$containers c ON c.con_id = bl.con_id
    CROSS JOIN v$database d
)
SELECT JSON_OBJECT(
    'id' VALUE 'stale|&gs_source|' || con_id || '|' || TO_CHAR(SYSDATE, 'YYYYMMDD') || '|'
               || RAWTOHEX(STANDARD_HASH(name || '|' || object_type, 'MD5')),
    '@timestamp' VALUE TO_CHAR(SYS_EXTRACT_UTC(SYSTIMESTAMP), '&ts_fmt'),
    'gs' VALUE JSON_OBJECT(
        'record' VALUE 'stale',
        'source' VALUE '&gs_source',
        'db' VALUE db_name,
        'con' VALUE NVL(con_name, db_name),
        'con_id' VALUE con_id,
        'owner' VALUE owner,
        'oracle_maintained' VALUE CASE WHEN om = 'Y' THEN 'true' ELSE 'false' END FORMAT JSON,
        'exported_at' VALUE TO_CHAR(SYS_EXTRACT_UTC(SYSTIMESTAMP), '&ts_fmt'),
        'obj' VALUE JSON_OBJECT(
            'name' VALUE name,
            'key' VALUE NVL(con_name, db_name) || ':' || name,
            'table' VALUE table_name,
            'partition' VALUE partition_name,
            'subpartition' VALUE subpartition_name,
            'type' VALUE LOWER(object_type),
            'category' VALUE category,
            'rows' VALUE num_rows,
            'blocks' VALUE blocks,
            'last_analyzed' VALUE TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(last_analyzed AS TIMESTAMP), '&gs_dbtz')), '&ts_fmt'),
            'stale' VALUE CASE WHEN stale_stats = 'YES' THEN 'true' ELSE 'false' END FORMAT JSON,
            'missing' VALUE CASE WHEN last_analyzed IS NULL THEN 'true' ELSE 'false' END FORMAT JSON,
            'locked' VALUE LOWER(stattype_locked),
            'inserts' VALUE inserts,
            'updates' VALUE updates,
            'deletes' VALUE deletes,
            'dml' VALUE dml,
            'truncated' VALUE CASE WHEN truncated = 'YES' THEN 'true' ELSE 'false' END FORMAT JSON,
            'dml_ts' VALUE TO_CHAR(SYS_EXTRACT_UTC(dml_tstz), '&ts_fmt'),
            'pct_changed' VALUE CASE WHEN num_rows > 0 THEN ROUND(100 * dml / num_rows, 2) END
            ABSENT ON NULL)
        ABSENT ON NULL)
    RETURNING VARCHAR2(4000))
FROM shaped
ORDER BY con_id, owner, table_name, partition_name NULLS FIRST, subpartition_name NULLS FIRST;

-- ------------------------------------------------------------- windows
WITH maint AS (
    SELECT g.con_id, g.window_name
    FROM cdb_scheduler_wingroup_members g
    WHERE g.window_group_name = 'MAINTENANCE_WINDOW_GROUP'
),
w AS (
    SELECT w.con_id, w.window_name, w.actual_start_date AS start_time,
           w.actual_start_date + w.actual_duration AS end_time,
           ROUND(EXTRACT(DAY FROM w.window_duration) * 86400 + EXTRACT(HOUR FROM w.window_duration) * 3600
               + EXTRACT(MINUTE FROM w.window_duration) * 60 + EXTRACT(SECOND FROM w.window_duration)) AS planned,
           ROUND(EXTRACT(DAY FROM w.actual_duration) * 86400 + EXTRACT(HOUR FROM w.actual_duration) * 3600
               + EXTRACT(MINUTE FROM w.actual_duration) * 60 + EXTRACT(SECOND FROM w.actual_duration)) AS actual,
           CASE WHEN EXISTS (SELECT 1 FROM maint m WHERE m.con_id = w.con_id AND m.window_name = w.window_name)
                THEN 'Y' ELSE 'N' END AS maint,
           (SELECT COUNT(*) FROM cdb_optstat_operations o
            WHERE o.con_id = w.con_id
              AND o.operation = 'gather_database_stats (auto)'
              AND o.start_time >= w.actual_start_date - NUMTODSINTERVAL(60, 'SECOND')
              AND o.start_time <= w.actual_start_date + NVL(w.actual_duration, w.window_duration)) AS runs
    FROM cdb_scheduler_window_details w
    WHERE w.actual_start_date >= &gs_cutoff
)
SELECT JSON_OBJECT(
    'id' VALUE 'win|&gs_source|' || w.con_id || '|' || w.window_name || '|' || TO_CHAR(SYS_EXTRACT_UTC(w.start_time), 'YYYYMMDDHH24MISS'),
    '@timestamp' VALUE TO_CHAR(SYS_EXTRACT_UTC(w.start_time), '&ts_fmt'),
    'gs' VALUE JSON_OBJECT(
        'record' VALUE 'window',
        'source' VALUE '&gs_source',
        'db' VALUE d.name,
        'con' VALUE NVL(c.name, d.name),
        'con_id' VALUE w.con_id,
        'oracle_maintained' VALUE 'false' FORMAT JSON,
        'exported_at' VALUE TO_CHAR(SYS_EXTRACT_UTC(SYSTIMESTAMP), '&ts_fmt'),
        'win' VALUE JSON_OBJECT(
            'name' VALUE w.window_name,
            'start' VALUE TO_CHAR(SYS_EXTRACT_UTC(w.start_time), '&ts_fmt'),
            'end' VALUE TO_CHAR(SYS_EXTRACT_UTC(w.end_time), '&ts_fmt'),
            'planned_secs' VALUE w.planned,
            'secs' VALUE w.actual,
            'maintenance' VALUE CASE WHEN w.maint = 'Y' THEN 'true' ELSE 'false' END FORMAT JSON,
            'auto_runs' VALUE w.runs,
            'has_auto_run' VALUE CASE WHEN w.runs > 0 THEN 'true' ELSE 'false' END FORMAT JSON
            ABSENT ON NULL)
        ABSENT ON NULL)
    RETURNING VARCHAR2(4000))
FROM w
LEFT JOIN v$containers c ON c.con_id = w.con_id
CROSS JOIN v$database d
ORDER BY w.start_time, w.con_id;

-- ------------------------------------------------------------- status per container
WITH last_auto AS (
    SELECT con_id, start_time, outcome_status
    FROM (
        SELECT o.con_id, o.start_time, o.status AS outcome_status,
               ROW_NUMBER() OVER (PARTITION BY o.con_id ORDER BY o.start_time DESC) AS rn
        FROM cdb_optstat_operations o
        WHERE o.operation = 'gather_database_stats (auto)')
    WHERE rn = 1
),
stale AS (
    SELECT s.con_id,
           SUM(CASE WHEN NVL(u.oracle_maintained, 'N') = 'N' AND s.stale_stats = 'YES' THEN 1 ELSE 0 END) AS app_stale,
           SUM(CASE WHEN NVL(u.oracle_maintained, 'N') = 'N' AND s.last_analyzed IS NULL THEN 1 ELSE 0 END) AS app_missing,
           SUM(CASE WHEN NVL(u.oracle_maintained, 'N') = 'N' AND s.stattype_locked IS NOT NULL THEN 1 ELSE 0 END) AS app_locked,
           SUM(CASE WHEN NVL(u.oracle_maintained, 'N') = 'Y' THEN 1 ELSE 0 END) AS om_total
    FROM cdb_tab_statistics s
    LEFT JOIN cdb_users u ON u.con_id = s.con_id AND u.username = s.owner
    WHERE (s.stale_stats = 'YES' OR s.last_analyzed IS NULL)
      AND s.table_name NOT LIKE 'BIN$%'
      AND s.object_type <> 'FIXED TABLE'
      AND NOT EXISTS (
          SELECT 1 FROM cdb_tables t
          WHERE t.con_id = s.con_id AND t.owner = s.owner AND t.table_name = s.table_name
            AND t.temporary = 'Y')
      AND NOT EXISTS (
          SELECT 1 FROM cdb_external_tables x
          WHERE x.con_id = s.con_id AND x.owner = s.owner AND x.table_name = s.table_name)
    GROUP BY s.con_id
),
cons AS (
    SELECT con_id, status FROM cdb_autotask_client
    WHERE client_name = 'auto optimizer stats collection'
)
SELECT JSON_OBJECT(
    'id' VALUE 'status|&gs_source|' || cons.con_id || '|' || TO_CHAR(SYS_EXTRACT_UTC(SYSTIMESTAMP), 'YYYYMMDDHH24'),
    '@timestamp' VALUE TO_CHAR(SYS_EXTRACT_UTC(SYSTIMESTAMP), '&ts_fmt'),
    'gs' VALUE JSON_OBJECT(
        'record' VALUE 'status',
        'source' VALUE '&gs_source',
        'db' VALUE d.name,
        'con' VALUE NVL(c.name, d.name),
        'con_id' VALUE cons.con_id,
        'oracle_maintained' VALUE 'false' FORMAT JSON,
        'exported_at' VALUE TO_CHAR(SYS_EXTRACT_UTC(SYSTIMESTAMP), '&ts_fmt'),
        'status' VALUE JSON_OBJECT(
            'task_status' VALUE cons.status,
            'last_auto_start' VALUE TO_CHAR(SYS_EXTRACT_UTC(la.start_time), '&ts_fmt'),
            'last_auto_status' VALUE la.outcome_status,
            'hours_since_last_auto' VALUE ROUND(
                (CAST(SYS_EXTRACT_UTC(SYSTIMESTAMP) AS DATE) - CAST(SYS_EXTRACT_UTC(la.start_time) AS DATE)) * 24, 1),
            'app_stale' VALUE NVL(st.app_stale, 0),
            'app_missing' VALUE NVL(st.app_missing, 0),
            'app_locked' VALUE NVL(st.app_locked, 0),
            'oracle_needing' VALUE NVL(st.om_total, 0)
            ABSENT ON NULL)
        ABSENT ON NULL)
    RETURNING VARCHAR2(4000))
FROM cons
LEFT JOIN last_auto la ON la.con_id = cons.con_id
LEFT JOIN stale st ON st.con_id = cons.con_id
LEFT JOIN v$containers c ON c.con_id = cons.con_id
CROSS JOIN v$database d
ORDER BY cons.con_id;
