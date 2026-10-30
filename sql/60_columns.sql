--
-- 60_columns.sql
-- Below the table level: column statistics that lag behind their table,
-- histograms that cannot describe their column, and what the DML
-- monitoring counters can and cannot tell yet.
--
-- Only table-level column statistics (CDB_TAB_COLS); partition-level
-- column statistics are not checked.  Tables without statistics are left
-- out here: 50_backlog.sql already lists them.  Global temporary, external
-- and recycle-bin tables are left out as there.
--
-- Each CDB_ view is read once into a MATERIALIZE'd WITH clause and the
-- joins run on those.  Joined directly, the CDB_ views made the optimizer
-- re-run the cross-container scans per row: minutes instead of seconds.
--
-- Reasons, one per column, first match wins:
--   nostats   a scalar column without statistics on an analyzed table
--             (typically added after the last gather).  LONG, LONG RAW,
--             UROWID and object-typed columns are never analyzed: skipped.
--   older     its statistics are over an hour older than the table's: the
--             last gather left this column out (METHOD_OPT).
--   legacyhb  HEIGHT BALANCED histogram.  19c builds frequency, top-
--             frequency or hybrid histograms with AUTO_SAMPLE_SIZE; height-
--             balanced means a fixed ESTIMATE_PERCENT was used.
--   small     hybrid or top-frequency histogram with fewer than half the
--             buckets it could have (LEAST(254, NDV)): an explicit small
--             SIZE in METHOD_OPT.
--   freqgap   frequency histogram with fewer buckets than distinct values:
--             values missing from it (sampled) or sharing an endpoint (long
--             strings that start alike).
--
-- D.colagg: exact counts, never truncated
--   [con_id, oracle_maintained, reason, columns, tables]
-- D.cols: the columns, at most max_backlog (application schemas first)
--   [con_id, owner, table, column, data_type, reason, histogram,
--    num_distinct, num_buckets, num_nulls, sample_size, col_analyzed,
--    table_analyzed, table_num_rows, oracle_maintained]
-- D.mon: DML monitoring per container
--   [con_id, modification_rows, newest_modification, statistics_level]
--   statistics_level is that of the current container.  DML since the
--   newest row is still in memory: not visible until the next flush.
-- D.near: not stale yet, but at least half of STALE_PERCENT changed by the
--   flushed counters alone; DML still in memory may already have pushed
--   them over.  At most 2000 (application schemas first).
--   [con_id, owner, table, partition, subpartition, object_type, num_rows,
--    last_analyzed, inserts, updates, deletes, dml_timestamp,
--    stale_percent, oracle_maintained]
--   stale_percent is the table preference, else the global one of the
--   current container.
--

SELECT '<script>D.colagg = [' FROM dual;
WITH t AS (
    SELECT /*+ MATERIALIZE */ con_id, owner, table_name, last_analyzed, num_rows
    FROM cdb_tables
    WHERE (:scope_schema IS NULL OR owner = :scope_schema)
      AND (:scope_table IS NULL OR table_name = :scope_table)
      AND last_analyzed IS NOT NULL AND temporary = 'N' AND external = 'NO'
      AND dropped = 'NO' AND table_name NOT LIKE 'BIN$%'
), k AS (
    SELECT /*+ MATERIALIZE */ con_id, owner, table_name, column_name, data_type, histogram,
           num_distinct, num_buckets, num_nulls, sample_size, last_analyzed
    FROM cdb_tab_cols
    WHERE last_analyzed IS NOT NULL
       OR (user_generated = 'YES' AND data_type_owner IS NULL
           AND data_type NOT IN ('LONG', 'LONG RAW', 'UROWID', 'UNDEFINED'))
), u AS (
    SELECT /*+ MATERIALIZE */ con_id, username, oracle_maintained FROM cdb_users
), c AS (
    SELECT k.con_id, k.owner, k.table_name,
           CASE WHEN k.last_analyzed IS NULL THEN 'nostats'
                WHEN k.last_analyzed < t.last_analyzed - 1/24 THEN 'older'
                WHEN k.histogram = 'HEIGHT BALANCED' THEN 'legacyhb'
                WHEN k.histogram IN ('HYBRID', 'TOP-FREQUENCY')
                 AND k.num_buckets < 0.5 * LEAST(254, k.num_distinct) THEN 'small'
                WHEN k.histogram = 'FREQUENCY' AND k.num_buckets < k.num_distinct THEN 'freqgap'
           END reason
    FROM t
    JOIN k ON k.con_id = t.con_id AND k.owner = t.owner AND k.table_name = t.table_name
)
SELECT JSON_ARRAY(
           c.con_id, NVL(u.oracle_maintained, 'N'), c.reason, COUNT(*),
           COUNT(DISTINCT c.owner || '.' || c.table_name)
           NULL ON NULL RETURNING VARCHAR2(4000)) || ','
