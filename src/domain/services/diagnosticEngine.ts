import type {
  DiagnosticFinding,
  DiagnosticSeverity,
  IndexSuggestion,
} from '../models/diagnostic.js';
import type { ExecutionPlan, PlanNode } from '../models/executionPlan.js';

export interface DiagnosticConfig {
  readonly seqScanRowThreshold: number;
}

type DiagnosticRule = (
  node: PlanNode,
  plan: ExecutionPlan,
  config: DiagnosticConfig,
) => DiagnosticFinding | null;

const NON_COLUMN_IDENTIFIERS = new Set([
  'and',
  'or',
  'not',
  'is',
  'null',
  'true',
  'false',
  'any',
  'all',
  'in',
  'like',
  'ilike',
  'similar',
  'between',
  'exists',
  'case',
  'when',
  'then',
  'else',
  'end',
  'text',
  'varchar',
  'char',
  'bpchar',
  'int',
  'int2',
  'int4',
  'int8',
  'integer',
  'bigint',
  'smallint',
  'numeric',
  'decimal',
  'real',
  'float4',
  'float8',
  'double',
  'precision',
  'boolean',
  'bool',
  'uuid',
  'json',
  'jsonb',
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'interval',
  'bytea',
  'now',
  'lower',
  'upper',
  'coalesce',
]);

/**
 * Extracts likely filter column names from a Postgres EXPLAIN Filter expression
 * (e.g. "((user_id = 42) AND (o.status = 'pending'::text))").
 */
export function extractFilterColumns(
  filterExpression: string | undefined,
  alias?: string,
): readonly string[] {
  if (!filterExpression) {
    return [];
  }

  // Remove single-quoted literals and Postgres type casts (::text, ::timestamp with time zone, ::bigint[])
  const sanitized = filterExpression
    .replace(/'(?:''|[^'])*'/g, ' ')
    .replace(
      /::(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*(?:\s+(?:with|without)\s+time\s+zone|\s+varying|\s+precision)?)(?:\([^)]*\))?(?:\[\])*/gi,
      ' ',
    );

  const columns = new Set<string>();
  const aliasPrefix = alias ? `${alias}.` : undefined;

  // Prefer qualified columns (alias.col) or left-hand comparison identifiers
  const comparisonRegex =
    /(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|<>|!=|<=|>=|<|>|\bIS\b|\bIN\b|\bLIKE\b|\bILIKE\b|\bBETWEEN\b|~~\*?)/gi;

  let match: RegExpExecArray | null;
  while ((match = comparisonRegex.exec(sanitized)) !== null) {
    const tableRef = match[1];
    const colName = match[2];
    if (!colName) {
      continue;
    }
    if (NON_COLUMN_IDENTIFIERS.has(colName.toLowerCase())) {
      continue;
    }
    if (aliasPrefix && tableRef && `${tableRef}.` !== aliasPrefix) {
      continue;
    }
    columns.add(colName);
  }

  return Array.from(columns);
}

function buildIndexSuggestion(
  tableName: string,
  columns: readonly string[],
): IndexSuggestion | undefined {
  if (columns.length === 0) {
    return undefined;
  }
  const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, '_');
  const colSlug = columns.map((c) => c.replace(/[^a-zA-Z0-9_]/g, '_')).join('_');
  const indexName = `idx_${safeTable}_${colSlug}`;
  const columnList = columns.join(', ');

  return {
    table: tableName,
    columns,
    sql: `CREATE INDEX CONCURRENTLY ${indexName} ON ${tableName} (${columnList});`,
  };
}

