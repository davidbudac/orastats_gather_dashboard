--
-- 70_tables.sql
-- The tables worth looking at one by one: everything a gather touched in
-- the period, every table with a table-level preference, and every
-- partitioned table.  The page's Table view puts the gathers of one table
-- on a timeline and checks its incremental-statistics setup against them.
--
-- Each CDB_ view is read once into a MATERIALIZE'd WITH clause (see
-- 60_columns.sql for why).
--
-- D.tabs: at most max_backlog tables (application schemas first)
--   [con_id, owner, table, partitioning_type, subpartitioning_type,
--    partitions, interval, num_rows, blocks, last_analyzed, stale_stats,
--    locked, oracle_maintained, partitions_stale, partitions_without_stats,
--    partitions_newest_analyzed, partitions_oldest_analyzed]
--   partitions counts the partitions that have a row in CDB_TAB_STATISTICS.
--   interval is Y when CDB_PART_TABLES reports the 1048575 of an
--   interval-partitioned table.
-- D.idx: indexes a gather touched in the period, with their table, so the
--   page can show them under the table.  At most 20000.
--   [con_id, owner, index_name, table_owner, table_name]
-- D.syn: incremental statistics synopses per table (SYS.WRI$_OPTSTAT_
--   SYNOPSIS_HEAD$; needs SELECT on it, else this dataset is not collected).
--   A partition has a synopsis only when it was gathered with
--   INCREMENTAL=TRUE and AUTO_SAMPLE_SIZE: this is the proof that
--   incremental statistics are in use.
--   [con_id, owner, table, partitions_with_synopsis, newest, oldest]
--

SELECT '<script>D.tabs = [' FROM dual;
@@_scope.sql
, g AS (
    SELECT /*+ MATERIALIZE */ DISTINCT t.con_id,
           REGEXP_SUBSTR(t.target, '"([^"]+)"', 1, 1, NULL, 1) owner,
           REGEXP_SUBSTR(t.target, '"([^"]+)"', 1, 2, NULL, 1) table_name
    FROM scope_tasks t
    WHERE t.target_type LIKE 'TABLE%'
      AND (t.con_id, t.opid) IN (
          SELECT o.con_id, o.id FROM scope_ops o WHERE o.start_time >= &cutoff)
), pr AS (
    SELECT /*+ MATERIALIZE */ DISTINCT con_id, owner, table_name FROM cdb_tab_stat_prefs
), p AS (
    SELECT /*+ MATERIALIZE */ con_id, owner, table_name, partitioning_type, subpartitioning_type, partition_count
    FROM cdb_part_tables
), s AS (
    SELECT /*+ MATERIALIZE */ con_id, owner, table_name, num_rows, blocks, last_analyzed, stale_stats, stattype_locked
    FROM cdb_tab_statistics
    WHERE object_type = 'TABLE'
), ps AS (
    SELECT /*+ MATERIALIZE */ con_id, owner, table_name, COUNT(*) parts,
           SUM(CASE WHEN stale_stats = 'YES' THEN 1 ELSE 0 END) stale,
           SUM(CASE WHEN last_analyzed IS NULL THEN 1 ELSE 0 END) nostats,
           MAX(last_analyzed) newest, MIN(last_analyzed) oldest
    FROM cdb_tab_statistics
    WHERE object_type = 'PARTITION'
    GROUP BY con_id, owner, table_name
), u AS (
    SELECT /*+ MATERIALIZE */ con_id, username, oracle_maintained FROM cdb_users
), a AS (
    SELECT con_id, owner, table_name FROM g
    UNION
    SELECT con_id, owner, table_name FROM pr
    UNION
    SELECT con_id, owner, table_name FROM p
    UNION
    SELECT con_id, owner, table_name FROM s
    WHERE :scope_table IS NOT NULL AND owner = :scope_schema AND table_name = :scope_table
)
SELECT REPLACE(JSON_ARRAY(
           a.con_id, a.owner, a.table_name, p.partitioning_type, p.subpartitioning_type,
           ps.parts, CASE WHEN p.partition_count = 1048575 THEN 'Y' ELSE 'N' END,
           s.num_rows, s.blocks,
           TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(s.last_analyzed AS TIMESTAMP), '&dbtz')), '&ts_fmt'),
           s.stale_stats, s.stattype_locked, NVL(u.oracle_maintained, 'N'),
           ps.stale, ps.nostats,
           TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(ps.newest AS TIMESTAMP), '&dbtz')), '&ts_fmt'),
           TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(ps.oldest AS TIMESTAMP), '&dbtz')), '&ts_fmt')
           NULL ON NULL RETURNING VARCHAR2(4000)), '</', '<\/') || ','
