--
-- 20_operations.sql
-- Every DBMS_STATS operation in the reporting period: the automatic job
-- runs ("gather_database_stats (auto)"), manual and custom gathers, and
-- the rest (set/lock/delete/restore/purge ...) for context.
--
-- D.ops: [con_id, id, operation, target, start, end, status, job_name,
--         session_id, notes]
-- NOTES holds the call's parameters as <params><param name= val=/>...
-- and an <error> element when it failed; the page parses it.
--

SELECT '<script>D.ops = [' FROM dual;
@@_scope.sql
SELECT REPLACE(JSON_ARRAY(
           o.con_id, o.id, o.operation, o.target,
           TO_CHAR(SYS_EXTRACT_UTC(o.start_time), '&ts_fmt'),
           TO_CHAR(SYS_EXTRACT_UTC(o.end_time), '&ts_fmt'),
           o.status, o.job_name, o.session_id,
           SUBSTR(o.notes, 1, 2500)
           NULL ON NULL RETURNING VARCHAR2(4000)), '</', '<\/') || ','
FROM scope_ops o
WHERE o.start_time >= &cutoff
ORDER BY o.start_time, o.con_id, o.id;
SELECT '];</script>' FROM dual;
