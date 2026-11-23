import type {
  DiagnosticFinding,
  DiagnosticSeverity,
} from '../../models/diagnostic.js';
import type { ExecutionPlan, PlanNode } from '../../models/executionPlan.js';
import {
  analyzePlanWithRules,
  type DiagnosticConfig,
  type DiagnosticRule,
  hasTopLevelSelectStar,
} from '../../services/diagnosticEngine.js';

const PARQUET_OR_COLUMNAR_SCAN_TYPES = new Set([
  'PARQUET_SCAN',
  'READ_PARQUET',
  'CSV_SCAN',
  'READ_CSV',
  'SEQ_SCAN',
]);

const DUCKDB_HASH_OR_SORT_NODES = new Set([
  'HASH_JOIN',
  'HASH_GROUP_BY',
  'PERFECT_HASH_GROUP_BY',
  'ORDER_BY',
  'TOP_N',
  'WINDOW',
]);

function effectiveRows(node: PlanNode, plan: ExecutionPlan): number {
  const actual = plan.mode === 'analyze' ? node.actualRows : undefined;
  return Math.round(actual ?? node.planRows);
}

function isParquetScanNode(node: PlanNode, sql?: string): boolean {
  const upperType = node.nodeType.toUpperCase();
  if (upperType.includes('PARQUET')) {
    return true;
  }
  if (!PARQUET_OR_COLUMNAR_SCAN_TYPES.has(upperType)) {
    return false;
  }
  const relLower = (node.relationName ?? '').toLowerCase();
  const sqlLower = (sql ?? '').toLowerCase();
  return (
    relLower.includes('.parquet') ||
    relLower.includes('read_parquet') ||
    sqlLower.includes('.parquet') ||
    sqlLower.includes('read_parquet')
  );
}

const parquetProjectionMissRule: DiagnosticRule = (node, plan, config) => {
  const upperType = node.nodeType.toUpperCase();
  if (!PARQUET_OR_COLUMNAR_SCAN_TYPES.has(upperType)) {
    return null;
  }
  if (!isParquetScanNode(node, config.sql) && !hasTopLevelSelectStar(config.sql)) {
    return null;
  }

  const rows = effectiveRows(node, plan);
  if (rows < config.seqScanRowThreshold) {
    return null;
  }

  const selectsStar = hasTopLevelSelectStar(config.sql);
  const outputCount = node.output?.length ?? 0;
  if (!selectsStar && outputCount < 10) {
    return null;
  }

  const target = node.relationName ?? 'Parquet/table source';
  const severity: DiagnosticSeverity =
    rows >= config.seqScanRowThreshold * 50 || outputCount >= 20
      ? 'critical'
      : 'warning';

  return {
    ruleId: 'PARQUET_PROJECTION_MISS',
    severity,
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: node.relationName,
    title: `Columnar Projection Miss on "${target}" (${rows.toLocaleString('en-US')} rows)`,
    detail: selectsStar
      ? `Query uses SELECT * over columnar storage "${target}", forcing DuckDB to decode unnecessary columns across row groups.`
      : `Scan reads ${outputCount} columns (${rows.toLocaleString('en-US')} rows) from "${target}".`,
    recommendation:
      'Project only required columns explicitly (avoid SELECT *) so DuckDB reads only the needed Parquet column chunks.',
  };
};