FROM a
LEFT JOIN p  ON p.con_id = a.con_id AND p.owner = a.owner AND p.table_name = a.table_name
LEFT JOIN s  ON s.con_id = a.con_id AND s.owner = a.owner AND s.table_name = a.table_name
LEFT JOIN ps ON ps.con_id = a.con_id AND ps.owner = a.owner AND ps.table_name = a.table_name
LEFT JOIN u  ON u.con_id = a.con_id AND u.username = a.owner
WHERE (:scope_schema IS NULL OR a.owner = :scope_schema)
  AND (:scope_table IS NULL OR a.table_name = :scope_table)
  AND a.table_name NOT LIKE 'BIN$%'
ORDER BY CASE WHEN NVL(u.oracle_maintained, 'N') = 'Y' THEN 1 ELSE 0 END,
         a.con_id, a.owner, a.table_name
FETCH FIRST &max_backlog ROWS ONLY;
SELECT '];</script>' FROM dual;

SELECT '<script>D.idx = [' FROM dual;
@@_scope.sql
, g AS (
    SELECT /*+ MATERIALIZE */ DISTINCT t.con_id,
           REGEXP_SUBSTR(t.target, '"([^"]+)"', 1, 1, NULL, 1) owner,
           REGEXP_SUBSTR(t.target, '"([^"]+)"', 1, 2, NULL, 1) index_name
    FROM scope_tasks t
    WHERE t.target_type LIKE 'INDEX%'
      AND (t.con_id, t.opid) IN (
          SELECT o.con_id, o.id FROM scope_ops o WHERE o.start_time >= &cutoff)
), i AS (
    SELECT /*+ MATERIALIZE */ con_id, owner, index_name, table_owner, table_name FROM cdb_indexes
), u AS (
    SELECT /*+ MATERIALIZE */ con_id, username, oracle_maintained FROM cdb_users
)
SELECT REPLACE(JSON_ARRAY(
           g.con_id, g.owner, g.index_name, i.table_owner, i.table_name
           NULL ON NULL RETURNING VARCHAR2(4000)), '</', '<\/') || ','
FROM g
JOIN i ON i.con_id = g.con_id AND i.owner = g.owner AND i.index_name = g.index_name
LEFT JOIN u ON u.con_id = g.con_id AND u.username = g.owner
WHERE (:scope_schema IS NULL OR i.table_owner = :scope_schema)
  AND (:scope_table IS NULL OR i.table_name = :scope_table)
ORDER BY CASE WHEN NVL(u.oracle_maintained, 'N') = 'Y' THEN 1 ELSE 0 END,
         g.con_id, g.owner, g.index_name
FETCH FIRST 20000 ROWS ONLY;
SELECT '];</script>' FROM dual;

SELECT '<script>D.syn = [' FROM dual;
WITH syn AS (
    SELECT /*+ MATERIALIZE */ con_id, bo#, COUNT(DISTINCT group#) parts,
           MAX(analyzetime) newest, MIN(analyzetime) oldest
    FROM CONTAINERS(sys.wri$_optstat_synopsis_head$)
    GROUP BY con_id, bo#
), o AS (
    SELECT /*+ MATERIALIZE */ con_id, object_id, owner, object_name
    FROM cdb_objects
    WHERE object_type = 'TABLE'
)
SELECT REPLACE(JSON_ARRAY(
           syn.con_id, o.owner, o.object_name, syn.parts,
           TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(syn.newest AS TIMESTAMP), '&dbtz')), '&ts_fmt'),
           TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(syn.oldest AS TIMESTAMP), '&dbtz')), '&ts_fmt')
           NULL ON NULL RETURNING VARCHAR2(4000)), '</', '<\/') || ','
FROM syn
JOIN o ON o.con_id = syn.con_id AND o.object_id = syn.bo#
WHERE (:scope_schema IS NULL OR o.owner = :scope_schema)
  AND (:scope_table IS NULL OR o.object_name = :scope_table)
ORDER BY syn.con_id, o.owner, o.object_name;
SELECT '];</script>' FROM dual;
