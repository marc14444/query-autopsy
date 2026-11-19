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
  'trim',
  'btrim',
  'date_trunc',
  'extract',
]);

const IMMUTABLE_EXPRESSION_FUNCTIONS = new Set(['lower', 'upper', 'btrim', 'trim']);

function sanitizeFilterExpression(filterExpression: string): string {
  return filterExpression
    .replace(/'(?:''|[^'])*'/g, ' ')
    .replace(
      /::(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*(?:\s+(?:with|without)\s+time\s+zone|\s+varying|\s+precision)?)(?:\([^)]*\))?(?:\[\])*/gi,
      ' ',
    );
}

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

  const sanitized = sanitizeFilterExpression(filterExpression);
  const columns = new Set<string>();
  const aliasPrefix = alias ? `${alias}.` : undefined;

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

function classifyPredicateColumns(
  expression: string | undefined,
  alias?: string,
): { readonly equalityCols: readonly string[]; readonly rangeCols: readonly string[] } {
  if (!expression) {
    return { equalityCols: [], rangeCols: [] };
  }

  const sanitized = sanitizeFilterExpression(expression);
  const equalityCols = new Set<string>();
  const rangeCols = new Set<string>();
  const aliasPrefix = alias ? `${alias}.` : undefined;

  const eqRegex =
    /(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|\bIN\b)/gi;
  const rangeRegex =
    /(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<=|>=|<|>|\bBETWEEN\b)/gi;

  let match: RegExpExecArray | null;
  while ((match = eqRegex.exec(sanitized)) !== null) {
    const tableRef = match[1];
    const col = match[2];
    if (!col || NON_COLUMN_IDENTIFIERS.has(col.toLowerCase())) {
      continue;
    }
    if (aliasPrefix && tableRef && `${tableRef}.` !== aliasPrefix) {
      continue;
    }
    equalityCols.add(col);
  }

  while ((match = rangeRegex.exec(sanitized)) !== null) {
    const tableRef = match[1];
    const col = match[2];
    if (!col || NON_COLUMN_IDENTIFIERS.has(col.toLowerCase())) {
      continue;
    }
    if (aliasPrefix && tableRef && `${tableRef}.` !== aliasPrefix) {
      continue;
    }
    if (!equalityCols.has(col)) {
      rangeCols.add(col);
    }
  }

  return {
    equalityCols: Array.from(equalityCols),
    rangeCols: Array.from(rangeCols),
  };
}

function buildIndexSuggestion(
  tableName: string,
  columns: readonly string[],
): IndexSuggestion | undefined {
  if (columns.length === 0) {
    return undefined;
  }
  const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, '_');
  const colSlug = columns
    .map((c) =>
      c
        .replace(/\s+(?:ASC|DESC|NULLS\s+FIRST|NULLS\s+LAST)/gi, '')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/^_+|_+$/g, ''),
    )
    .filter(Boolean)
    .join('_');

  const indexName = `idx_${safeTable}_${colSlug}`.slice(0, 60);
  const columnList = columns.join(', ');

  return {
    table: tableName,
    columns,
    sql: `CREATE INDEX CONCURRENTLY ${indexName} ON ${tableName} (${columnList});`,
  };
}

function findPrimaryScanDescendant(node: PlanNode): PlanNode | undefined {
  let current: PlanNode | undefined = node.children[0];
  while (
    current &&
    (current.nodeType === 'Gather' || current.nodeType === 'Gather Merge')
  ) {
    current = current.children[0];
  }
  if (
    current &&
    current.relationName &&
    (current.nodeType === 'Seq Scan' ||
      current.nodeType === 'Index Scan' ||
      current.nodeType === 'Index Only Scan' ||
      current.nodeType === 'Bitmap Heap Scan')
  ) {
    return current;
  }
  return undefined;
}

