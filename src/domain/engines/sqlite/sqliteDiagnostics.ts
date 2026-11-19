import type {
  DiagnosticFinding,
  DiagnosticSeverity,
} from '../../models/diagnostic.js';
import type { ExecutionPlan } from '../../models/executionPlan.js';
import {
  analyzePlanWithRules,
  buildIndexSuggestion,
  type DiagnosticConfig,
  type DiagnosticRule,
} from '../../services/diagnosticEngine.js';
import { extractQueryIndexHintColumns } from '../sqlHintUtils.js';

const sqliteFullTableScanRule: DiagnosticRule = (node, plan, config) => {
  if (
    (node.nodeType !== 'Full Table Scan' &&
      node.nodeType !== 'Auto Transient Index') ||
    !node.relationName
  ) {
    return null;
  }

  const isTransient = node.nodeType === 'Auto Transient Index';
  const hint = extractQueryIndexHintColumns(config.sql, node.alias);
  const candidateCols = [...hint.equalityCols, ...hint.rangeCols];
  const suggestion = buildIndexSuggestion(
    node.relationName,
    candidateCols,
    'CREATE INDEX IF NOT EXISTS',
  );

  const rootRows = plan.root.actualRows;
  const severity: DiagnosticSeverity =
    rootRows !== undefined && rootRows >= config.seqScanRowThreshold
      ? 'critical'
      : 'warning';

  const title = isTransient
    ? `Auto Transient Index built on "${node.relationName}" (missing persistent index)`
    : `SQLite Full Table Scan on "${node.relationName}"`;

  const detail = isTransient
    ? `SQLite built an ephemeral automatic index on "${node.relationName}" in memory for this query because no persistent index matched.`
    : `SQLite EXPLAIN QUERY PLAN reports SCAN on "${node.relationName}" — reading every row sequentially.`;

  return {
    ruleId: 'SQLITE_FULL_TABLE_SCAN',
    severity,
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: node.relationName,
    title,
    detail,
    recommendation: suggestion
      ? `Create a persistent index on "${node.relationName}" (${suggestion.columns.join(', ')}) so SQLite uses SEARCH instead of SCAN.`
      : `Add a selective index on the WHERE / JOIN columns of "${node.relationName}" (and run ANALYZE).`,
    indexSuggestion: suggestion,
  };
};

const sqliteTempBTreeSortRule: DiagnosticRule = (node, plan, config) => {
  if (!node.nodeType.startsWith('Temp B-Tree')) {
    return null;
  }

  const firstScan = plan.root.relationName
    ? plan.root
    : plan.root.children.find((c) => c.relationName);
  const targetTable = firstScan?.relationName;
  const hint = extractQueryIndexHintColumns(config.sql, firstScan?.alias);

  const combined: string[] = [];
  const seen = new Set<string>();
  for (const col of [...hint.equalityCols, ...hint.orderByCols]) {
    const base = col.replace(/\s+(ASC|DESC)$/i, '').trim().toLowerCase();
    if (!base || seen.has(base)) {
      continue;
    }
    seen.add(base);
    combined.push(col);
  }

  const suggestion =
    targetTable && combined.length > 0
      ? buildIndexSuggestion(
          targetTable,
          combined,
          'CREATE INDEX IF NOT EXISTS',
        )
      : undefined;

  return {
    ruleId: 'SQLITE_TEMP_BTREE_SORT',
    severity: 'warning',
    nodeId: node.id,
    nodeType: node.nodeType,
    relationName: targetTable,
    title: `SQLite ${node.nodeType}${targetTable ? ` on "${targetTable}"` : ''}`,
    detail:
      'SQLite had to materialize and sort rows in a temporary B-Tree because no index provides the requested ordering or grouping.',
    recommendation: suggestion
      ? `Create a composite index (${combined.join(', ')}) so SQLite reads rows already sorted.`
      : 'Add a composite index aligned with WHERE equality filters followed by ORDER BY / GROUP BY columns.',
    indexSuggestion: suggestion,
  };
};

const SQLITE_RULES: readonly DiagnosticRule[] = [
  sqliteFullTableScanRule,
  sqliteTempBTreeSortRule,
];

export function analyzeSqlitePlan(
  plan: ExecutionPlan,
  config: DiagnosticConfig,
): readonly DiagnosticFinding[] {
  return analyzePlanWithRules(plan, config, SQLITE_RULES);
}
