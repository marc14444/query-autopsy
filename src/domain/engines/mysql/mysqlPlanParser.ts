import { InvalidPlanError } from '../../errors/domainErrors.js';
import {
  EMPTY_BUFFERS,
  finalizeNodeTimingMetrics,
  type ExecutionPlan,
  type PlanNode,
  type SortMetrics,
} from '../../models/executionPlan.js';
import type { ExplainMode } from '../../models/queryRequest.js';

type JsonRecord = Record<string, unknown>;

function isRecord(val: unknown): val is JsonRecord {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function readNum(rec: JsonRecord, key: string): number | undefined {
  const val = rec[key];
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readStr(rec: JsonRecord, key: string): string | undefined {
  const val = rec[key];
  return typeof val === 'string' && val.trim() !== '' ? val : undefined;
}

function mapMysqlAccessType(
  accessType: string | undefined,
  usingIndex: boolean,
): string {
  switch (accessType?.toLowerCase()) {
    case 'all':
      return 'Table Scan (ALL)';
    case 'index':
      return usingIndex ? 'Covering Index Scan' : 'Full Index Scan';
    case 'range':
      return 'Index Range Scan';
    case 'index_merge':
      return 'Index Merge';
    case 'ref':
    case 'eq_ref':
    case 'const':
    case 'system':
    case 'ref_or_null':
    case 'fulltext':
      return usingIndex ? 'Covering Index Lookup' : 'Index Lookup';
    default:
      return accessType ? `Table Access (${accessType})` : 'Table Access';
  }
}

function parseMysqlTableNode(
  table: JsonRecord,
  idPrefix: string,
): PlanNode {
  const accessType = readStr(table, 'access_type');
  const usingIndex = table['using_index'] === true;
  const costInfo = isRecord(table['cost_info']) ? table['cost_info'] : undefined;
  const readCost = costInfo ? (readNum(costInfo, 'read_cost') ?? 0) : 0;
  const evalCost = costInfo ? (readNum(costInfo, 'eval_cost') ?? 0) : 0;
  const prefixCost = costInfo ? readNum(costInfo, 'prefix_cost') : undefined;
  const totalCost = prefixCost ?? readCost + evalCost;

  const children: PlanNode[] = [];
  if (isRecord(table['materialized_from_subquery'])) {
    const subBlock = table['materialized_from_subquery']['query_block'];
    if (isRecord(subBlock)) {
      children.push(parseMysqlQueryBlock(subBlock, `${idPrefix}.0`));
    }
  }

  const attachedSubs = Array.isArray(table['attached_subqueries'])
    ? table['attached_subqueries']
    : [];
  attachedSubs.forEach((sub, idx) => {
    if (isRecord(sub) && isRecord(sub['query_block'])) {
      children.push(
        parseMysqlQueryBlock(sub['query_block'], `${idPrefix}.${children.length + idx}`),
      );
    }
  });

  return {
    id: idPrefix,
    nodeType: mapMysqlAccessType(accessType, usingIndex),
    relationName: readStr(table, 'table_name'),
    indexName: readStr(table, 'key'),
    startupCost: readCost,
    totalCost,
    planRows:
      readNum(table, 'rows_examined_per_scan') ??
      readNum(table, 'rows_produced_per_join') ??
      0,
    planWidth: 0,
    filter: readStr(table, 'attached_condition'),
    parallelAware: false,
    buffers: EMPTY_BUFFERS,
    children,
  };
}

function assignTreeIds(node: PlanNode, id: string): PlanNode {
  return {
    ...node,
    id,
    children: node.children.map((child, idx) =>
      assignTreeIds(child, `${id}.${idx}`),
    ),
  };
}

function extractNestedLoopChildren(
  items: readonly unknown[],
  tempPrefix: string,
): PlanNode[] {
  const children: PlanNode[] = [];
  items.forEach((entry, idx) => {
    if (!isRecord(entry)) {
      return;
    }
    if (isRecord(entry['table'])) {
      children.push(parseMysqlTableNode(entry['table'], `${tempPrefix}.${idx}`));
    }
  });
  return children;
}

function wrapOperations(
  baseNodes: readonly PlanNode[],
  wrapper: JsonRecord,
  wrapperLabel: string,
  idPrefix: string,
): PlanNode {
  const joined: PlanNode =
    baseNodes.length === 1
      ? baseNodes[0]!
      : {
          id: idPrefix,
          nodeType: 'Nested Loop',
          startupCost: 0,
          totalCost: Math.max(...baseNodes.map((n) => n.totalCost), 0),
          planRows: baseNodes[baseNodes.length - 1]?.planRows ?? 0,
          planWidth: 0,
          parallelAware: false,
          buffers: EMPTY_BUFFERS,
          children: [...baseNodes],
        };

  let current = joined;
  const usingTemporary = wrapper['using_temporary_table'] === true;
  const usingFilesort = wrapper['using_filesort'] === true;

  if (usingTemporary) {
    current = {
      id: idPrefix,
      nodeType: 'Temporary Table',
      parentRelationship: wrapperLabel,
      startupCost: current.startupCost,
      totalCost: current.totalCost,
      planRows: current.planRows,
      planWidth: 0,
      parallelAware: false,
      buffers: EMPTY_BUFFERS,
      children: [current],
    };
  }

  if (usingFilesort) {
    const sortMetrics: SortMetrics = { sortMethod: 'filesort' };
    current = {
      id: idPrefix,
      nodeType: 'Filesort',
      parentRelationship: wrapperLabel,
      startupCost: current.totalCost,
      totalCost: current.totalCost,
      planRows: current.planRows,
      planWidth: 0,
      parallelAware: false,
      buffers: EMPTY_BUFFERS,
      sort: sortMetrics,
      children: [current],
    };
  }

  return current;
}

function parseMysqlQueryBlock(
  queryBlock: JsonRecord,
  idPrefix: string,
): PlanNode {
  const blockCost = isRecord(queryBlock['cost_info'])
    ? readNum(queryBlock['cost_info'], 'query_cost')
    : undefined;

  let rootNode: PlanNode | undefined;

  const operationKeys = [
    'ordering_operation',
    'grouping_operation',
    'duplicates_removal',
    'buffer_result',
  ] as const;

  for (const opKey of operationKeys) {
    const op = queryBlock[opKey];
    if (!isRecord(op)) {
      continue;
    }

    let innerNodes: PlanNode[] = [];
    if (Array.isArray(op['nested_loop'])) {
      innerNodes = extractNestedLoopChildren(op['nested_loop'], idPrefix);
    } else if (isRecord(op['table'])) {
      innerNodes = [parseMysqlTableNode(op['table'], `${idPrefix}.0`)];
    } else if (isRecord(op['grouping_operation'])) {
      innerNodes = [
        parseMysqlQueryBlock(
          { grouping_operation: op['grouping_operation'] },
          `${idPrefix}.0`,
        ),
      ];
    } else if (isRecord(op['duplicates_removal'])) {
      innerNodes = [
        parseMysqlQueryBlock(
          { duplicates_removal: op['duplicates_removal'] },
          `${idPrefix}.0`,
        ),
      ];
    } else if (isRecord(op['query_block'])) {
      innerNodes = [parseMysqlQueryBlock(op['query_block'], `${idPrefix}.0`)];
    }

    if (innerNodes.length > 0) {
      rootNode = wrapOperations(innerNodes, op, opKey, idPrefix);
      break;
    }
  }

  if (!rootNode && Array.isArray(queryBlock['nested_loop'])) {
    const nodes = extractNestedLoopChildren(queryBlock['nested_loop'], idPrefix);
    if (nodes.length === 1) {
      rootNode = nodes[0];
    } else if (nodes.length > 1) {
      rootNode = {
        id: idPrefix,
        nodeType: 'Nested Loop',
        startupCost: 0,
        totalCost: blockCost ?? Math.max(...nodes.map((n) => n.totalCost), 0),
        planRows: nodes[nodes.length - 1]?.planRows ?? 0,
        planWidth: 0,
        parallelAware: false,
        buffers: EMPTY_BUFFERS,
        children: nodes,
      };
    }
  }

  if (!rootNode && isRecord(queryBlock['table'])) {
    rootNode = parseMysqlTableNode(queryBlock['table'], idPrefix);
  }

  if (!rootNode && isRecord(queryBlock['union_result'])) {
    const unionRes = queryBlock['union_result'];
    const specs = Array.isArray(unionRes['query_specifications'])
      ? unionRes['query_specifications']
      : [];
    const unionChildren: PlanNode[] = specs
      .filter((s): s is JsonRecord => isRecord(s) && isRecord(s['query_block']))
      .map((s, idx) =>
        parseMysqlQueryBlock(
          s['query_block'] as JsonRecord,
          `${idPrefix}.${idx}`,
        ),
      );
    rootNode = {
      id: idPrefix,
      nodeType: 'Union Result',
      startupCost: 0,
      totalCost: blockCost ?? 0,
      planRows: unionChildren.reduce((sum, c) => sum + c.planRows, 0),
      planWidth: 0,
      parallelAware: false,
      buffers: EMPTY_BUFFERS,
      children: unionChildren,
    };
  }

  if (!rootNode) {
    rootNode = {
      id: idPrefix,
      nodeType: 'Query Block',
      startupCost: 0,
      totalCost: blockCost ?? 0,
      planRows: 0,
      planWidth: 0,
      parallelAware: false,
      buffers: EMPTY_BUFFERS,
      children: [],
    };
  }

  if (blockCost !== undefined && blockCost > rootNode.totalCost) {
    rootNode = {
      ...rootNode,
      totalCost: blockCost,
    };
  }

  return assignTreeIds(rootNode, idPrefix);
}

interface ParsedMysqlTreeLine {
  readonly indent: number;
  readonly nodeType: string;
  readonly relationName?: string | undefined;
  readonly indexName?: string | undefined;
  readonly filter?: string | undefined;
  readonly sort?: SortMetrics | undefined;
  readonly startupCost: number;
  readonly totalCost: number;
  readonly planRows: number;
  readonly actualStartupTimeMs?: number | undefined;
  readonly actualTotalTimeMs?: number | undefined;
  readonly actualRows?: number | undefined;
  readonly actualLoops?: number | undefined;
  readonly children: ParsedMysqlTreeLine[];
}

function classifyTreeDescription(desc: string): {
  readonly nodeType: string;
  readonly relationName?: string | undefined;
  readonly indexName?: string | undefined;
  readonly filter?: string | undefined;
  readonly sort?: SortMetrics | undefined;
} {
  const clean = desc.trim();

  if (/^Filter:/i.test(clean)) {
    return {
      nodeType: 'Filter',
      filter: clean.slice('Filter:'.length).trim(),
    };
  }

  if (/^Sort:/i.test(clean)) {
    const sortKeys = clean
      .slice('Sort:'.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      nodeType: 'Filesort',
      sort: {
        sortKey: sortKeys.length > 0 ? sortKeys : undefined,
        sortMethod: 'filesort',
      },
    };
  }

  const scanMatch =
    /^(Table scan|Full scan|Covering index scan|Index scan|Index range scan|Covering index range scan|Index lookup|Single-row index lookup|Covering index lookup|Single-row covering index lookup)\s+on\s+`?([a-zA-Z0-9_$]+)`?(?:\s+using\s+`?([a-zA-Z0-9_$]+)`?)?/i.exec(
      clean,
    );
  if (scanMatch) {
    const op = scanMatch[1]!.toLowerCase();
    const relationName = scanMatch[2];
    const indexName = scanMatch[3];
    let nodeType = scanMatch[1]!;
    if (op === 'table scan' || op === 'full scan') {
      nodeType = 'Table Scan (ALL)';
    } else if (op.includes('covering index scan')) {
      nodeType = 'Covering Index Scan';
    } else if (op === 'index scan') {
      nodeType = 'Full Index Scan';
    } else if (op.includes('range scan')) {
      nodeType = 'Index Range Scan';
    } else if (op.includes('covering index lookup')) {
      nodeType = 'Covering Index Lookup';
    } else if (op.includes('index lookup')) {
      nodeType = 'Index Lookup';
    }
    return {
      nodeType,
      relationName,
      indexName,
    };
  }

  if (/^Nested loop/i.test(clean)) {
    return { nodeType: 'Nested Loop' };
  }
  if (/hash join/i.test(clean)) {
    return { nodeType: 'Hash Join' };
  }
  if (/temporary table|materialize/i.test(clean)) {
    return { nodeType: 'Temporary Table' };
  }
  if (/^Limit:/i.test(clean)) {
    return { nodeType: 'Limit' };
  }
  if (/aggregate/i.test(clean)) {
    return { nodeType: 'Aggregate' };
  }

  const colonIdx = clean.indexOf(':');
  return {
    nodeType:
      colonIdx > 0 ? clean.slice(0, colonIdx).trim() : clean.slice(0, 60),
  };
}

function parseMysqlTreeText(
  treeText: string,
  mode: ExplainMode,
): ExecutionPlan {
  const rawLines = treeText
    .split(/\r?\n/)
    .filter((line) => line.includes('->'));

  if (rawLines.length === 0) {
    throw new InvalidPlanError(
      'MySQL EXPLAIN ANALYZE output did not contain any "-> " execution nodes.',
    );
  }

  const parsedLines: ParsedMysqlTreeLine[] = [];
  const stack: ParsedMysqlTreeLine[] = [];

  for (const line of rawLines) {
    const arrowIdx = line.indexOf('->');
    const indent = arrowIdx;
    let body = line.slice(arrowIdx + 2).trim();

    let actualStartupTimeMs: number | undefined;
    let actualTotalTimeMs: number | undefined;
    let actualRows: number | undefined;
    let actualLoops: number | undefined;

    if (/\(never executed\)\s*$/i.test(body)) {
      actualStartupTimeMs = 0;
      actualTotalTimeMs = 0;
      actualRows = 0;
      actualLoops = 0;
      body = body.replace(/\(never executed\)\s*$/i, '').trim();
    } else {
      const actualMatch =
        /\(actual(?:\s+time=([0-9.eE+-]+)\.\.([0-9.eE+-]+))?\s+rows=([0-9.eE+-]+)\s+loops=(\d+)\)\s*$/i.exec(
          body,
        );
      if (actualMatch) {
        if (actualMatch[1] !== undefined && actualMatch[2] !== undefined) {
          actualStartupTimeMs = Number(actualMatch[1]);
          actualTotalTimeMs = Number(actualMatch[2]);
        }
        actualRows = Number(actualMatch[3]);
        actualLoops = Number(actualMatch[4]);
        body = body.slice(0, actualMatch.index).trim();
      }
    }

    let startupCost = 0;
    let totalCost = 0;
    let planRows = 0;
    const costMatch =
      /\(cost=(?:([0-9.eE+-]+)\.\.)?([0-9.eE+-]+)\s+rows=([0-9.eE+-]+)\)\s*$/i.exec(
        body,
      );
    if (costMatch) {
      startupCost = costMatch[1] !== undefined ? Number(costMatch[1]) : 0;
      totalCost = Number(costMatch[2]);
      planRows = Number(costMatch[3]);
      body = body.slice(0, costMatch.index).trim();
    }

    const meta = classifyTreeDescription(body);
    const node: ParsedMysqlTreeLine = {
      indent,
      nodeType: meta.nodeType,
      relationName: meta.relationName,
      indexName: meta.indexName,
      filter: meta.filter,
      sort: meta.sort,
      startupCost,
      totalCost,
      planRows,
      actualStartupTimeMs,
      actualTotalTimeMs,
      actualRows,
      actualLoops,
      children: [],
    };

    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
    } else {
      parsedLines.push(node);
    }
    stack.push(node);
  }

  const toPlanNode = (item: ParsedMysqlTreeLine, id: string): PlanNode => ({
    id,
    nodeType: item.nodeType,
    relationName: item.relationName,
    indexName: item.indexName,
    startupCost: item.startupCost,
    totalCost: item.totalCost,
    planRows: item.planRows,
    planWidth: 0,
    actualStartupTimeMs: item.actualStartupTimeMs,
    actualTotalTimeMs: item.actualTotalTimeMs,
    actualRows: item.actualRows,
    actualLoops: item.actualLoops,
    filter: item.filter,
    sort: item.sort,
    parallelAware: false,
    buffers: EMPTY_BUFFERS,
    children: item.children.map((c, idx) => toPlanNode(c, `${id}.${idx}`)),
  });

  const baseRoot: PlanNode =
    parsedLines.length === 1
      ? toPlanNode(parsedLines[0]!, '0')
      : {
          id: '0',
          nodeType: 'Query Plan',
          startupCost: 0,
          totalCost: Math.max(...parsedLines.map((l) => l.totalCost), 0),
          planRows: parsedLines[0]?.planRows ?? 0,
          planWidth: 0,
          parallelAware: false,
          buffers: EMPTY_BUFFERS,
          children: parsedLines.map((l, idx) => toPlanNode(l, `0.${idx}`)),
        };

  const withTimings = finalizeNodeTimingMetrics(baseRoot, undefined);
  const executionTimeMs = withTimings.inclusiveTimeMs;
  const root = finalizeNodeTimingMetrics(withTimings, executionTimeMs);

  return {
    engine: 'mysql',
    mode,
    root,
    executionTimeMs,
    totalBuffers: EMPTY_BUFFERS,
    rawJson: treeText,
  };
}

/**
 * Parses MySQL 8+ `EXPLAIN FORMAT=JSON` (estimate) and `EXPLAIN ANALYZE` TREE (analyze) payloads
 * into the unified domain `ExecutionPlan`.
 */
export function parseMySqlPlan(
  rawPayload: unknown,
  mode: ExplainMode,
): ExecutionPlan {
  if (typeof rawPayload === 'string') {
    const trimmed = rawPayload.trim();
    if (trimmed.startsWith('{')) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(trimmed);
      } catch {
        throw new InvalidPlanError('MySQL returned invalid EXPLAIN JSON output.');
      }
      return parseMySqlPlan(decoded, mode);
    }
    return parseMysqlTreeText(trimmed, mode);
  }

  if (isRecord(rawPayload)) {
    if (typeof rawPayload['treeText'] === 'string') {
      return parseMysqlTreeText(rawPayload['treeText'], mode);
    }

    const queryBlock = isRecord(rawPayload['query_block'])
      ? rawPayload['query_block']
      : undefined;
    if (queryBlock) {
      const root = parseMysqlQueryBlock(queryBlock, '0');
      return {
        engine: 'mysql',
        mode,
        root,
        totalBuffers: EMPTY_BUFFERS,
        rawJson: rawPayload,
      };
    }
  }

  throw new InvalidPlanError(
    'MySQL returned an unexpected EXPLAIN payload structure.',
  );
}