function parseSortKeyColumns(
  sortKeys: readonly string[],
  alias?: string,
): readonly { readonly column: string; readonly clause: string }[] {
  const parsed: Array<{ readonly column: string; readonly clause: string }> = [];
  for (const rawKey of sortKeys) {
    const trimmed = rawKey.trim();
    // Skip complex arithmetic/function sort expressions
    if (/[()+\-*/]/.test(trimmed)) {
      continue;
    }
    const match =
      /^(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(ASC|DESC))?(?:\s+(NULLS\s+(?:FIRST|LAST)))?$/i.exec(
        trimmed,
      );
    if (!match) {
      continue;
    }
    const tableRef = match[1];
    const colName = match[2];
    if (!colName) {
      continue;
    }
    if (alias && tableRef && tableRef !== alias) {
      continue;
    }
    const dir = match[3]?.toUpperCase() === 'DESC' ? ' DESC' : '';
    const nulls = match[4] ? ` ${match[4].toUpperCase()}` : '';
    parsed.push({
      column: colName,
      clause: `${colName}${dir}${nulls}`,
    });
  }
  return parsed;
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

const esrCompositeIndexRule: DiagnosticRule = (node, plan, config) => {
  if (node.nodeType !== 'Sort' || !node.sort?.sortKey?.length) {
    return null;
  }

  const scanNode = findPrimaryScanDescendant(node);
  if (!scanNode || !scanNode.relationName) {
    return null;
  }

  const scanLoops = scanNode.actualLoops ?? 1;
  const scannedRows =
    plan.mode === 'analyze' && scanNode.actualRows !== undefined
      ? Math.round(
          (scanNode.actualRows + (scanNode.rowsRemovedByFilter ?? 0)) *
            scanLoops,
        )
      : Math.round(scanNode.planRows);

  if (
    scanNode.nodeType === 'Seq Scan' &&
    scannedRows < config.seqScanRowThreshold
  ) {
    return null;
  }

  const sortRows =
    plan.mode === 'analyze' && node.actualRows !== undefined
      ? node.actualRows
      : node.planRows;

  if (scanNode.nodeType !== 'Seq Scan' && sortRows < 500) {
    return null;
  }

  const filterPreds = classifyPredicateColumns(scanNode.filter, scanNode.alias);
  const indexCondPreds = classifyPredicateColumns(
    scanNode.indexCond,
    scanNode.alias,
  );

  const eqCols = Array.from(
    new Set([...indexCondPreds.equalityCols, ...filterPreds.equalityCols]),
  );
  const rangeCols = Array.from(
    new Set([...indexCondPreds.rangeCols, ...filterPreds.rangeCols]),
  ).filter((col) => !eqCols.includes(col));

  const sortItems = parseSortKeyColumns(node.sort.sortKey, scanNode.alias);
  const sortClauses = sortItems
    .filter((item) => !eqCols.includes(item.column))
    .map((item) => item.clause);

  if (sortClauses.length === 0) {
    return null;
  }

  // Follow PostgreSQL ESR rule: Equality -> Sort -> Range
  const esrColumns = Array.from(
    new Set([...eqCols, ...sortClauses, ...rangeCols]),
  ).slice(0, 4);

  if (esrColumns.length < 2 && scanNode.nodeType === 'Seq Scan') {
    // Single-column filter or simple sort without composite benefit;
    // still suggest ordered index if sort-only over large table.
    if (eqCols.length === 0 && sortClauses.length === 1 && sortRows >= 1000) {
      const suggestion = buildIndexSuggestion(scanNode.relationName, esrColumns);
      if (!suggestion) {
        return null;
      }
      return {
        ruleId: 'ESR_COMPOSITE_INDEX_OPPORTUNITY',
        severity: 'warning',
        nodeId: node.id,
        nodeType: node.nodeType,
        relationName: scanNode.relationName,
        title: `Pre-sorted Index Opportunity on "${scanNode.relationName}"`,
        detail: `Sort node sorted ${sortRows.toLocaleString('en-US')} rows by (${sortClauses.join(', ')}) after ${scanNode.nodeType}.`,
        recommendation: `Add an ordered index to satisfy ORDER BY directly without an explicit Sort step: ${suggestion.sql}`,
        indexSuggestion: suggestion,
      };
    }
    return null;
  }

  const suggestion = buildIndexSuggestion(scanNode.relationName, esrColumns);
  if (!suggestion) {
    return null;
  }

  return {
    ruleId: 'ESR_COMPOSITE_INDEX_OPPORTUNITY',
    severity: scanNode.nodeType === 'Seq Scan' ? 'warning' : 'info',
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: scanNode.relationName,
    title: `Composite Index Opportunity (ESR) on "${scanNode.relationName}"`,
    detail: `Query filters on (${[...eqCols, ...rangeCols].join(', ') || 'none'}) and sorts ${sortRows.toLocaleString('en-US')} rows by (${sortClauses.join(', ')}).`,
    recommendation: `Use Equality -> Sort -> Range column order to eliminate both the scan bottleneck and the Sort step: ${suggestion.sql}`,
    indexSuggestion: suggestion,
  };
};

const nonSargablePredicateRule: DiagnosticRule = (node) => {
  if (!node.filter || !node.relationName) {
    return null;
  }

  const strippedLiterals = node.filter.replace(/'(?:''|[^'])*'/g, "''");

  // 1. Function call wrapping a column: e.g. lower(email) = ..., date(created_at) = ...
  const fnRegex =
    /\b(lower|upper|btrim|trim|ltrim|rtrim|date|date_trunc|extract|coalesce|substring|left|right|length|abs|round)\s*\(([^()]+)\)\s*(?:=|<>|!=|<=|>=|<|>|\bIN\b|\bLIKE\b|\bILIKE\b|~~\*?)/i;
  const fnMatch = fnRegex.exec(strippedLiterals);

  if (fnMatch) {
    const fnName = fnMatch[1]!.toLowerCase();
    const innerArg = fnMatch[2]!.trim();

    const colMatch =
      /(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?([a-zA-Z_][a-zA-Z0-9_]*)(?:::[a-zA-Z0-9_\s]+)?$/.exec(
        innerArg,
      );
    const colName = colMatch?.[1];

    if (colName && !NON_COLUMN_IDENTIFIERS.has(colName.toLowerCase())) {
      const canSuggestExprIndex = IMMUTABLE_EXPRESSION_FUNCTIONS.has(fnName);
      const exprSuggestion = canSuggestExprIndex
        ? buildIndexSuggestion(node.relationName, [`${fnName}(${colName})`])
        : undefined;

      return {
        ruleId: 'NON_SARGABLE_PREDICATE',
        severity: 'warning',
        nodeId: node.id,
        nodeType: node.nodeType,
        relationName: node.relationName,
        title: `Non-SARGable Predicate (${fnName}(${colName})) on "${node.relationName}"`,
        detail: `Applying ${fnName}() directly to column "${colName}" inside Filter ${node.filter} prevents PostgreSQL from using a standard B-Tree index on "${colName}".`,
        recommendation: exprSuggestion
          ? `Rewrite the predicate or create a matching expression index: ${exprSuggestion.sql}`
          : `Rewrite "${fnName}(${colName})" into a range predicate on raw "${colName}" (e.g. col >= start AND col < end) so B-Tree indexes remain usable.`,
        indexSuggestion: exprSuggestion,
      };
    }
  }

  // 2. Implicit/explicit type cast on column LHS: e.g. (user_id)::text = '42'
  const castRegex =
    /\(?(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?([a-zA-Z_][a-zA-Z0-9_]*)\)?::(text|varchar|char|character\s+varying|bpchar|int|int2|int4|int8|integer|bigint|numeric)\b\s*(?:=|<>|!=|<=|>=|<|>|\bIN\b|\bLIKE\b|\bILIKE\b)/i;
  const castMatch = castRegex.exec(strippedLiterals);
  if (castMatch) {
    const colName = castMatch[1]!;
    const castType = castMatch[2]!;
    if (!NON_COLUMN_IDENTIFIERS.has(colName.toLowerCase())) {
      return {
        ruleId: 'NON_SARGABLE_PREDICATE',
        severity: 'warning',
        nodeId: node.id,
        nodeType: node.nodeType,
        relationName: node.relationName,
        title: `Non-SARGable Column Cast (${colName}::${castType}) on "${node.relationName}"`,
        detail: `Casting column "${colName}" to ${castType} in Filter ${node.filter} disables standard B-Tree index lookups.`,
        recommendation: `Cast the parameter/literal to "${colName}"'s native column type instead of casting the column.`,
      };
    }
  }

  return null;
};

const correlatedSubPlanRule: DiagnosticRule = (node, plan) => {
  if (!node.subplanName || !/^SubPlan\b/i.test(node.subplanName)) {
    return null;
  }

  const loops = node.actualLoops ?? 1;
  if (plan.mode === 'analyze') {
    if (loops < 50) {
      return null;
    }
    return {
      ruleId: 'CORRELATED_SUBPLAN',
      severity: loops >= 1000 ? 'critical' : 'warning',
      nodeId: node.id,
      nodeType: node.nodeType,
      relationName: node.relationName,
      title: `Correlated Subquery (${node.subplanName}) executed ${loops.toLocaleString('en-US')} times`,
      detail: `SubPlan re-ran ${loops.toLocaleString('en-US')} times (once per outer row), multiplying total latency.`,
      recommendation:
        'Rewrite the correlated subquery using an explicit JOIN, EXISTS, or LATERAL join so PostgreSQL plans it as a hash/merge operation.',
    };
  }

  if (node.totalCost < 100) {
    return null;
  }

  return {
    ruleId: 'CORRELATED_SUBPLAN',
    severity: 'info',
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: node.relationName,
    title: `Correlated Subquery (${node.subplanName}) detected`,
    detail: `SubPlan is evaluated per outer row (estimated node cost ${node.totalCost.toFixed(1)}).`,
    recommendation:
      'Consider rewriting correlated subqueries as JOIN / EXISTS / LATERAL for predictable performance at scale.',
  };
};

const bitmapLossyBlocksRule: DiagnosticRule = (node, plan) => {
  if (plan.mode !== 'analyze' || node.nodeType !== 'Bitmap Heap Scan') {
    return null;
  }

  const lossy = node.lossyHeapBlocks ?? 0;
  if (lossy <= 0) {
    return null;
  }

  const exact = node.exactHeapBlocks ?? 0;
  const severity: DiagnosticSeverity =
    lossy >= 100 && lossy > exact ? 'critical' : 'warning';

  return {
    ruleId: 'BITMAP_LOSSY_BLOCKS',
    severity,
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: node.relationName,
    title: `Lossy Bitmap Heap Scan on "${node.relationName ?? 'table'}" (${lossy.toLocaleString('en-US')} lossy blocks)`,
    detail: `Bitmap exceeded work_mem (${lossy.toLocaleString('en-US')} lossy page-level blocks vs ${exact.toLocaleString('en-US')} exact tuple blocks), forcing row-by-row rechecks.`,
    recommendation:
      'Increase session/query work_mem so PostgreSQL keeps exact tuple offsets in the bitmap, or add a more selective composite index.',
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
  const severity: DiagnosticSeverity =
    exclusiveRead >= 5000 ? 'critical' : 'warning';

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
  esrCompositeIndexRule,
  nonSargablePredicateRule,
  correlatedSubPlanRule,
  bitmapLossyBlocksRule,
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
