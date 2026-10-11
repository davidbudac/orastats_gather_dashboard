--
-- 30_tasks.sql
-- What each operation did, object by object (DBA_OPTSTAT_OPERATION_TASKS:
-- one row per table, partition or index a gather processed).
--
-- D.tagg: exact totals per operation, never truncated
--   [con_id, opid, target_type, status, objects, sum_target_size,
--    sum_secs, with_histograms, first_start, last_end]
-- D.tasks: per-object rows, at most max_tasks per operation (failed and
--   unfinished first, then the slowest)
--   [con_id, opid, target, target_objn, target_type, target_size, start,
--    end, status, estimated_cost, batching_coeff, actions, priority, notes]
--

SELECT '<script>D.tagg = [' FROM dual;
SELECT JSON_ARRAY(
           con_id, opid, target_type, status, COUNT(*), SUM(target_size),
           ROUND(SUM(secs), 3),
           SUM(CASE WHEN notes LIKE '%<histograms>_%' AND notes NOT LIKE '%<histograms></histograms>%'
                    THEN 1 ELSE 0 END),
           TO_CHAR(SYS_EXTRACT_UTC(MIN(start_time)), '&ts_fmt'),
           TO_CHAR(SYS_EXTRACT_UTC(MAX(end_time)), '&ts_fmt')
           NULL ON NULL RETURNING VARCHAR2(4000)) || ','
FROM (
    SELECT t.con_id, t.opid, t.target_type, t.status, t.target_size, t.notes,
           t.start_time, t.end_time,
           EXTRACT(DAY FROM (t.end_time - t.start_time)) * 86400
             + EXTRACT(HOUR FROM (t.end_time - t.start_time)) * 3600
             + EXTRACT(MINUTE FROM (t.end_time - t.start_time)) * 60
             + EXTRACT(SECOND FROM (t.end_time - t.start_time)) AS secs
    FROM cdb_optstat_operation_tasks t
    WHERE (t.con_id, t.opid) IN (
        SELECT o.con_id, o.id FROM cdb_optstat_operations o WHERE o.start_time >= &cutoff)
)
GROUP BY con_id, opid, target_type, status
ORDER BY con_id, opid, target_type, status;
SELECT '];</script>' FROM dual;

SELECT '<script>D.tasks = [' FROM dual;
SELECT REPLACE(JSON_ARRAY(
           con_id, opid, target, target_objn, target_type, target_size,
           TO_CHAR(SYS_EXTRACT_UTC(start_time), '&ts_fmt'),
           TO_CHAR(SYS_EXTRACT_UTC(end_time), '&ts_fmt'),
           status, estimated_cost, batching_coeff, actions, priority,
           SUBSTR(NULLIF(notes, '<notes><histograms></histograms><xstats></xstats></notes>'), 1, 2000)
           NULL ON NULL RETURNING VARCHAR2(4000)), '</', '<\/') || ','
FROM (
    SELECT t.*,
           ROW_NUMBER() OVER (
               PARTITION BY t.con_id, t.opid
               ORDER BY CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END,
                        t.end_time - t.start_time DESC NULLS LAST,
                        t.start_time) AS rn
    FROM cdb_optstat_operation_tasks t
    WHERE (t.con_id, t.opid) IN (
        SELECT o.con_id, o.id FROM cdb_optstat_operations o WHERE o.start_time >= &cutoff)
)
WHERE rn <= &max_tasks
ORDER BY con_id, opid, start_time NULLS LAST;
SELECT '];</script>' FROM dual;
