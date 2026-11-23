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

### Rule 6: `ESR_COMPOSITE_INDEX_OPPORTUNITY`
- **Condition**: `Sort` node with `Sort Key` over a primary scan descendant (`Seq Scan` meeting `seqScanRowThreshold`, or `Index Scan` / `Bitmap Heap Scan` with `sortRows >= 500`).
- **Behavior**: Classifies filter/index equality (`=`, `IN`) vs range (`<`, `<=`, `>`, `>=`, `BETWEEN`) predicates and recommends composite index column ordering **Equality → Sort → Range** (up to 4 columns, preserving `DESC` / `NULLS` clauses).

### Rule 7: `NON_SARGABLE_PREDICATE`
- **Condition**: `Filter` applies a function (`lower`, `upper`, `trim`, `date`, `date_trunc`, `extract`, `coalesce`, etc.) or explicit type cast (`col::text`) directly onto a table column on the LHS of a comparison.
- **Behavior**: Suggests an expression index (`CREATE INDEX CONCURRENTLY ... (lower(col))`) for immutable string normalization functions, or SARGable range/type rewrites when expression indexes are unsafe (e.g. `date(timestamptz)`).

### Rule 8: `CORRELATED_SUBPLAN`
- **Condition**: `Subplan Name` starts with `SubPlan` (correlated per-outer-row evaluation) and `actualLoops >= 50` in `analyze` mode (or `totalCost >= 100` in `estimate` mode).
- **Severity**: `critical` if `actualLoops >= 1000`, else `warning` (`info` in `estimate`).

### Rule 9: `BITMAP_LOSSY_BLOCKS`
- **Condition**: `mode === 'analyze'`, `nodeType === 'Bitmap Heap Scan'`, and `lossyHeapBlocks > 0`.
- **Severity**: `critical` if `lossyHeapBlocks >= 100 && lossyHeapBlocks > exactHeapBlocks`, else `warning`.

### Rule 10: `HASH_AGG_OR_JOIN_DISK_SPILL`
- **Attribution Guard**: Evaluated inside the shared spill detector alongside `EXTERNAL_DISK_SPILL` (never duplicates alerts on a single node). Fires on `Hash`, `Hash Join`, `HashAggregate`, and `MixedAggregate` nodes when `hashBatches > 1` or `exclusiveTempWritten > 0`.
- **Severity**: `critical`.
- **Recommendation**: Pre-filter rows on time/partition keys before hashing, project fewer columns, or increase session `work_mem`.

### Rule 11: `SELECT_STAR_WIDE_SCAN`
- **Condition**: Leaf scan (`Seq Scan`, `Bitmap Heap Scan`, `Index Scan`) with `relationName`, SQL projection contains top-level or CTE `SELECT *` / `SELECT alias.*` (`hasTopLevelSelectStar` ignores `COUNT(*)` and arithmetic `*`), scanned rows `>= seqScanRowThreshold`, and `planWidth >= 180` (`>= 96` when `workloadProfile === 'analytics'`).
- **Severity**: `critical` if `rows * planWidth >= 50 MiB` or (`rows >= 100,000` and `planWidth >= 256`), else `warning`.

### Rule 12: `MISSING_PARTITION_PRUNING`
- **Condition**: `Append` or `Merge Append` node with `>= 2` child scans where `Subplans Removed === 0` (explicitly unpruned) OR `>= 3` child partitions sharing a common base table prefix without any pruned subplans, and scanned rows `>= seqScanRowThreshold` (or `>= 4` child partitions). Suppressed when `subplansRemoved > 0`.
- **Severity**: `critical` if `partitions >= 12` or `totalRows >= seqScanRowThreshold * 50`, else `warning`.

### Rule 13: `CARTESIAN_OR_UNBOUNDED_JOIN`
- **Condition**: `Nested Loop` (`Inner` or unspecified `Join Type`) with two children, no `Filter`, no `Index Cond` / `Recheck Cond` / `Filter` on the inner child, `outerRows >= 50`, `innerPerLoopRows >= 50`, and output rows `>= max(seqScanRowThreshold * 5, 5000)` matching `>= 80%` of `outerRows * innerPerLoopRows`. Suppresses duplicate `NESTED_LOOP_HIGH_LOOPS` on the same node.
- **Severity**: `critical` if output rows `>= 100,000`, else `warning`.

### Workload Profile (`workloadProfile`)
- `'auto'` (default) & `'oltp'`: Preserves full `SEQ_SCAN_LARGE_TABLE` checks on all tables meeting `seqScanRowThreshold`.
- `'analytics'`: Suppresses `SEQ_SCAN_LARGE_TABLE` on unfiltered `Seq Scan` nodes feeding `Aggregate` / `HashAggregate` / `GroupAggregate` / `WindowAgg` full-fact rollups, while lowering the `SELECT_STAR_WIDE_SCAN` width threshold to `96` bytes/row.
