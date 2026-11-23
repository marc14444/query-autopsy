import type {
  DiagnosticFinding,
  DiagnosticSeverity,
  IndexSuggestion,
  WorkloadProfile,
} from '../models/diagnostic.js';
import type { ExecutionPlan, PlanNode } from '../models/executionPlan.js';
import { tokenizeSql } from './sqlTokenizer.js';

export interface DiagnosticConfig {
  readonly seqScanRowThreshold: number;
  readonly sql?: string | undefined;
  readonly workloadProfile?: WorkloadProfile | undefined;
}

export type DiagnosticRule = (
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
    )
    .replace(/[`"[\]]/g, '');
}

/**
 * Extracts likely filter column names from an EXPLAIN Filter / attached_condition expression
 * (e.g. "((user_id = 42) AND (o.status = 'pending'::text))" or "((`app`.`orders`.`status` = 'pending'))").
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
    /(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|<>|!=|<=|>=|<|>|\bIS\b|\bIN\b|\bLIKE\b|\bILIKE\b|\bBETWEEN\b|~~\*?)/gi;

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
    /(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|\bIN\b)/gi;
  const rangeRegex =
    /(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<=|>=|<|>|\bBETWEEN\b)/gi;

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

export function buildIndexSuggestion(
  tableName: string,
  columns: readonly string[],
  createPrefix: string = 'CREATE INDEX CONCURRENTLY',
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
    sql: `${createPrefix} ${indexName} ON ${tableName} (${columnList});`,
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

function collectSubtreeIndexConditions(node: PlanNode): readonly string[] {
  const conds: string[] = [];
  if (node.indexCond) {
    conds.push(node.indexCond);
  }
  if (node.recheckCond) {
    conds.push(node.recheckCond);
  }
  for (const child of node.children) {
    if (
      child.nodeType === 'Bitmap Index Scan' ||
      child.nodeType === 'BitmapAnd' ||
      child.nodeType === 'BitmapOr'
    ) {
      conds.push(...collectSubtreeIndexConditions(child));
    }
  }
  return conds;
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

const ANALYTICS_AGG_NODE_TYPES = new Set([
  'Aggregate',
  'HashAggregate',
  'GroupAggregate',
  'MixedAggregate',
  'WindowAgg',
]);

const HASH_SPILL_NODE_TYPES = new Set([
  'Hash',
  'Hash Join',
  'HashAggregate',
  'MixedAggregate',
]);

const SELECT_LIST_STAR_PREDECESSORS = new Set(['SELECT', 'DISTINCT', ',', '.']);
const SELECT_CLAUSE_TERMINATORS = new Set([
  'FROM',
  'WHERE',
  'GROUP',
  'HAVING',
  'ORDER',
  'LIMIT',
  'FETCH',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'INTO',
  'WINDOW',
  'VALUES',
]);

function planContainsAnalyticsAggregate(node: PlanNode): boolean {
  if (ANALYTICS_AGG_NODE_TYPES.has(node.nodeType)) {
    return true;
  }
  return node.children.some((child) => planContainsAnalyticsAggregate(child));
}

/**
 * Token-aware check for `SELECT *` or `SELECT alias.*` inside any SELECT projection list,
 * safely ignoring `COUNT(*)` and arithmetic multiplication (`price * qty`).
 */
export function hasTopLevelSelectStar(sql: string | undefined): boolean {
  if (!sql || !sql.includes('*')) {
    return false;
  }

  const tokens = tokenizeSql(sql, 'postgresql');
  const inSelectStack: boolean[] = [false];
  let prevTokenUpper = '';

  for (const tok of tokens) {
    if (tok.kind === 'whitespace' || tok.kind === 'comment') {
      continue;
    }
    if (tok.kind === 'semicolon') {
      inSelectStack.length = 1;
      inSelectStack[0] = false;
      prevTokenUpper = '';
      continue;
    }

    const upper = tok.normalized.toUpperCase();
    const depth = inSelectStack.length - 1;

    if (upper === '(') {
      inSelectStack.push(false);
      prevTokenUpper = '(';
      continue;
    }
    if (upper === ')') {
      if (inSelectStack.length > 1) {
        inSelectStack.pop();
      }
      prevTokenUpper = ')';
      continue;
    }

    if (upper === 'SELECT' && tok.subkind === 'word') {
      inSelectStack[depth] = true;
      prevTokenUpper = upper;
      continue;
    }

    if (inSelectStack[depth] && SELECT_CLAUSE_TERMINATORS.has(upper) && tok.subkind === 'word') {
      inSelectStack[depth] = false;
      prevTokenUpper = upper;
      continue;
    }

    if (
      inSelectStack[depth] &&
      upper === '*' &&
      SELECT_LIST_STAR_PREDECESSORS.has(prevTokenUpper)
    ) {
      return true;
    }

    prevTokenUpper = upper;
  }

  return false;
}

const seqScanRule: DiagnosticRule = (node, plan, config) => {
  if (node.nodeType !== 'Seq Scan' || !node.relationName) {
    return null;
  }

  // In explicit analytics workload mode, an unfiltered Seq Scan feeding an Aggregate/Window
  // is usually an intentional full-fact rollup where recommending an OLTP B-Tree index is noise.
  if (
    config.workloadProfile === 'analytics' &&
    !node.filter &&
    planContainsAnalyticsAggregate(plan.root)
  ) {
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
  const indexCondStrings = collectSubtreeIndexConditions(scanNode);
  const indexEqualityCols: string[] = [];
  const indexRangeCols: string[] = [];
  for (const cond of indexCondStrings) {
    const preds = classifyPredicateColumns(cond, scanNode.alias);
    indexEqualityCols.push(...preds.equalityCols);
    indexRangeCols.push(...preds.rangeCols);
  }

  const eqCols = Array.from(
    new Set([...indexEqualityCols, ...filterPreds.equalityCols]),
  );
  const rangeCols = Array.from(
    new Set([...indexRangeCols, ...filterPreds.rangeCols]),
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
    severity:
      scanNode.nodeType === 'Seq Scan' ||
      sortRows >= config.seqScanRowThreshold
        ? 'warning'
        : 'info',
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

const diskSpillRule: DiagnosticRule = (node) => {
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

  if (HASH_SPILL_NODE_TYPES.has(node.nodeType)) {
    const batchSummary = isMultiBatchHash
      ? `${node.hashBatches} hash batches`
      : `${exclusiveTempWritten} temp blocks`;
    return {
      ruleId: 'HASH_AGG_OR_JOIN_DISK_SPILL',
      severity: 'critical',
      nodeId: node.id,
      nodeType: node.nodeType,
      relationName: node.relationName,
      title: `Analytical Hash Disk Spill in ${node.nodeType} (${sizeInfo})`,
      detail: `${node.nodeType} overflowed work_mem into ${batchSummary}, causing heavy temp disk reads/writes during analytical joining or grouping.`,
      recommendation:
        'Pre-filter input rows with partition/time bounds before joining or aggregating, project fewer columns (avoid SELECT *), or increase session work_mem for analytical jobs.',
    };
  }

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

const selectStarWideScanRule: DiagnosticRule = (node, plan, config) => {
  if (
    !node.relationName ||
    (node.nodeType !== 'Seq Scan' &&
      node.nodeType !== 'Bitmap Heap Scan' &&
      node.nodeType !== 'Index Scan')
  ) {
    return null;
  }

  if (!hasTopLevelSelectStar(config.sql)) {
    return null;
  }

  const minWidthBytes = config.workloadProfile === 'analytics' ? 96 : 180;
  if (node.planWidth < minWidthBytes) {
    return null;
  }

  const loops = node.actualLoops ?? 1;
  const rows =
    plan.mode === 'analyze' && node.actualRows !== undefined
      ? Math.round((node.actualRows + (node.rowsRemovedByFilter ?? 0)) * loops)
      : Math.round(node.planRows * loops);

  if (rows < config.seqScanRowThreshold) {
    return null;
  }

  const estimatedBytes = rows * node.planWidth;
  const estimatedMb = (estimatedBytes / (1024 * 1024)).toFixed(1);
  const severity: DiagnosticSeverity =
    estimatedBytes >= 50 * 1024 * 1024 ||
    (rows >= 100_000 && node.planWidth >= 256)
      ? 'critical'
      : 'warning';

  return {
    ruleId: 'SELECT_STAR_WIDE_SCAN',
    severity,
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: node.relationName,
    title: `Wide SELECT * Scan on "${node.relationName}" (${node.planWidth} B/row, ~${estimatedMb} MB)`,
    detail: `Query uses SELECT * while scanning ${rows.toLocaleString('en-US')} wide rows (~${node.planWidth} bytes/row), inflating I/O, hash table memory, and TOAST/network payload.`,
    recommendation: `Replace SELECT * with only the explicit columns needed by downstream queries or aggregations on "${node.relationName}".`,
  };
};

function findChildLeafScan(node: PlanNode): PlanNode | undefined {
  if (
    node.relationName &&
    (node.nodeType === 'Seq Scan' ||
      node.nodeType === 'Index Scan' ||
      node.nodeType === 'Index Only Scan' ||
      node.nodeType === 'Bitmap Heap Scan')
  ) {
    return node;
  }
  for (const child of node.children) {
    const found = findChildLeafScan(child);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function extractPartitionBaseName(relationName: string): string | undefined {
  const match =
    /^([a-zA-Z][a-zA-Z0-9_]*?)(?:_p?\d+|_\d{4}(?:[_-]?\d{2})?(?:[_-]?\d{2})?|_default)$/i.exec(
      relationName,
    );
  return match?.[1]?.toLowerCase();
}

const missingPartitionPruningRule: DiagnosticRule = (node, plan, config) => {
  if (node.nodeType !== 'Append' && node.nodeType !== 'Merge Append') {
    return null;
  }

  if (node.subplansRemoved !== undefined && node.subplansRemoved > 0) {
    return null;
  }

  const childScans = node.children
    .map((child) => findChildLeafScan(child))
    .filter((scan): scan is PlanNode => scan !== undefined && Boolean(scan.relationName));

  if (childScans.length < 2) {
    return null;
  }

  const explicitZeroPruned = node.subplansRemoved === 0;
  let sharedPartitionedGroup = false;
  if (!explicitZeroPruned && childScans.length >= 3) {
    const bases = new Set(
      childScans
        .map((scan) => extractPartitionBaseName(scan.relationName!))
        .filter((base): base is string => Boolean(base)),
    );
    sharedPartitionedGroup =
      bases.size === 1 &&
      childScans.every((scan) => Boolean(extractPartitionBaseName(scan.relationName!)));
  }

  if (!explicitZeroPruned && !sharedPartitionedGroup) {
    return null;
  }

  const totalRows = childScans.reduce((sum, scan) => {
    const loops = scan.actualLoops ?? 1;
    const rows =
      plan.mode === 'analyze' && scan.actualRows !== undefined
        ? (scan.actualRows + (scan.rowsRemovedByFilter ?? 0)) * loops
        : scan.planRows * loops;
    return sum + Math.round(rows);
  }, 0);

  if (totalRows < config.seqScanRowThreshold && childScans.length < 4) {
    return null;
  }

  const severity: DiagnosticSeverity =
    childScans.length >= 12 || totalRows >= config.seqScanRowThreshold * 50
      ? 'critical'
      : 'warning';
  const baseLabel =
    extractPartitionBaseName(childScans[0]!.relationName!) ??
    childScans[0]!.relationName!;

  return {
    ruleId: 'MISSING_PARTITION_PRUNING',
    severity,
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: baseLabel,
    title: `Partition Pruning Missed Across ${childScans.length} Partitions (${totalRows.toLocaleString('en-US')} rows)`,
    detail: `${node.nodeType} scanned ${childScans.length} child partitions under "${baseLabel}" with 0 subplans removed (missing or non-SARGable partition key filter).`,
    recommendation:
      'Filter directly on the partition column using raw bounds (e.g. WHERE event_date >= $1 AND event_date < $2 without DATE_TRUNC/EXTRACT wrappers) so PostgreSQL prunes partitions before scanning.',
  };
};

function effectiveNodeRows(node: PlanNode, plan: ExecutionPlan): number {
  const loops = node.actualLoops ?? 1;
  if (plan.mode === 'analyze' && node.actualRows !== undefined) {
    return Math.round(node.actualRows * loops);
  }
  return Math.round(node.planRows);
}

function isCartesianNestedLoop(
  node: PlanNode,
  plan: ExecutionPlan,
  config: DiagnosticConfig,
): boolean {
  if (
    node.nodeType !== 'Nested Loop' ||
    (node.joinType !== undefined && node.joinType !== 'Inner') ||
    node.children.length !== 2 ||
    node.filter
  ) {
    return false;
  }

  const outer = node.children[0]!;
  const inner = node.children[1]!;
  if (inner.indexCond || inner.recheckCond || inner.filter) {
    return false;
  }

  const outerRows = effectiveNodeRows(outer, plan);
  const innerPerLoopRows =
    plan.mode === 'analyze' && inner.actualRows !== undefined
      ? Math.round(inner.actualRows)
      : Math.round(inner.planRows);

  if (outerRows < 50 || innerPerLoopRows < 50) {
    return false;
  }

  const outRows = effectiveNodeRows(node, plan);
  const cartesianThreshold = Math.max(config.seqScanRowThreshold * 5, 5000);
  return outRows >= cartesianThreshold && outRows >= outerRows * innerPerLoopRows * 0.8;
}

const cartesianOrUnboundedJoinRule: DiagnosticRule = (node, plan, config) => {
  if (!isCartesianNestedLoop(node, plan, config)) {
    return null;
  }

  const outer = node.children[0]!;
  const inner = node.children[1]!;
  const outRows = effectiveNodeRows(node, plan);

  return {
    ruleId: 'CARTESIAN_OR_UNBOUNDED_JOIN',
    severity: outRows >= 100_000 ? 'critical' : 'warning',
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: inner.relationName ?? outer.relationName,
    title: `Cartesian / Unbounded Join (${outRows.toLocaleString('en-US')} output rows)`,
    detail: `Nested Loop produced ${outRows.toLocaleString('en-US')} rows across two unindexed multi-row inputs without an inner join or index condition.`,
    recommendation:
      'Add an explicit JOIN ON equality condition and index the join keys so PostgreSQL can switch to a Hash Join or Merge Join.',
  };
};

export { classifyPredicateColumns };

export const rowMisestimateRule: DiagnosticRule = (node, plan) => {
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

export const nestedLoopHighLoopsRule: DiagnosticRule = (
  node,
  plan,
  config,
) => {
  if (plan.mode !== 'analyze' || node.nodeType !== 'Nested Loop') {
    return null;
  }
  if (isCartesianNestedLoop(node, plan, config)) {
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
  diskSpillRule,
  selectStarWideScanRule,
  missingPartitionPruningRule,
  cartesianOrUnboundedJoinRule,
  rowMisestimateRule,
  lowCacheHitRule,
  nestedLoopHighLoopsRule,
];

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function analyzePlanWithRules(
  plan: ExecutionPlan,
  config: DiagnosticConfig,
  rules: readonly DiagnosticRule[],
): readonly DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  const visit = (node: PlanNode): void => {
    for (const rule of rules) {
      const finding = rule(node, plan, config);
      if (finding) {
        findings.push(finding);
      }
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(plan.root);
  return findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

export function analyzeExecutionPlan(
  plan: ExecutionPlan,
  config: DiagnosticConfig,
): readonly DiagnosticFinding[] {
  return analyzePlanWithRules(plan, config, RULES);
}