FROM c
LEFT JOIN u ON u.con_id = c.con_id AND u.username = c.owner
WHERE (:scope_schema IS NULL OR c.owner = :scope_schema)
  AND (:scope_table IS NULL OR c.table_name = :scope_table)
  AND c.reason IS NOT NULL
GROUP BY c.con_id, NVL(u.oracle_maintained, 'N'), c.reason
ORDER BY c.con_id, NVL(u.oracle_maintained, 'N'), c.reason;
SELECT '];</script>' FROM dual;

SELECT '<script>D.cols = [' FROM dual;
WITH t AS (
    SELECT /*+ MATERIALIZE */ con_id, owner, table_name, last_analyzed, num_rows
    FROM cdb_tables
    WHERE (:scope_schema IS NULL OR owner = :scope_schema)
      AND (:scope_table IS NULL OR table_name = :scope_table)
      AND last_analyzed IS NOT NULL AND temporary = 'N' AND external = 'NO'
      AND dropped = 'NO' AND table_name NOT LIKE 'BIN$%'
), k AS (
    SELECT /*+ MATERIALIZE */ con_id, owner, table_name, column_name, data_type, histogram,
           num_distinct, num_buckets, num_nulls, sample_size, last_analyzed
    FROM cdb_tab_cols
    WHERE last_analyzed IS NOT NULL
       OR (user_generated = 'YES' AND data_type_owner IS NULL
           AND data_type NOT IN ('LONG', 'LONG RAW', 'UROWID', 'UNDEFINED'))
), u AS (
    SELECT /*+ MATERIALIZE */ con_id, username, oracle_maintained FROM cdb_users
), c AS (
    SELECT k.*, t.last_analyzed tab_analyzed, t.num_rows,
           CASE WHEN k.last_analyzed IS NULL THEN 'nostats'
                WHEN k.last_analyzed < t.last_analyzed - 1/24 THEN 'older'
                WHEN k.histogram = 'HEIGHT BALANCED' THEN 'legacyhb'
                WHEN k.histogram IN ('HYBRID', 'TOP-FREQUENCY')
                 AND k.num_buckets < 0.5 * LEAST(254, k.num_distinct) THEN 'small'
                WHEN k.histogram = 'FREQUENCY' AND k.num_buckets < k.num_distinct THEN 'freqgap'
           END reason
    FROM t
    JOIN k ON k.con_id = t.con_id AND k.owner = t.owner AND k.table_name = t.table_name
)
SELECT REPLACE(JSON_ARRAY(
           c.con_id, c.owner, c.table_name, c.column_name, c.data_type, c.reason,
           c.histogram, c.num_distinct, c.num_buckets, c.num_nulls, c.sample_size,
           TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(c.last_analyzed AS TIMESTAMP), '&dbtz')), '&ts_fmt'),
           TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(c.tab_analyzed AS TIMESTAMP), '&dbtz')), '&ts_fmt'),
           c.num_rows, NVL(u.oracle_maintained, 'N')
           NULL ON NULL RETURNING VARCHAR2(4000)), '</', '<\/') || ','
FROM c
LEFT JOIN u ON u.con_id = c.con_id AND u.username = c.owner
WHERE (:scope_schema IS NULL OR c.owner = :scope_schema)
  AND (:scope_table IS NULL OR c.table_name = :scope_table)
  AND c.reason IS NOT NULL
ORDER BY CASE WHEN NVL(u.oracle_maintained, 'N') = 'Y' THEN 1 ELSE 0 END,
         c.con_id, c.owner, c.table_name, c.column_name
FETCH FIRST &max_backlog ROWS ONLY;
SELECT '];</script>' FROM dual;

