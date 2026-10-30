--
-- 40_jobs_windows.sql
-- The scheduler's side of each run: the automatic task's job history
-- (which window, how long the job ran, how it ended), the scheduler run
-- details of every job that performed a DBMS_STATS operation (CPU used,
-- errors) and the maintenance window history.
--

-- D.ajh: automatic statistics task jobs
--   [con_id, window_name, window_start, window_secs, job_name, job_status,
--    job_start, job_secs, job_error, job_info]
SELECT '<script>D.ajh = [' FROM dual;
@@_scope.sql
, jobs AS (SELECT /*+ MATERIALIZE */ * FROM cdb_autotask_job_history)
SELECT REPLACE(JSON_ARRAY(
           h.con_id, h.window_name,
           TO_CHAR(SYS_EXTRACT_UTC(h.window_start_time), '&ts_fmt'),
           ROUND(EXTRACT(DAY FROM h.window_duration) * 86400 + EXTRACT(HOUR FROM h.window_duration) * 3600
               + EXTRACT(MINUTE FROM h.window_duration) * 60 + EXTRACT(SECOND FROM h.window_duration)),
           h.job_name, h.job_status,
           TO_CHAR(SYS_EXTRACT_UTC(h.job_start_time), '&ts_fmt'),
           EXTRACT(DAY FROM h.job_duration) * 86400 + EXTRACT(HOUR FROM h.job_duration) * 3600
               + EXTRACT(MINUTE FROM h.job_duration) * 60 + EXTRACT(SECOND FROM h.job_duration),
           h.job_error, SUBSTR(h.job_info, 1, 1000)
           NULL ON NULL RETURNING VARCHAR2(4000)), '</', '<\/') || ','
FROM jobs h
WHERE h.client_name = 'auto optimizer stats collection'
  AND h.job_start_time >= &cutoff
  AND (:scope_schema IS NULL OR EXISTS (
      SELECT 1 FROM scope_ops o WHERE o.con_id = h.con_id
        AND o.job_name = h.job_name
        AND o.start_time >= h.job_start_time
        AND o.start_time <= h.job_start_time + h.job_duration))
ORDER BY h.job_start_time;
SELECT '];</script>' FROM dual;

-- D.sjr: scheduler run details of jobs that ran DBMS_STATS operations
--   [con_id, log_id, owner, job_name, status, error, start, run_secs,
--    cpu_secs, session_id, additional_info]
SELECT '<script>D.sjr = [' FROM dual;
@@_scope.sql
, runs AS (SELECT /*+ MATERIALIZE */ * FROM cdb_scheduler_job_run_details)
SELECT REPLACE(JSON_ARRAY(
           r.con_id, r.log_id, r.owner, r.job_name, r.status, r.error#,
           TO_CHAR(SYS_EXTRACT_UTC(r.actual_start_date), '&ts_fmt'),
           EXTRACT(DAY FROM r.run_duration) * 86400 + EXTRACT(HOUR FROM r.run_duration) * 3600
               + EXTRACT(MINUTE FROM r.run_duration) * 60 + EXTRACT(SECOND FROM r.run_duration),
           ROUND(EXTRACT(DAY FROM r.cpu_used) * 86400 + EXTRACT(HOUR FROM r.cpu_used) * 3600
               + EXTRACT(MINUTE FROM r.cpu_used) * 60 + EXTRACT(SECOND FROM r.cpu_used), 2),
           r.session_id, SUBSTR(r.additional_info, 1, 1000)
           NULL ON NULL RETURNING VARCHAR2(4000)), '</', '<\/') || ','
FROM runs r
WHERE r.log_date >= &cutoff
  AND EXISTS (
      SELECT 1 FROM scope_ops o
      WHERE o.con_id = r.con_id
        AND o.job_name IN (r.job_name, r.owner || '.' || r.job_name,
                          '"' || r.owner || '"."' || r.job_name || '"')
        AND (:scope_schema IS NULL OR (
            o.start_time >= r.actual_start_date
            AND o.start_time <= r.actual_start_date + r.run_duration)))
ORDER BY r.actual_start_date;
SELECT '];</script>' FROM dual;

-- D.win: scheduler window history
--   [con_id, window_name, req_start, actual_start, planned_secs, actual_secs]
SELECT '<script>D.win = [' FROM dual;
@@_scope.sql
, windows AS (SELECT /*+ MATERIALIZE */ * FROM cdb_scheduler_window_details)
SELECT JSON_ARRAY(
           w.con_id, w.window_name,
           TO_CHAR(SYS_EXTRACT_UTC(w.req_start_date), '&ts_fmt'),
           TO_CHAR(SYS_EXTRACT_UTC(w.actual_start_date), '&ts_fmt'),
           ROUND(EXTRACT(DAY FROM w.window_duration) * 86400 + EXTRACT(HOUR FROM w.window_duration) * 3600
               + EXTRACT(MINUTE FROM w.window_duration) * 60 + EXTRACT(SECOND FROM w.window_duration)),
           ROUND(EXTRACT(DAY FROM w.actual_duration) * 86400 + EXTRACT(HOUR FROM w.actual_duration) * 3600
               + EXTRACT(MINUTE FROM w.actual_duration) * 60 + EXTRACT(SECOND FROM w.actual_duration))
           NULL ON NULL RETURNING VARCHAR2(4000)) || ','
FROM windows w
WHERE w.actual_start_date >= &cutoff - NUMTODSINTERVAL(1, 'DAY')
  AND (:scope_schema IS NULL OR EXISTS (
      SELECT 1 FROM scope_ops o WHERE o.con_id = w.con_id
        AND o.start_time >= w.actual_start_date
        AND o.start_time <= w.actual_start_date + w.actual_duration))
ORDER BY w.actual_start_date;
SELECT '];</script>' FROM dual;