const seqScanRule: DiagnosticRule = (node, plan, config) => {
  if (node.nodeType !== 'Seq Scan' || !node.relationName) {
    return null;
  }

  const loops = node.actualLoops ?? 1;
  const scannedRows =
    plan.mode === 'analyze' && node.actualRows !== undefined
      ? Math.round((node.actualRows + (node.rowsRemovedByFilter ?? 0)) * loops)
      : Math.round(node.planRows);

  if (scannedRows < config.seqScanRowThreshold) {
    return null;
  }

  const severity: DiagnosticSeverity =
    scannedRows >= config.seqScanRowThreshold * 50 ? 'critical' : 'warning';

  const filterColumns = extractFilterColumns(node.filter, node.alias);
  const indexSuggestion = buildIndexSuggestion(node.relationName, filterColumns);

  const removedPart =
    node.rowsRemovedByFilter !== undefined && node.rowsRemovedByFilter > 0
      ? ` (${Math.round(node.rowsRemovedByFilter * loops).toLocaleString('en-US')} rows discarded by filter)`
      : '';

  return {
    ruleId: 'SEQ_SCAN_LARGE_TABLE',
    severity,
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: node.relationName,
    title: `Sequential Scan on "${node.relationName}" (${scannedRows.toLocaleString('en-US')} rows scanned)`,
    detail: `Postgres read "${node.relationName}" sequentially${removedPart}${node.filter ? ` using filter ${node.filter}` : ''}.`,
    recommendation: indexSuggestion
      ? `Add an index on (${indexSuggestion.columns.join(', ')}) to avoid full table scans: ${indexSuggestion.sql}`
      : `Consider adding a selective index matching your WHERE/JOIN predicates on "${node.relationName}" or narrowing the query.`,
    indexSuggestion,
  };
};

const externalDiskSpillRule: DiagnosticRule = (node) => {
  const childrenTempWritten = node.children.reduce(
    (sum, child) => sum + child.buffers.tempWrittenBlocks,
    0,
  );
  const exclusiveTempWritten = Math.max(
    0,
    node.buffers.tempWrittenBlocks - childrenTempWritten,
  );

  const isExternalSort =
    node.sort?.sortSpaceType === 'Disk' ||
    (node.sort?.sortMethod?.toLowerCase().includes('external') ?? false);
  const isMultiBatchHash = (node.hashBatches ?? 1) > 1;

  if (!isExternalSort && !isMultiBatchHash && exclusiveTempWritten === 0) {
    return null;
  }

  const spilledKb =
    node.sort?.sortSpaceUsedKb ??
    (exclusiveTempWritten > 0 ? exclusiveTempWritten * 8 : undefined);

  const sizeInfo =
    spilledKb !== undefined
      ? `${spilledKb.toLocaleString('en-US')} KB spilled to disk`
      : 'temporary disk I/O detected';

  return {
    ruleId: 'EXTERNAL_DISK_SPILL',
    severity: 'critical',
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: node.relationName,
    title: `Disk Spill in ${node.nodeType} (${sizeInfo})`,
    detail: `Operation exceeded in-memory work_mem (${node.sort?.sortMethod ?? (isMultiBatchHash ? `${node.hashBatches} hash batches` : `${exclusiveTempWritten} temp blocks`)}).`,
    recommendation:
      'Reduce sorted/hashed row volume with tighter filters or pre-sorted indexes, or increase session work_mem if appropriate.',
  };
};

const rowMisestimateRule: DiagnosticRule = (node, plan) => {
  if (plan.mode !== 'analyze' || node.actualRows === undefined) {
    return null;
  }

  const estimated = node.planRows;
  const actual = node.actualRows;
  const absDiff = Math.abs(actual - estimated);

  if (absDiff < 100) {
    return null;
  }

  const safeEst = Math.max(estimated, 1);
  const safeAct = Math.max(actual, 1);
  const ratio = Math.max(safeAct / safeEst, safeEst / safeAct);

  if (ratio < 10) {
    return null;
  }

  const severity: DiagnosticSeverity =
    ratio >= 100 && absDiff >= 1000 ? 'critical' : 'warning';
  const targetLabel = node.relationName ? ` on "${node.relationName}"` : '';

  return {
    ruleId: 'PLANNER_ROW_MISESTIMATE',
    severity,
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: node.relationName,
    title: `Planner Row Misestimate (${Math.round(ratio)}x off)${targetLabel}`,
    detail: `Estimated ${estimated.toLocaleString('en-US')} rows per loop vs ${actual.toLocaleString('en-US')} actual rows.`,
    recommendation: node.relationName
      ? `Run "ANALYZE ${node.relationName};" or create extended statistics (CREATE STATISTICS) for correlated columns.`
      : 'Run ANALYZE on involved tables or review non-sargable expressions (functions on indexed columns) that hide selectivity.',
  };
};

