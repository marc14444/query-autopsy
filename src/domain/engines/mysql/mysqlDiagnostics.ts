import type {
  DiagnosticFinding,
  DiagnosticSeverity,
} from '../../models/diagnostic.js';
import type { ExecutionPlan, PlanNode } from '../../models/executionPlan.js';
import {
  analyzePlanWithRules,
  buildIndexSuggestion,
  classifyPredicateColumns,
  type DiagnosticConfig,
  type DiagnosticRule,
  extractFilterColumns,
  nestedLoopHighLoopsRule,
  rowMisestimateRule,
} from '../../services/diagnosticEngine.js';
import { extractQueryIndexHintColumns } from '../sqlHintUtils.js';

function collectChildFilters(node: PlanNode): string[] {
  const filters: string[] = [];
  if (node.filter) {
    filters.push(node.filter);
  }
  for (const child of node.children) {
    filters.push(...collectChildFilters(child));
  }
  return filters;
}

function findScannedRelation(node: PlanNode): string | undefined {
  if (node.relationName) {
    return node.relationName;
  }
  for (const child of node.children) {
    const rel = findScannedRelation(child);
    if (rel) {
      return rel;
    }
  }
  return undefined;
}

const mysqlFullTableScanRule: DiagnosticRule = (node, plan, config) => {
  if (node.nodeType !== 'Table Scan (ALL)' || !node.relationName) {
    return null;
  }

  const loops = node.actualLoops ?? 1;
  const scannedRows =
    plan.mode === 'analyze' && node.actualRows !== undefined
      ? Math.round(node.actualRows * loops)
      : Math.round(node.planRows);

  if (scannedRows < config.seqScanRowThreshold) {
    return null;
  }

  const filterColumns = node.filter
    ? extractFilterColumns(node.filter, node.alias)
    : (() => {
        const hint = extractQueryIndexHintColumns(config.sql, node.alias);
        return [...hint.equalityCols, ...hint.rangeCols];
      })();

  const suggestion = buildIndexSuggestion(
    node.relationName,
    filterColumns,
    'CREATE INDEX',
  );

  const severity: DiagnosticSeverity =
    scannedRows >= config.seqScanRowThreshold * 10 ||
    (node.exclusiveTimePercent !== undefined && node.exclusiveTimePercent >= 40)
      ? 'critical'
      : 'warning';

  return {
    ruleId: 'MYSQL_FULL_TABLE_SCAN',
    severity,
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: node.relationName,
    title: `Full Table Scan (ALL) on "${node.relationName}" (${scannedRows.toLocaleString('en-US')} rows)`,
    detail: `MySQL scanned ${scannedRows.toLocaleString('en-US')} rows in "${node.relationName}" without using an index (cost ${node.totalCost.toFixed(1)}).`,
    recommendation: suggestion
      ? `Add an index on (${suggestion.columns.join(', ')}) so MySQL can use an index lookup/range scan.`
      : 'Add a selective B-Tree index matching your WHERE or JOIN columns.',
    indexSuggestion: suggestion,
  };
};

const mysqlFilesortRule: DiagnosticRule = (node, plan, config) => {
  if (node.nodeType !== 'Filesort' && node.sort?.sortMethod !== 'filesort') {
    return null;
  }

  const childRows = Math.max(
    node.planRows,
    node.actualRows ?? 0,
    ...node.children.map((c) => Math.max(c.planRows, c.actualRows ?? 0)),
  );
  const sortThreshold = Math.max(100, Math.floor(config.seqScanRowThreshold / 5));

  if (plan.mode === 'estimate' && childRows < sortThreshold && node.totalCost < 10) {
    return null;
  }

  const targetTable = findScannedRelation(node);
  const hint = extractQueryIndexHintColumns(config.sql);
  const childFilterCols = collectChildFilters(node).flatMap((f) => {
    const classified = classifyPredicateColumns(f);
    return [...classified.equalityCols];
  });
  const equalityCols =
    childFilterCols.length > 0 ? childFilterCols : [...hint.equalityCols];

  const sortKeys = node.sort?.sortKey?.length
    ? node.sort.sortKey.map((k) => k.replace(/^[a-zA-Z_][a-zA-Z0-9_]*\./, ''))
    : [...hint.orderByCols];

  const orderedCols: string[] = [];
  const seen = new Set<string>();
  for (const col of [...equalityCols, ...sortKeys]) {
    const base = col.replace(/\s+(ASC|DESC)$/i, '').trim().toLowerCase();
    if (!base || seen.has(base)) {
      continue;
    }
    seen.add(base);
    orderedCols.push(col);
  }

  const suggestion =
    targetTable && orderedCols.length > 0
      ? buildIndexSuggestion(targetTable, orderedCols, 'CREATE INDEX')
      : undefined;

  return {
    ruleId: 'MYSQL_USING_FILESORT',
    severity:
      childRows >= config.seqScanRowThreshold ||
      (node.exclusiveTimePercent !== undefined && node.exclusiveTimePercent >= 35)
        ? 'critical'
        : 'warning',
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: targetTable,
    title: `MySQL Using filesort${targetTable ? ` on "${targetTable}"` : ''}`,
    detail: `Query requires an extra sorting pass over ~${Math.round(childRows).toLocaleString('en-US')} rows instead of reading rows pre-ordered from an index.`,
    recommendation: suggestion
      ? `Create a composite index ordered Equality -> Sort (${orderedCols.join(', ')}) to eliminate the filesort pass.`
      : 'Align your index key order with Equality WHERE filters followed by ORDER BY / GROUP BY columns.',
    indexSuggestion: suggestion,
  };
};

const mysqlTemporaryTableRule: DiagnosticRule = (node) => {
  if (node.nodeType !== 'Temporary Table') {
    return null;
  }

  const targetTable = findScannedRelation(node);
  return {
    ruleId: 'MYSQL_USING_TEMPORARY',
    severity: 'warning',
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: targetTable,
    title: `MySQL Using temporary table${targetTable ? ` for "${targetTable}"` : ''}`,
    detail:
      'MySQL created an internal temporary table (often due to GROUP BY / DISTINCT / ORDER BY across unindexed or non-covering columns).',
    recommendation:
      'Add a covering composite index matching the GROUP BY / ORDER BY columns, or project only required columns.',
  };
};

const MYSQL_RULES: readonly DiagnosticRule[] = [
  mysqlFullTableScanRule,
  mysqlFilesortRule,
  mysqlTemporaryTableRule,
  rowMisestimateRule,
  nestedLoopHighLoopsRule,
];

export function analyzeMySqlPlan(
  plan: ExecutionPlan,
  config: DiagnosticConfig,
): readonly DiagnosticFinding[] {
  return analyzePlanWithRules(plan, config, MYSQL_RULES);
}
