# ADR-0002: PostgreSQL-Only MVP & Transactional EXPLAIN Safety Guardrails

- **Status**: Accepted
- **Date**: 2026-11-19

## Context

`EXPLAIN ANALYZE` in PostgreSQL **actually executes the query** to measure true timing, rows, and buffer reads. Running `EXPLAIN ANALYZE` naively on user-selected text creates serious risks:
1. Selecting `DELETE`, `UPDATE`, `INSERT`, or a data-modifying `WITH` CTE mutates database state.
2. Selecting a `SELECT` calling a volatile stored procedure can mutate data.
3. Selecting multiple semicolon-separated statements (`SELECT 1; DROP TABLE users;`) risks arbitrary SQL execution.
4. Selecting an unindexed Cartesian join can lock DB CPU for minutes.

## Decision

1. **PostgreSQL Exclusive Focus for MVP**: Support only PostgreSQL `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and `EXPLAIN (COSTS, VERBOSE, FORMAT JSON)` instead of abstracting across incompatible query plan formats (MySQL/SQLite).
2. **Lexical Classification Before Execution**: `classifySqlStatement` scans SQL outside quotes/comments, rejects empty queries, multi-statement payloads, `EXPLAIN`-prefixed queries, and all `DDL`.
3. **Write Protection Policy**: `WRITE` queries (`INSERT`/`UPDATE`/`DELETE`/`MERGE` and writable CTEs) are rejected in `analyze` mode unless `queryAutopsy.postgres.allowWriteAnalyze` is explicitly `true`. They are always allowed in `estimate` mode (which does not execute the query).
4. **Transactional Isolation & Timeout**:
   - `READ` queries in `analyze` mode execute inside `BEGIN READ ONLY`.
   - Permitted `WRITE` queries execute inside `BEGIN`.
   - Every execution enforces `SET LOCAL statement_timeout = <bounded int>` (default `5000ms`, range `100..120000ms`).
   - `ROLLBACK` is unconditionally executed in `finally`.

## Consequences

- **Positive**:
  - Prevents accidental data loss or runaway queries on local/staging DBs.
  - Engine-enforced `BEGIN READ ONLY` blocks hidden mutations inside volatile functions.
- **Negative / Trade-offs**:
  - `EXPLAIN ANALYZE` on a `SELECT` cannot inspect a volatile function that intentionally writes (correct safety trade-off — users can use `estimate` mode for those).
  - Sequences incremented during rolled-back `INSERT` tests are not rolled back by PostgreSQL MVCC (documented behavior when `allowWriteAnalyze` is toggled on).