const lowCacheHitRule: DiagnosticRule = (node, plan) => {
  if (plan.mode !== 'analyze') {
    return null;
  }

  const childHit = node.children.reduce(
    (sum, child) => sum + child.buffers.sharedHitBlocks,
    0,
  );
  const childRead = node.children.reduce(
    (sum, child) => sum + child.buffers.sharedReadBlocks,
    0,
  );

  const exclusiveHit = Math.max(0, node.buffers.sharedHitBlocks - childHit);
  const exclusiveRead = Math.max(0, node.buffers.sharedReadBlocks - childRead);
  const exclusiveTotal = exclusiveHit + exclusiveRead;

  if (exclusiveRead < 100 || exclusiveTotal === 0) {
    return null;
  }

  const hitRatio = exclusiveHit / exclusiveTotal;
  if (hitRatio >= 0.85 && exclusiveRead < 2000) {
    return null;
  }

  const readMb = ((exclusiveRead * 8) / 1024).toFixed(2);
  const severity: DiagnosticSeverity = exclusiveRead >= 5000 ? 'critical' : 'warning';

  return {
    ruleId: 'LOW_CACHE_HIT_RATIO',
    severity,
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: node.relationName,
    title: `Heavy Disk/OS Cache Reads in ${node.nodeType} (${(hitRatio * 100).toFixed(1)}% buffer hit)`,
    detail: `Node read ${exclusiveRead.toLocaleString('en-US')} blocks (~${readMb} MB) from disk/OS page cache vs ${exclusiveHit.toLocaleString('en-US')} shared buffer hits.`,
    recommendation:
      'Reduce scanned pages with covering/partial indexes or tighter filters; repeated runs may also reflect cold shared_buffers.',
  };
};

const nestedLoopHighLoopsRule: DiagnosticRule = (node, plan) => {
  if (plan.mode !== 'analyze' || node.nodeType !== 'Nested Loop') {
    return null;
  }

  const innerChild = node.children[1];
  const innerLoops = innerChild?.actualLoops ?? 0;
  if (innerLoops < 1000) {
    return null;
  }

  return {
    ruleId: 'NESTED_LOOP_HIGH_LOOPS',
    severity: innerLoops >= 10000 ? 'critical' : 'warning',
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: innerChild?.relationName,
    title: `High-Frequency Nested Loop (${innerLoops.toLocaleString('en-US')} inner loops)`,
    detail: `Inner child "${innerChild?.nodeType ?? 'Unknown'}" executed ${innerLoops.toLocaleString('en-US')} times.`,
    recommendation:
      'Verify outer row estimates are accurate (ANALYZE) and ensure join columns are indexed; for large sets a Hash Join or Merge Join is often faster.',
  };
};

const RULES: readonly DiagnosticRule[] = [
  seqScanRule,
  externalDiskSpillRule,
  rowMisestimateRule,
  lowCacheHitRule,
  nestedLoopHighLoopsRule,
];

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function visitTree(
  node: PlanNode,
  plan: ExecutionPlan,
  config: DiagnosticConfig,
  findings: DiagnosticFinding[],
): void {
  for (const rule of RULES) {
    const finding = rule(node, plan, config);
    if (finding) {
      findings.push(finding);
    }
  }
  for (const child of node.children) {
    visitTree(child, plan, config, findings);
  }
}

export function analyzeExecutionPlan(
  plan: ExecutionPlan,
  config: DiagnosticConfig,
): readonly DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  visitTree(plan.root, plan, config, findings);
  return findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}