SELECT '<script>D.mon = [' FROM dual;
SELECT JSON_ARRAY(
           m.con_id, m.n,
           TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(m.newest AS TIMESTAMP), '&dbtz')), '&ts_fmt'),
           (SELECT p.value FROM v$parameter p WHERE p.name = 'statistics_level')
           NULL ON NULL RETURNING VARCHAR2(4000)) || ','
FROM (SELECT con_id, COUNT(*) n, MAX(timestamp) newest
      FROM cdb_tab_modifications
      WHERE (:scope_schema IS NULL OR table_owner = :scope_schema)
        AND (:scope_table IS NULL OR table_name = :scope_table)
      GROUP BY con_id) m
ORDER BY m.con_id;
SELECT '];</script>' FROM dual;

SELECT '<script>D.near = [' FROM dual;
WITH s AS (
    SELECT /*+ MATERIALIZE */ con_id, owner, table_name, partition_name, subpartition_name,
           object_type, num_rows, last_analyzed
    FROM cdb_tab_statistics
    WHERE (:scope_schema IS NULL OR owner = :scope_schema)
      AND (:scope_table IS NULL OR table_name = :scope_table)
      AND stale_stats = 'NO' AND num_rows > 0 AND table_name NOT LIKE 'BIN$%'
), m AS (
    SELECT /*+ MATERIALIZE */ con_id, table_owner, table_name, partition_name, subpartition_name,
           inserts, updates, deletes, timestamp
    FROM cdb_tab_modifications
), tmp AS (
    SELECT /*+ MATERIALIZE */ con_id, owner, table_name FROM cdb_tables WHERE temporary = 'Y'
), p AS (
    SELECT /*+ MATERIALIZE */ con_id, owner, table_name,
           TO_NUMBER(preference_value DEFAULT NULL ON CONVERSION ERROR) pct
    FROM cdb_tab_stat_prefs
    WHERE preference_name = 'STALE_PERCENT'
), u AS (
    SELECT /*+ MATERIALIZE */ con_id, username, oracle_maintained FROM cdb_users
), n AS (
    SELECT s.*, m.inserts, m.updates, m.deletes, m.timestamp,
           NVL(p.pct, TO_NUMBER(DBMS_STATS.GET_PREFS('STALE_PERCENT') DEFAULT 10 ON CONVERSION ERROR)) pct,
           NVL(u.oracle_maintained, 'N') om
    FROM s
    JOIN m ON m.con_id = s.con_id AND m.table_owner = s.owner AND m.table_name = s.table_name
          AND DECODE(m.partition_name, s.partition_name, 1, 0) = 1
          AND DECODE(m.subpartition_name, s.subpartition_name, 1, 0) = 1
    LEFT JOIN p ON p.con_id = s.con_id AND p.owner = s.owner AND p.table_name = s.table_name
    LEFT JOIN u ON u.con_id = s.con_id AND u.username = s.owner
    WHERE NOT EXISTS (
        SELECT 1 FROM tmp
        WHERE tmp.con_id = s.con_id AND tmp.owner = s.owner AND tmp.table_name = s.table_name)
)
SELECT REPLACE(JSON_ARRAY(
           n.con_id, n.owner, n.table_name, n.partition_name, n.subpartition_name,
           n.object_type, n.num_rows,
           TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(n.last_analyzed AS TIMESTAMP), '&dbtz')), '&ts_fmt'),
           n.inserts, n.updates, n.deletes,
           TO_CHAR(SYS_EXTRACT_UTC(FROM_TZ(CAST(n.timestamp AS TIMESTAMP), '&dbtz')), '&ts_fmt'),
           n.pct, n.om
           NULL ON NULL RETURNING VARCHAR2(4000)), '</', '<\/') || ','
FROM n
WHERE n.pct > 0 AND n.inserts + n.updates + n.deletes >= n.pct / 200 * n.num_rows
ORDER BY CASE WHEN n.om = 'Y' THEN 1 ELSE 0 END,
         (n.inserts + n.updates + n.deletes) / n.num_rows / n.pct DESC,
         n.con_id, n.owner, n.table_name
FETCH FIRST 2000 ROWS ONLY;
SELECT '];</script>' FROM dual;
