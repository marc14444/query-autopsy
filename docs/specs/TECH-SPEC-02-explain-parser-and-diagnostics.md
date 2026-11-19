# TECH-SPEC-02: PostgreSQL EXPLAIN Parser & Diagnostic Engine

- **Modules Covered**:
  - `src/domain/models/executionPlan.ts`
  - `src/domain/models/diagnostic.ts`
  - `src/domain/services/planParser.ts`
  - `src/domain/services/diagnosticEngine.ts`

---

## 1. Execution Plan Math & PostgreSQL Semantics

### 1.1 Timing Calculations
In PostgreSQL JSON output, `Actual Total Time` is:
- **Per loop** (averaged across `Actual Loops`)
- **Cumulative** (includes time spent inside child `Plans`)

Formulas implemented in `parsePostgreSqlPlan`:
- `inclusiveTimeMs = actualTotalTimeMs * (actualLoops ?? 1)`
- `exclusiveTimeMs = Math.max(0, inclusiveTimeMs - sum(child.inclusiveTimeMs))`
  - *Why `Math.max(0, ...)`?* In parallel plans (`Gather`, `Gather Merge`), child worker times are averaged across workers and multiplied by `Actual Loops`, so summing child inclusive times can exceed the parent's wall-clock time. Clamping prevents negative durations.
- `exclusiveTimePercent = Math.min(100, (exclusiveTimeMs / denominator) * 100)` where `denominator` is `Execution Time` (preferred) or `root.inclusiveTimeMs`.

### 1.2 Buffer Metrics (Avoiding Double Counting)
In PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)`, every node's buffer fields (`Shared Hit Blocks`, `Shared Read Blocks`, `Temp Written Blocks`, etc.) are **cumulative across its subtree**.
- Therefore, `ExecutionPlan.totalBuffers = root.buffers` (NOT the sum of all nodes).
- `cacheHitRatio = sharedHitBlocks / (sharedHitBlocks + sharedReadBlocks)` (or `null` when denominator is `0`).
- Each PostgreSQL block defaults to **8 KB**.

---

## 2. Diagnostic Rule Specifications

All findings are sorted by severity: `critical` -> `warning` -> `info`.

### Rule 1: `SEQ_SCAN_LARGE_TABLE`
- **Condition**: `nodeType === 'Seq Scan'` and `relationName` present and `scannedRows >= seqScanRowThreshold` (default `1000`).
  - In `analyze`: `scannedRows = round((actualRows + (rowsRemovedByFilter ?? 0)) * actualLoops)`.
  - In `estimate`: `scannedRows = round(planRows)`.
- **Severity**:
  - `critical` if `scannedRows >= seqScanRowThreshold * 50` (50,000 rows by default)
  - `warning` otherwise
- **Index Suggestion**: `extractFilterColumns(node.filter, node.alias)` strips string literals and PostgreSQL `::type` casts, extracts comparison columns matching table alias, ignores SQL/type keywords, and emits:
  `CREATE INDEX CONCURRENTLY idx_<table>_<cols> ON <table> (<cols>);`

### Rule 2: `EXTERNAL_DISK_SPILL`
- **Attribution Guard**: Computes `exclusiveTempWritten = max(0, node.tempWrittenBlocks - sum(child.tempWrittenBlocks))` so parent nodes (`Limit`, `Nested Loop`) do NOT duplicate the spill alert from a child `Sort` or `Hash`.
- **Condition**: `sortSpaceType === 'Disk'` OR `sortMethod` includes `'external'` OR `hashBatches > 1` OR `exclusiveTempWritten > 0`.
- **Severity**: `critical`.

### Rule 3: `PLANNER_ROW_MISESTIMATE`
- **Condition**: `mode === 'analyze'`, `actualRows !== undefined`, `abs(actualRows - planRows) >= 100`, and `max(actual/plan, plan/actual) >= 10`.
- **Severity**: `critical` if `ratio >= 100 && absDiff >= 1000`, else `warning`.
- **Recommendation**: `ANALYZE <table>;` or `CREATE STATISTICS` for correlated columns.

### Rule 4: `LOW_CACHE_HIT_RATIO`
- **Attribution Guard**: Computes node-exclusive `exclusiveHit` and `exclusiveRead` by subtracting immediate child cumulative buffers.
- **Condition**: `mode === 'analyze'`, `exclusiveRead >= 100`, and (`hitRatio < 0.85` OR `exclusiveRead >= 2000`).
- **Severity**: `critical` if `exclusiveRead >= 5000` (~39 MB), else `warning`.

### Rule 5: `NESTED_LOOP_HIGH_LOOPS`
- **Condition**: `mode === 'analyze'`, `nodeType === 'Nested Loop'`, and `children[1]?.actualLoops >= 1000`.
- **Severity**: `critical` if `innerLoops >= 10000`, else `warning`.
