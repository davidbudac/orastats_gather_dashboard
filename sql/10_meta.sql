--
-- 10_meta.sql
-- Report header facts, containers, the Oracle-maintained schemas, the
-- global DBMS_STATS preferences of the current container, the automatic
-- statistics task's status per container and the scheduler windows it runs in.
--

-- D.meta: one object
SELECT '<script>D.meta = ' || JSON_OBJECT(
           'db'           VALUE d.name,
           'dbUnique'     VALUE d.db_unique_name,
           'cdb'          VALUE d.cdb,
           'role'         VALUE d.database_role,
           'openMode'     VALUE d.open_mode,
           'con'          VALUE SYS_CONTEXT('USERENV', 'CON_NAME'),
           'conId'        VALUE TO_NUMBER(SYS_CONTEXT('USERENV', 'CON_ID')),
           'host'         VALUE i.host_name,
           'instance'     VALUE i.instance_name,
           'version'      VALUE i.version_full,
           'user'         VALUE USER,
           'dbtz'         VALUE '&dbtz',
           'generated'    VALUE TO_CHAR(SYS_EXTRACT_UTC(SYSTIMESTAMP), '&ts_fmt'),
           'days'         VALUE &days,
           'maxTasks'     VALUE &max_tasks,
           'maxBacklog'   VALUE &max_backlog,
           'retention'    VALUE DBMS_STATS.GET_STATS_HISTORY_RETENTION,
           'availability' VALUE TO_CHAR(SYS_EXTRACT_UTC(DBMS_STATS.GET_STATS_HISTORY_AVAILABILITY), '&ts_fmt'),
           'tool'         VALUE '1.0'
           NULL ON NULL RETURNING VARCHAR2(4000)) || ';</script>'
FROM v$database d, v$instance i;

-- D.cons: [con_id, name]
SELECT '<script>D.cons = [' FROM dual;
SELECT JSON_ARRAY(con_id, name NULL ON NULL) || ','
FROM v$containers
ORDER BY con_id;
SELECT '];</script>' FROM dual;

-- D.omu: Oracle-maintained schemas [con_id, username], so the page can
-- separate application work from Oracle's own
SELECT '<script>D.omu = [' FROM dual;
SELECT JSON_ARRAY(u.con_id, u.username NULL ON NULL RETURNING VARCHAR2(4000)) || ','
FROM cdb_users u
WHERE u.oracle_maintained = 'Y'
ORDER BY u.con_id, u.username;
SELECT '];</script>' FROM dual;

-- D.prefs: [name, value] global preferences of the current container.
-- GET_PREFS raises for a name this release does not know: print n/a.
BEGIN
    DBMS_OUTPUT.PUT_LINE('<script>D.prefs = [');
    FOR p IN (
        SELECT column_value AS name
        FROM TABLE(sys.odcivarchar2list(
            'AUTOSTATS_TARGET', 'CONCURRENT', 'DEGREE', 'ESTIMATE_PERCENT',
            'METHOD_OPT', 'GRANULARITY', 'CASCADE', 'NO_INVALIDATE',
            'STALE_PERCENT', 'INCREMENTAL', 'INCREMENTAL_STALENESS',
            'PUBLISH', 'OPTIONS', 'APPROXIMATE_NDV_ALGORITHM',
            'AUTO_STAT_EXTENSIONS', 'PREFERENCE_OVERRIDES_PARAMETER',
            'AUTO_TASK_STATUS', 'AUTO_TASK_MAX_RUN_TIME', 'AUTO_TASK_INTERVAL'))
    ) LOOP
        DECLARE
            v VARCHAR2(4000);
        BEGIN
            BEGIN
                v := DBMS_STATS.GET_PREFS(p.name);
            EXCEPTION WHEN OTHERS THEN
                v := 'n/a';
            END;
            DBMS_OUTPUT.PUT_LINE('["' || p.name || '","'
                || REPLACE(REPLACE(REPLACE(v, '\', '\\'), '"', '\"'), '</', '<\/')
                || '"],');
        END;
    END LOOP;
    DBMS_OUTPUT.PUT_LINE('];</script>');
END;
/

-- D.atc: automatic statistics task per container
--   [con_id, status, window_group, mean_job_secs, max_7d_secs, attributes]
SELECT '<script>D.atc = [' FROM dual;
SELECT JSON_ARRAY(
           c.con_id, c.status, c.window_group,
           ROUND(EXTRACT(DAY FROM c.mean_job_duration) * 86400 + EXTRACT(HOUR FROM c.mean_job_duration) * 3600
               + EXTRACT(MINUTE FROM c.mean_job_duration) * 60 + EXTRACT(SECOND FROM c.mean_job_duration), 1),
           ROUND(EXTRACT(DAY FROM c.max_duration_last_7_days) * 86400 + EXTRACT(HOUR FROM c.max_duration_last_7_days) * 3600
               + EXTRACT(MINUTE FROM c.max_duration_last_7_days) * 60 + EXTRACT(SECOND FROM c.max_duration_last_7_days), 1),
           c.attributes
           NULL ON NULL RETURNING VARCHAR2(4000)) || ','
FROM cdb_autotask_client c
WHERE c.client_name = 'auto optimizer stats collection'
ORDER BY c.con_id;
SELECT '];</script>' FROM dual;

-- D.wcfg: scheduler windows
--   [con_id, window_name, enabled, active, repeat_interval, duration_secs,
--    next_start, last_start, in_maintenance_group]
SELECT '<script>D.wcfg = [' FROM dual;
SELECT REPLACE(JSON_ARRAY(
           w.con_id, w.window_name, w.enabled, w.active, w.repeat_interval,
           EXTRACT(DAY FROM w.duration) * 86400 + EXTRACT(HOUR FROM w.duration) * 3600
               + EXTRACT(MINUTE FROM w.duration) * 60 + EXTRACT(SECOND FROM w.duration),
           TO_CHAR(SYS_EXTRACT_UTC(w.next_start_date), '&ts_fmt'),
           TO_CHAR(SYS_EXTRACT_UTC(w.last_start_date), '&ts_fmt'),
           CASE WHEN EXISTS (
               SELECT 1 FROM cdb_scheduler_wingroup_members g
               WHERE g.con_id = w.con_id
                 AND g.window_group_name = 'MAINTENANCE_WINDOW_GROUP'
                 AND g.window_name = w.window_name) THEN 'Y' ELSE 'N' END
           NULL ON NULL RETURNING VARCHAR2(4000)), '</', '<\/') || ','
FROM cdb_scheduler_windows w
ORDER BY w.con_id, w.next_start_date NULLS LAST, w.window_name;
SELECT '];</script>' FROM dual;
