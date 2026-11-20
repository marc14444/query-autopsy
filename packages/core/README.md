# `@query-autopsy/core`

Zero-dependency TypeScript core engine for **QueryAutopsy**:
- Single-pass dialect SQL classifier & safety guards (`postgresql`, `mysql`, `sqlite`)
- PostgreSQL `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, MySQL 8+ `EXPLAIN ANALYZE / FORMAT=JSON`, and SQLite `EXPLAIN QUERY PLAN` parsers
- Diagnostic rules (`SEQ_SCAN_LARGE_TABLE`, `ESR_COMPOSITE_INDEX_OPPORTUNITY`, `EXTERNAL_DISK_SPILL`, `NON_SARGABLE_PREDICATE`, `CORRELATED_SUBPLAN`, `BITMAP_LOSSY_BLOCKS`, etc.)
- PII SQL & plan literal redaction (`redactSqlLiterals`, `redactExecutionPlanLiterals`) and error sanitization (`sanitizeSqlError`)
- Markdown PR report formatting & before/after plan diff comparison

Supports both **ESM** and **CommonJS** consumers.
