-- SPEC 12 pre-upgrade prechecks for the gootip-dev PostgreSQL major upgrade.
-- Read-only: every statement is a SELECT against catalogs or statistics views.
-- Run as gootip_dev_operator through the reviewed private tunnel:
--   ./scripts/db_access.sh tunnel
-- The full psql command with sslmode=verify-full and the reviewed
-- .db-access/rds-ca-bundle.pem is in README.md ("PostgreSQL lifecycle
-- contract"). Keep host set to the real RDS endpoint, hostaddr at the local
-- tunnel listener, and never disable certificate or hostname verification.
-- An empty result set is clean. Classify each finding before the upgrade:
--   critical: logical slots that are active, prepared transactions, unknown
--             types, or hash indexes (RDS pg_upgrade rejects them)
--   warning:  extensions with a newer default version, RDS-owned objects,
--             custom types, reg* columns, stale statistics, bloat
-- Record warnings for a targeted post-upgrade REINDEX or ANALYZE; never run
-- those operations preemptively across all tables.

\echo '== server and database encoding/locale (clean when one row per database) =='
SELECT d.datname,
       pg_encoding_to_char(d.encoding) AS encoding,
       d.datcollate,
       d.datctype,
       d.datlocprovider
FROM pg_database d
WHERE d.datallowconn
ORDER BY d.datname;

\echo '== installed extensions and available default versions (warning: extversion <> default_version) =='
SELECT e.extname,
       e.extversion,
       a.default_version,
       n.nspname AS schema
FROM pg_extension e
LEFT JOIN pg_available_extensions a ON a.name = e.extname
JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY e.extname;

\echo '== hash indexes (critical: RDS pg_upgrade does not support them) =='
SELECT n.nspname,
       c.relname AS table_name,
       ic.relname AS index_name
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_class ic ON ic.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_am am ON am.oid = ic.relam
WHERE am.amname = 'hash'
ORDER BY 1, 2, 3;

\echo '== column types missing from pg_type (critical: unknown types) =='
SELECT a.attrelid::regclass AS relation,
       a.attname,
       a.atttypid
FROM pg_attribute a
LEFT JOIN pg_type t ON t.oid = a.atttypid
WHERE a.attnum > 0
  AND NOT a.attisdropped
  AND t.oid IS NULL
ORDER BY 1, 2;

\echo '== types without a namespace (critical: unknown types) =='
SELECT t.oid, t.typname
FROM pg_type t
LEFT JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.oid IS NULL
ORDER BY 1;

\echo '== logical replication slots (critical when active; drop stale slots before the upgrade) =='
SELECT slot_name,
       plugin,
       database,
       active,
       restart_lsn,
       confirmed_flush_lsn
FROM pg_replication_slots
WHERE slot_type = 'logical'
ORDER BY slot_name;

\echo '== prepared transactions (critical: none may exist during the upgrade) =='
SELECT gid, prepared, owner, database
FROM pg_prepared_xacts
ORDER BY prepared;

\echo '== relations owned by RDS system roles (warning: review ownership) =='
SELECT n.nspname,
       c.relname,
       c.relkind,
       pg_get_userbyid(c.relowner) AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND pg_get_userbyid(c.relowner) LIKE 'rds%'
ORDER BY 1, 2;

\echo '== schemas owned by RDS system roles (warning: review ownership) =='
SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner
FROM pg_namespace n
WHERE n.nspname NOT LIKE 'pg\_%'
  AND n.nspname <> 'information_schema'
  AND pg_get_userbyid(n.nspowner) LIKE 'rds%'
ORDER BY 1;

\echo '== custom enums and domains (warning: verify PostgreSQL 18 compatibility) =='
SELECT n.nspname, t.typname, t.typtype
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND t.typtype IN ('e', 'd')
ORDER BY 1, 2;

\echo '== columns using reg* types (warning: verify these survive the upgrade) =='
SELECT n.nspname,
       c.relname AS table_name,
       a.attname,
       format_type(a.atttypid, a.atttypmod) AS column_type
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE a.attnum > 0
  AND NOT a.attisdropped
  AND c.relkind IN ('r', 'p', 'v', 'm')
  AND t.typname IN (
    'regclass', 'regcollation', 'regconfig', 'regdictionary', 'regnamespace',
    'regoper', 'regoperator', 'regproc', 'regprocedure', 'regrole', 'regtype'
  )
ORDER BY 1, 2, 3;

\echo '== tables with high dead-tuple ratio (warning: candidate for targeted VACUUM/ANALYZE) =='
SELECT schemaname,
       relname,
       n_live_tup,
       n_dead_tup,
       round(100.0 * n_dead_tup / GREATEST(n_live_tup + n_dead_tup, 1), 2) AS dead_pct,
       last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
  AND n_dead_tup > n_live_tup * 0.2
ORDER BY n_dead_tup DESC;

\echo '== indexes never scanned since statistics reset (warning: review, do not drop in this spec) =='
SELECT schemaname, relname AS table_name, indexrelname AS index_name, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;

\echo '== stale or missing table statistics (warning: candidate for targeted ANALYZE) =='
SELECT schemaname,
       relname,
       last_analyze,
       last_autoanalyze,
       n_mod_since_analyze
FROM pg_stat_user_tables
WHERE (
        last_analyze IS NULL
        AND last_autoanalyze IS NULL
        AND n_live_tup > 0
      )
   OR GREATEST(last_analyze, last_autoanalyze) < now() - interval '30 days'
   OR n_mod_since_analyze > GREATEST(n_live_tup * 0.1, 1000)
ORDER BY n_mod_since_analyze DESC;