const parquetPredicatePushdownMissRule: DiagnosticRule = (
  node,
  plan,
  config,
) => {
  const upperType = node.nodeType.toUpperCase();
  const childScan = node.children[0];

  if (
    upperType === 'FILTER' &&
    childScan &&
    PARQUET_OR_COLUMNAR_SCAN_TYPES.has(childScan.nodeType.toUpperCase())
  ) {
    const inputRows = effectiveRows(childScan, plan);
    const keptRows = effectiveRows(node, plan);
    if (inputRows < config.seqScanRowThreshold) {
      return null;
    }

    const filterText = node.filter ?? '';
    const isParquet = isParquetScanNode(childScan, config.sql);
    if (!isParquet && inputRows < Math.max(keptRows * 3, config.seqScanRowThreshold)) {
      return null;
    }

    return {
      ruleId: 'PARQUET_PREDICATE_PUSHDOWN_MISS',
      severity:
        inputRows >= config.seqScanRowThreshold * 50 ? 'critical' : 'warning',
      nodeId: node.id,
      nodeType: node.nodeType,
      relationName: childScan.relationName,
      title: `Post-Scan Filter Not Pushed Down (${inputRows.toLocaleString('en-US')} rows scanned)`,
      detail: `FILTER executed above ${childScan.nodeType}${filterText ? ` (${filterText})` : ''} instead of skipping Parquet row groups via min/max statistics.`,
      recommendation:
        'Rewrite predicates without column casts or wrapping functions (e.g. compare timestamps/dates using raw bounds) so DuckDB pushes filters directly into Parquet row-group statistics.',
    };
  }

  if (
    PARQUET_OR_COLUMNAR_SCAN_TYPES.has(upperType) &&
    isParquetScanNode(node, config.sql) &&
    node.filter &&
    /\b(?:cast|lower|upper|date_trunc|strftime)\s*\(/i.test(node.filter)
  ) {
    const rows = effectiveRows(node, plan);
    if (rows < config.seqScanRowThreshold) {
      return null;
    }

    return {
      ruleId: 'PARQUET_PREDICATE_PUSHDOWN_MISS',
      severity: 'warning',
      nodeId: node.id,
      nodeType: node.nodeType,
      relationName: node.relationName,
      title: `Expression Filter Blocks Parquet Zone-Map Pruning`,
      detail: `Filter expression "${node.filter}" wraps column values inside a function/cast during ${node.nodeType}.`,
      recommendation:
        'Move type conversions or date formatting onto the literal side (e.g. col >= DATE \'2026-01-01\') to unlock Parquet row-group skipping.',
    };
  }

  return null;
};

const duckdbOutOfCoreSpillRule: DiagnosticRule = (node, plan, config) => {
  const upperType = node.nodeType.toUpperCase();
  if (!DUCKDB_HASH_OR_SORT_NODES.has(upperType)) {
    return null;
  }

  const childrenTemp = node.children.reduce(
    (sum, c) => sum + c.buffers.tempWrittenBlocks,
    0,
  );
  const exclusiveSpill = Math.max(
    0,
    node.buffers.tempWrittenBlocks - childrenTemp,
  );
  const explicitSpill =
    exclusiveSpill > 0 || node.sort?.sortSpaceType === 'Disk';
  const rows = effectiveRows(node, plan);
  const largeMemoryPressure =
    rows >= Math.max(config.seqScanRowThreshold * 100, 500_000);

  if (!explicitSpill && !largeMemoryPressure) {
    return null;
  }

  const severity: DiagnosticSeverity = explicitSpill ? 'critical' : 'warning';

  return {
    ruleId: 'DUCKDB_OUT_OF_CORE_SPILL',
    severity,
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: node.relationName,
    title: explicitSpill
      ? `DuckDB Out-of-Core Spill in ${node.nodeType}`
      : `High Memory / Spill Risk in ${node.nodeType} (${rows.toLocaleString('en-US')} rows)`,
    detail: explicitSpill
      ? `${node.nodeType} spilled temporary buffers to disk because intermediate hash/sort state exceeded memory_limit.`
      : `${node.nodeType} processes ${rows.toLocaleString('en-US')} rows in memory; unbounded inputs may trigger temp-directory spilling.`,
    recommendation:
      'Filter earlier before joining or grouping, place smaller dimension tables on the build side, or tune DuckDB memory_limit / temp_directory for large batch transforms.',
  };
};

const duckdbCartesianRule: DiagnosticRule = (node, plan, config) => {
  const upperType = node.nodeType.toUpperCase();
  if (upperType !== 'CROSS_PRODUCT' && upperType !== 'NESTED_LOOP_JOIN') {
    return null;
  }

  const rows = effectiveRows(node, plan);
  if (rows < Math.max(config.seqScanRowThreshold * 5, 5000)) {
    return null;
  }

  return {
    ruleId: 'CARTESIAN_OR_UNBOUNDED_JOIN',
    severity: rows >= 100_000 ? 'critical' : 'warning',
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: node.relationName,
    title: `DuckDB ${node.nodeType} (${rows.toLocaleString('en-US')} rows)`,
    detail: `${node.nodeType} produces ${rows.toLocaleString('en-US')} rows without a hash/equality join condition.`,
    recommendation:
      'Verify an explicit JOIN ON equality key exists so DuckDB executes a vectorized HASH_JOIN instead of a cross/nested-loop product.',
  };
};

const DUCKDB_RULES: readonly DiagnosticRule[] = [
  parquetProjectionMissRule,
  parquetPredicatePushdownMissRule,
  duckdbOutOfCoreSpillRule,
  duckdbCartesianRule,
];

export function analyzeDuckDbPlan(
  plan: ExecutionPlan,
  config: DiagnosticConfig,
): readonly DiagnosticFinding[] {
  return analyzePlanWithRules(plan, config, DUCKDB_RULES);
}
