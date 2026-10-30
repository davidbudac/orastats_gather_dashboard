--
-- gather_dashboard.sql
-- Statistics-gathering dashboard for Oracle Database 19c.
--
-- Writes one self-contained HTML file: an overview of every DBMS_STATS
-- gather operation (the automatic job and manual/custom gathers), a
-- drill-down per run (each object it touched, how long it took, what
-- failed), the objects that still need statistics now, and column
-- statistics and histograms that cannot be trusted.
--
-- Read-only: every statement is a SELECT (plus PL/SQL that only prints).
-- Uses the CDB_* views, so it covers every open container when run in
-- CDB$ROOT as a common user, one PDB when run inside that PDB, and the
-- whole database on a non-CDB.
--
-- Usage (all arguments optional, positional):
--   SQL> @gather_dashboard.sql [days] [max_tasks_per_run] [max_backlog] [output_file]
--
--   days               history to show, default 31 (stats history retention
--                      is 31 days by default; older runs are already purged)
--   max_tasks_per_run  per-object rows embedded per run, default 2000
--                      (failed first, then slowest; the per-run totals
--                      are always exact)
--   max_backlog        objects still needing statistics embedded, default 5000;
--                      also caps the columns with doubtful statistics
--   output_file        default gather_dashboard_<db>_<container>_<yyyymmdd_hh24mi>.html
--

SET TERMOUT OFF
SET ECHO OFF
SET VERIFY OFF
SET FEEDBACK OFF
SET HEADING OFF
SET PAGESIZE 0
SET LINESIZE 32767
SET TRIMSPOOL ON
SET TRIMOUT ON
SET TAB OFF
SET SQLBLANKLINES ON
SET DEFINE ON
SET SERVEROUTPUT ON SIZE UNLIMITED FORMAT WRAPPED
WHENEVER SQLERROR CONTINUE
WHENEVER OSERROR CONTINUE

-- Optional positional arguments: define them as empty when not passed,
-- so SQL*Plus does not prompt for them.
COLUMN 1 NEW_VALUE 1
COLUMN 2 NEW_VALUE 2
COLUMN 3 NEW_VALUE 3
COLUMN 4 NEW_VALUE 4
SELECT '' "1", '' "2", '' "3", '' "4" FROM dual WHERE ROWNUM = 0;

COLUMN p_days        NEW_VALUE days        NOPRINT
COLUMN p_max_tasks   NEW_VALUE max_tasks   NOPRINT
COLUMN p_max_backlog NEW_VALUE max_backlog NOPRINT
COLUMN p_dbtz        NEW_VALUE dbtz        NOPRINT
COLUMN p_out         NEW_VALUE out_file    NOPRINT
SELECT TO_NUMBER(NVL('&1', '31'))   p_days,
       TO_NUMBER(NVL('&2', '2000')) p_max_tasks,
       TO_NUMBER(NVL('&3', '5000')) p_max_backlog,
       TO_CHAR(SYSTIMESTAMP, 'TZH:TZM') p_dbtz,
       NVL('&4', 'gather_dashboard_'
                 || LOWER(SYS_CONTEXT('USERENV', 'DB_NAME')) || '_'
                 || LOWER(REPLACE(SYS_CONTEXT('USERENV', 'CON_NAME'), '$', ''))
                 || '_' || TO_CHAR(SYSDATE, 'YYYYMMDD_HH24MI') || '.html') p_out
FROM dual;

-- Every timestamp goes into the page as UTC ISO-8601; the page converts
-- it to the time zone picked in its header.  DATE columns (LAST_ANALYZED,
-- LOG_DATE, ...) are in the database host's time zone, taken as &dbtz.
DEFINE ts_fmt = 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'
DEFINE cutoff = "SYSTIMESTAMP - NUMTODSINTERVAL(&days, 'DAY')"

SPOOL &out_file

@@sql/00_head.sql
@@sql/10_meta.sql
@@sql/20_operations.sql
@@sql/30_tasks.sql
@@sql/40_jobs_windows.sql
@@sql/50_backlog.sql
@@sql/60_columns.sql
@@sql/70_tables.sql
@@sql/90_app.sql

SPOOL OFF
SET TERMOUT ON
PROMPT Report written to &out_file
