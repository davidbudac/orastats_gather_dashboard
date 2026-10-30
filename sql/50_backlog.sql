--
-- 50_backlog.sql
-- What still needs statistics now: tables, partitions and subpartitions
-- whose statistics are stale or missing.  Global temporary, external and
-- recycle-bin tables are left out (the automatic job never gathers them).
--
-- STALE_STATS is computed from the DML monitoring counters as last
-- flushed to DBA_TAB_MODIFICATIONS (the automatic job flushes them when
-- it starts; otherwise they lag by up to a few minutes).  This script
-- does not flush them: it stays read-only.
--
-- D.blagg: exact counts, never truncated
--   [con_id, oracle_maintained, object_type, stale, missing, locked, objects]
-- D.bl: the objects, at most max_backlog (application objects first)
--   [con_id, owner, table, partition, subpartition, object_type, num_rows,
--    blocks, last_analyzed, stale_stats, stattype_locked, inserts, updates,
--    deletes, truncated, dml_timestamp, oracle_maintained]
-- D.tprefs: table-level preferences (DBA_TAB_STAT_PREFS)
--   [con_id, owner, table, preference, value, oracle_maintained]
--

SELECT '<script>D.blagg = [' FROM dual;
WITH src_tab_statistics AS (SELECT /*+ MATERIALIZE */ * FROM cdb_tab_statistics),
src_users AS (SELECT /*+ MATERIALIZE */ * FROM cdb_users),
src_tables AS (SELECT /*+ MATERIALIZE */ * FROM cdb_tables),
src_external_tables AS (SELECT /*+ MATERIALIZE */ * FROM cdb_external_tables)
SELECT JSON_ARRAY(
           s.con_id, NVL(u.oracle_maintained, 'N'), s.object_type,
           CASE WHEN s.stale_stats = 'YES' THEN 'Y' ELSE 'N' END,
           CASE WHEN s.last_analyzed IS NULL THEN 'Y' ELSE 'N' END,
           CASE WHEN s.stattype_locked IS NOT NULL THEN 'Y' ELSE 'N' END,
           COUNT(*)
           NULL ON NULL RETURNING VARCHAR2(4000)) || ','
FROM src_tab_statistics s
LEFT JOIN src_users u
       ON u.con_id = s.con_id AND u.username = s.owner
WHERE (:scope_schema IS NULL OR s.owner = :scope_schema)
  AND (:scope_table IS NULL OR s.table_name = :scope_table)
  AND (s.stale_stats = 'YES' OR s.last_analyzed IS NULL)
  AND s.table_name NOT LIKE 'BIN$%'
  AND NOT EXISTS (
      SELECT 1 FROM src_tables t
      WHERE t.con_id = s.con_id AND t.owner = s.owner AND t.table_name = s.table_name
        AND t.temporary = 'Y')
  AND NOT EXISTS (
      SELECT 1 FROM src_external_tables x
      WHERE x.con_id = s.con_id AND x.owner = s.owner AND x.table_name = s.table_name)
GROUP BY s.con_id, NVL(u.oracle_maintained, 'N'), s.object_type,
         CASE WHEN s.stale_stats = 'YES' THEN 'Y' ELSE 'N' END,
         CASE WHEN s.last_analyzed IS NULL THEN 'Y' ELSE 'N' END,
         CASE WHEN s.stattype_locked IS NOT NULL THEN 'Y' ELSE 'N' END
ORDER BY s.con_id, NVL(u.oracle_maintained, 'N'), s.object_type;
SELECT '];</script>' FROM dual;

SELECT '<script>D.bl = [' FROM dual;
WITH src_tab_statistics AS (SELECT /*+ MATERIALIZE */ * FROM cdb_tab_statistics),
src_users AS (SELECT /*+ MATERIALIZE */ * FROM cdb_users),
src_tab_modifications AS (SELECT /*+ MATERIALIZE */ * FROM cdb_tab_modifications),
src_tables AS (SELECT /*+ MATERIALIZE */ * FROM cdb_tables),
src_external_tables AS (SELECT /*+ MATERIALIZE */ * FROM cdb_external_tables)
SELECT REPLACE(JSON_ARRAY(
           s.con_id, s.owner, s.table_name, s.partition_name, s.subpartition_name,
           s.object_type, s.num_rows, s.blocks,
           TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(s.last_analyzed AS TIMESTAMP), '&dbtz')), '&ts_fmt'),
           s.stale_stats, s.stattype_locked,
           m.inserts, m.updates, m.deletes, m.truncated,
           TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(m.timestamp AS TIMESTAMP), '&dbtz')), '&ts_fmt'),
           NVL(u.oracle_maintained, 'N')
           NULL ON NULL RETURNING VARCHAR2(4000)), '</', '<\/') || ','
FROM src_tab_statistics s
LEFT JOIN src_users u
       ON u.con_id = s.con_id AND u.username = s.owner
LEFT JOIN src_tab_modifications m
       ON m.con_id = s.con_id
      AND m.table_owner = s.owner
      AND m.table_name = s.table_name
      AND DECODE(m.partition_name, s.partition_name, 1, 0) = 1
      AND DECODE(m.subpartition_name, s.subpartition_name, 1, 0) = 1
WHERE (:scope_schema IS NULL OR s.owner = :scope_schema)
  AND (:scope_table IS NULL OR s.table_name = :scope_table)
  AND (s.stale_stats = 'YES' OR s.last_analyzed IS NULL)
  AND s.table_name NOT LIKE 'BIN$%'
  AND NOT EXISTS (
      SELECT 1 FROM src_tables t
      WHERE t.con_id = s.con_id AND t.owner = s.owner AND t.table_name = s.table_name
        AND t.temporary = 'Y')
  AND NOT EXISTS (
      SELECT 1 FROM src_external_tables x
      WHERE x.con_id = s.con_id AND x.owner = s.owner AND x.table_name = s.table_name)
ORDER BY CASE WHEN NVL(u.oracle_maintained, 'N') = 'Y' THEN 1 ELSE 0 END,
         CASE WHEN s.object_type = 'FIXED TABLE' THEN 1 ELSE 0 END,
         s.con_id, s.owner, s.table_name, s.partition_name NULLS FIRST, s.subpartition_name NULLS FIRST
FETCH FIRST &max_backlog ROWS ONLY;
SELECT '];</script>' FROM dual;

SELECT '<script>D.tprefs = [' FROM dual;
WITH src_tab_stat_prefs AS (SELECT /*+ MATERIALIZE */ * FROM cdb_tab_stat_prefs),
src_users AS (SELECT /*+ MATERIALIZE */ * FROM cdb_users)
SELECT REPLACE(JSON_ARRAY(
           p.con_id, p.owner, p.table_name, p.preference_name, SUBSTR(p.preference_value, 1, 1000),
           NVL(u.oracle_maintained, 'N')
           NULL ON NULL RETURNING VARCHAR2(4000)), '</', '<\/') || ','
FROM src_tab_stat_prefs p
LEFT JOIN src_users u
       ON u.con_id = p.con_id AND u.username = p.owner
WHERE (:scope_schema IS NULL OR p.owner = :scope_schema)
  AND (:scope_table IS NULL OR p.table_name = :scope_table)
ORDER BY CASE WHEN NVL(u.oracle_maintained, 'N') = 'Y' THEN 1 ELSE 0 END,
         p.con_id, p.owner, p.table_name, p.preference_name
FETCH FIRST 5000 ROWS ONLY;
SELECT '];</script>' FROM dual;
