import { InvalidPlanError } from '../../errors/domainErrors.js';
import {
  EMPTY_BUFFERS,
  type ExecutionPlan,
  type PlanNode,
  type SortMetrics,
} from '../../models/executionPlan.js';
import type { ExplainMode } from '../../models/queryRequest.js';

export interface SqliteEqpRow {
  readonly id: number;
  readonly parent: number;
  readonly detail: string;
}

export interface SqliteRawPlanPayload {
  readonly eqpRows: readonly SqliteEqpRow[];
  readonly executionTimeMs?: number | undefined;
  readonly actualRows?: number | undefined;
  readonly databasePath?: string | undefined;
}

interface ParsedSqliteDetail {
  readonly nodeType: string;
  readonly relationName?: string | undefined;
  readonly alias?: string | undefined;
  readonly indexName?: string | undefined;
  readonly indexCond?: string | undefined;
  readonly sort?: SortMetrics | undefined;
}

function parseSqliteDetail(detail: string): ParsedSqliteDetail {
  const clean = detail.trim();

  // USE TEMP B-TREE FOR ORDER BY / GROUP BY / DISTINCT / RIGHT PART OF ORDER BY
  const tempTreeMatch = /^USE\s+TEMP\s+B-TREE\s+FOR\s+(.+)$/i.exec(clean);
  if (tempTreeMatch) {
    const reason = tempTreeMatch[1]!.trim().toUpperCase();
    return {
      nodeType: `Temp B-Tree (${reason})`,
      sort: { sortMethod: `temp B-tree (${reason})` },
    };
  }

  // SEARCH [TABLE] tbl [AS alias] USING (COVERING INDEX | AUTOMATIC ... INDEX | INDEX | INTEGER PRIMARY KEY) [idx] [(cond)]
  const searchMatch =
    /^SEARCH\s+(?:TABLE\s+)?([a-zA-Z0-9_$"[\]]+)(?:\s+AS\s+([a-zA-Z0-9_$"[\]]+))?\s+USING\s+(INTEGER\s+PRIMARY\s+KEY|AUTOMATIC(?:\s+PARTIAL)?\s+COVERING\s+INDEX|COVERING\s+INDEX|INDEX)\s*(?:([a-zA-Z0-9_$"[\]]+))?\s*(?:\(([^)]+)\))?/i.exec(
      clean,
    );
  if (searchMatch) {
    const relationName = searchMatch[1]!.replace(/["`[\]]/g, '');
    const alias = searchMatch[2]?.replace(/["`[\]]/g, '');
    const kind = searchMatch[3]!.toUpperCase();
    const indexName = searchMatch[4]?.replace(/["`[\]]/g, '');
    const indexCond = searchMatch[5]?.trim();

    let nodeType = 'Index Search';
    if (kind.includes('INTEGER PRIMARY KEY')) {
      nodeType = 'Primary Key Lookup';
    } else if (kind.includes('AUTOMATIC')) {
      nodeType = 'Auto Transient Index';
    } else if (kind.includes('COVERING INDEX')) {
      nodeType = 'Covering Index Search';
    }

    return {
      nodeType,
      relationName,
      alias,
      indexName,
      indexCond,
    };
  }

  // SCAN [TABLE] tbl [AS alias] [USING ...]
  const scanMatch =
    /^SCAN\s+(?:TABLE\s+)?([a-zA-Z0-9_$"[\]]+)(?:\s+AS\s+([a-zA-Z0-9_$"[\]]+))?(?:\s+USING\s+(.+))?$/i.exec(
      clean,
    );
  if (scanMatch) {
    const relationName = scanMatch[1]!.replace(/["`[\]]/g, '');
    const alias = scanMatch[2]?.replace(/["`[\]]/g, '');
    const usingClause = scanMatch[3]?.trim();

    if (usingClause && /COVERING\s+INDEX/i.test(usingClause)) {
      const idxMatch = /COVERING\s+INDEX\s+([a-zA-Z0-9_$"[\]]+)/i.exec(
        usingClause,
      );
      return {
        nodeType: 'Covering Index Scan',
        relationName,
        alias,
        indexName: idxMatch?.[1]?.replace(/["`[\]]/g, ''),
      };
    }

    if (usingClause && /INDEX\s+/i.test(usingClause)) {
      const idxMatch = /INDEX\s+([a-zA-Z0-9_$"[\]]+)/i.exec(usingClause);
      return {
        nodeType: 'Index Scan',
        relationName,
        alias,
        indexName: idxMatch?.[1]?.replace(/["`[\]]/g, ''),
      };
    }

    if (usingClause && /SUBQUERY|CONSTANT/i.test(usingClause)) {
      return {
        nodeType: 'Subquery Scan',
        relationName,
        alias,
      };
    }

    return {
      nodeType: 'Full Table Scan',
      relationName,
      alias,
    };
  }

  if (/^CO-ROUTINE/i.test(clean)) {
    return { nodeType: 'Co-Routine' };
  }
  if (/^MATERIALIZE/i.test(clean)) {
    return { nodeType: 'Materialize' };
  }
  if (/^COMPOUND\s+QUERY/i.test(clean)) {
    return { nodeType: 'Compound Query' };
  }

  return { nodeType: clean.slice(0, 64) };
}

function isEqpPayload(raw: unknown): raw is SqliteRawPlanPayload {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    Array.isArray((raw as SqliteRawPlanPayload).eqpRows)
  );
}

/**
 * Parses SQLite `EXPLAIN QUERY PLAN` rows (`id`, `parent`, `detail`) + optional execution metrics
 * into the unified domain `ExecutionPlan`.
 */
export function parseSqlitePlan(
  rawPayload: unknown,
  mode: ExplainMode,
): ExecutionPlan {
  if (!isEqpPayload(rawPayload)) {
    throw new InvalidPlanError(
      'SQLite returned an unexpected EXPLAIN QUERY PLAN payload.',
    );
  }

  const rows = rawPayload.eqpRows;
  if (rows.length === 0) {
    throw new InvalidPlanError(
      'SQLite EXPLAIN QUERY PLAN returned zero execution nodes.',
    );
  }

  interface MutableNode {
    readonly rawId: number;
    readonly parentRawId: number;
    readonly parsed: ParsedSqliteDetail;
    readonly children: MutableNode[];
  }

  const byId = new Map<number, MutableNode>();
  const ordered: MutableNode[] = [];

  for (const row of rows) {
    const item: MutableNode = {
      rawId: row.id,
      parentRawId: row.parent,
      parsed: parseSqliteDetail(row.detail),
      children: [],
    };
    byId.set(row.id, item);
    ordered.push(item);
  }

  const topLevel: MutableNode[] = [];
  for (const node of ordered) {
    const parent = node.parentRawId !== 0 ? byId.get(node.parentRawId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      topLevel.push(node);
    }
  }

  const isAnalyze = mode === 'analyze';
  const buildNode = (item: MutableNode, id: string, isRoot: boolean): PlanNode => ({
    id,
    nodeType: item.parsed.nodeType,
    relationName: item.parsed.relationName,
    alias: item.parsed.alias,
    indexName: item.parsed.indexName,
    indexCond: item.parsed.indexCond,
    sort: item.parsed.sort,
    startupCost: 0,
    totalCost: 0,
    planRows: 0,
    planWidth: 0,
    actualTotalTimeMs: isAnalyze && isRoot ? rawPayload.executionTimeMs : undefined,
    actualRows: isAnalyze && isRoot ? rawPayload.actualRows : undefined,
    actualLoops: isAnalyze && isRoot ? 1 : undefined,
    inclusiveTimeMs: isAnalyze && isRoot ? rawPayload.executionTimeMs : undefined,
    parallelAware: false,
    buffers: EMPTY_BUFFERS,
    children: item.children.map((child, idx) =>
      buildNode(child, `${id}.${idx}`, false),
    ),
  });

  const root: PlanNode =
    topLevel.length === 1
      ? buildNode(topLevel[0]!, '0', true)
      : {
          id: '0',
          nodeType: 'Query Plan',
          startupCost: 0,
          totalCost: 0,
          planRows: 0,
          planWidth: 0,
          actualTotalTimeMs: isAnalyze ? rawPayload.executionTimeMs : undefined,
          actualRows: isAnalyze ? rawPayload.actualRows : undefined,
          actualLoops: isAnalyze ? 1 : undefined,
          inclusiveTimeMs: isAnalyze ? rawPayload.executionTimeMs : undefined,
          parallelAware: false,
          buffers: EMPTY_BUFFERS,
          children: topLevel.map((item, idx) =>
            buildNode(item, `0.${idx}`, false),
          ),
        };

  return {
    engine: 'sqlite',
    mode,
    root,
    executionTimeMs: isAnalyze ? rawPayload.executionTimeMs : undefined,
    totalBuffers: EMPTY_BUFFERS,
    rawJson: rawPayload,
  };
}
