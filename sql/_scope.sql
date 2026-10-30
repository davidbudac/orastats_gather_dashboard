-- Shared history scope. Each large CDB view is materialized before joining.
-- Targets are Oracle's quoted owner/object[/partition] strings. Index tasks
-- are selected by their base table, including indexes owned by another schema.
WITH scope_history AS (
    SELECT /*+ MATERIALIZE */ o.* FROM cdb_optstat_operations o
    WHERE o.start_time >= &cutoff
), scope_indexes AS (
    SELECT /*+ MATERIALIZE */ con_id, owner, index_name, table_owner, table_name
    FROM cdb_indexes
    WHERE :scope_schema IS NOT NULL AND table_owner = :scope_schema
      AND (:scope_table IS NULL OR table_name = :scope_table)
), scope_raw_tasks AS (
    SELECT /*+ MATERIALIZE */ t.*,
           REGEXP_SUBSTR(t.target, '"([^"]+)"', 1, 1, NULL, 1) scope_owner,
           REGEXP_SUBSTR(t.target, '"([^"]+)"', 1, 2, NULL, 1) scope_object
    FROM cdb_optstat_operation_tasks t
    WHERE (t.con_id, t.opid) IN (SELECT con_id, id FROM scope_history)
), scope_tasks AS (
    SELECT /*+ MATERIALIZE */ t.* FROM scope_raw_tasks t
    WHERE :scope_schema IS NULL
       OR (t.target_type NOT LIKE 'INDEX%'
           AND t.scope_owner = :scope_schema
           AND (:scope_table IS NULL OR t.scope_object = :scope_table))
       OR (t.target_type LIKE 'INDEX%' AND EXISTS (
           SELECT 1 FROM scope_indexes i
           WHERE i.con_id = t.con_id AND i.owner = t.scope_owner
             AND i.index_name = t.scope_object))
), scope_ops AS (
    SELECT /*+ MATERIALIZE */ o.* FROM scope_history o
    WHERE :scope_schema IS NULL
       OR EXISTS (SELECT 1 FROM scope_tasks t WHERE t.con_id = o.con_id AND t.opid = o.id)
       -- Explicit schema/table calls can have no task rows (for example failures).
       OR (:scope_table IS NULL AND (
           o.target IN (:scope_schema, '"' || :scope_schema || '"')
           OR REGEXP_SUBSTR(o.target, '"([^"]+)"', 1, 1, NULL, 1) = :scope_schema
           OR SUBSTR(o.target, 1, LENGTH(:scope_schema) + 1) = :scope_schema || '.'))
       OR (o.operation NOT LIKE '%index%' AND (
           o.target = :scope_schema || '.' || :scope_table
           OR (REGEXP_SUBSTR(o.target, '"([^"]+)"', 1, 1, NULL, 1) = :scope_schema
               AND REGEXP_SUBSTR(o.target, '"([^"]+)"', 1, 2, NULL, 1) = :scope_table)))
       OR (o.operation LIKE '%index%' AND EXISTS (
           SELECT 1 FROM scope_indexes i WHERE i.con_id = o.con_id
             AND o.target IN (i.owner || '.' || i.index_name,
                             '"' || i.owner || '"."' || i.index_name || '"')))
)
