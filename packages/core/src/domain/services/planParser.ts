import { InvalidPlanError } from '../errors/domainErrors.js';
import type {
  BufferMetrics,
  ExecutionPlan,
  PlanNode,
  SortMetrics,
} from '../models/executionPlan.js';
import type { ExplainMode } from '../models/queryRequest.js';

type RawPlanRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawPlanRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalNumber(
  record: RawPlanRecord,
  key: string,
): number | undefined {
  const val = record[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

function readNumber(
  record: RawPlanRecord,
  key: string,
  fallback = 0,
): number {
  return readOptionalNumber(record, key) ?? fallback;
}

function readOptionalString(
  record: RawPlanRecord,
  key: string,
): string | undefined {
  const val = record[key];
  return typeof val === 'string' ? val : undefined;
}

function readOptionalStringArray(
  record: RawPlanRecord,
  key: string,
): readonly string[] | undefined {
  const val = record[key];
  if (!Array.isArray(val)) {
    return undefined;
  }
  return val.filter((item): item is string => typeof item === 'string');
}

function parseBuffers(record: RawPlanRecord): BufferMetrics {
  const sharedHitBlocks = readNumber(record, 'Shared Hit Blocks');
  const sharedReadBlocks = readNumber(record, 'Shared Read Blocks');
  const totalShared = sharedHitBlocks + sharedReadBlocks;

  return {
    sharedHitBlocks,
    sharedReadBlocks,
    sharedDirtiedBlocks: readNumber(record, 'Shared Dirtied Blocks'),
    sharedWrittenBlocks: readNumber(record, 'Shared Written Blocks'),
    localHitBlocks: readNumber(record, 'Local Hit Blocks'),
    localReadBlocks: readNumber(record, 'Local Read Blocks'),
    tempReadBlocks: readNumber(record, 'Temp Read Blocks'),
    tempWrittenBlocks: readNumber(record, 'Temp Written Blocks'),
    cacheHitRatio: totalShared > 0 ? sharedHitBlocks / totalShared : null,
  };
}

function parseSortMetrics(record: RawPlanRecord): SortMetrics | undefined {
  const sortKey = readOptionalStringArray(record, 'Sort Key');
  const sortMethod = readOptionalString(record, 'Sort Method');
  const sortSpaceUsedKb = readOptionalNumber(record, 'Sort Space Used');
  const sortSpaceType = readOptionalString(record, 'Sort Space Type');

  if (
    sortKey === undefined &&
    sortMethod === undefined &&
    sortSpaceUsedKb === undefined &&
    sortSpaceType === undefined
  ) {
    return undefined;
  }

  return {
    sortKey,
    sortMethod,
    sortSpaceUsedKb,
    sortSpaceType,
  };
}

function parseNode(
  rawNode: RawPlanRecord,
  id: string,
  rootExecutionTimeMs: number | undefined,
): PlanNode {
  const nodeType = readOptionalString(rawNode, 'Node Type');
  if (!nodeType) {
    throw new InvalidPlanError(
      `Plan node "${id}" is missing required "Node Type" field.`,
    );
  }

  const rawChildren = Array.isArray(rawNode['Plans']) ? rawNode['Plans'] : [];
  const children: PlanNode[] = rawChildren.map((child, idx) => {
    if (!isRecord(child)) {
      throw new InvalidPlanError(
        `Child node "${id}.${idx}" is not a valid object.`,
      );
    }
    return parseNode(child, `${id}.${idx}`, rootExecutionTimeMs);
  });

  const actualTotalTimeMs = readOptionalNumber(rawNode, 'Actual Total Time');
  const actualLoops = readOptionalNumber(rawNode, 'Actual Loops');

  let inclusiveTimeMs: number | undefined;
  let exclusiveTimeMs: number | undefined;
  let exclusiveTimePercent: number | undefined;

  if (actualTotalTimeMs !== undefined) {
    const loops = actualLoops ?? 1;
    inclusiveTimeMs = actualTotalTimeMs * loops;

    const childrenInclusiveSum = children.reduce(
      (sum, child) => sum + (child.inclusiveTimeMs ?? 0),
      0,
    );
    // Clamp to 0 because parallel workers can overlap wall-clock child times.
    exclusiveTimeMs = Math.max(0, inclusiveTimeMs - childrenInclusiveSum);

    const denominator =
      rootExecutionTimeMs && rootExecutionTimeMs > 0
        ? rootExecutionTimeMs
        : undefined;
    if (denominator !== undefined) {
      exclusiveTimePercent = Math.min(
        100,
        (exclusiveTimeMs / denominator) * 100,
      );
    }
  }

  return {
    id,
    nodeType,
    parentRelationship: readOptionalString(rawNode, 'Parent Relationship'),
    relationName: readOptionalString(rawNode, 'Relation Name'),
    schema: readOptionalString(rawNode, 'Schema'),
    alias: readOptionalString(rawNode, 'Alias'),
    indexName: readOptionalString(rawNode, 'Index Name'),
    joinType: readOptionalString(rawNode, 'Join Type'),
    startupCost: readNumber(rawNode, 'Startup Cost'),
    totalCost: readNumber(rawNode, 'Total Cost'),
    planRows: readNumber(rawNode, 'Plan Rows'),
    planWidth: readNumber(rawNode, 'Plan Width'),
    actualStartupTimeMs: readOptionalNumber(rawNode, 'Actual Startup Time'),
    actualTotalTimeMs,
    actualRows: readOptionalNumber(rawNode, 'Actual Rows'),
    actualLoops,
    inclusiveTimeMs,
    exclusiveTimeMs,
    exclusiveTimePercent,
    filter: readOptionalString(rawNode, 'Filter'),
    indexCond: readOptionalString(rawNode, 'Index Cond'),
    recheckCond: readOptionalString(rawNode, 'Recheck Cond'),
    hashCond: readOptionalString(rawNode, 'Hash Cond'),
    rowsRemovedByFilter: readOptionalNumber(rawNode, 'Rows Removed by Filter'),
    hashBatches: readOptionalNumber(rawNode, 'Hash Batches'),
    subplanName: readOptionalString(rawNode, 'Subplan Name'),
    exactHeapBlocks: readOptionalNumber(rawNode, 'Exact Heap Blocks'),
    lossyHeapBlocks: readOptionalNumber(rawNode, 'Lossy Heap Blocks'),
    parallelAware: rawNode['Parallel Aware'] === true,
    workersPlanned: readOptionalNumber(rawNode, 'Workers Planned'),
    workersLaunched: readOptionalNumber(rawNode, 'Workers Launched'),
    subplansRemoved: readOptionalNumber(rawNode, 'Subplans Removed'),
    output: readOptionalStringArray(rawNode, 'Output'),
    buffers: parseBuffers(rawNode),
    sort: parseSortMetrics(rawNode),
    children,
  };
}

function finalizeExclusivePercentages(
  node: PlanNode,
  denominatorMs: number | undefined,
): PlanNode {
  const children = node.children.map((child) =>
    finalizeExclusivePercentages(child, denominatorMs),
  );
  const exclusiveTimePercent =
    node.exclusiveTimeMs !== undefined &&
    denominatorMs !== undefined &&
    denominatorMs > 0
      ? Math.min(100, (node.exclusiveTimeMs / denominatorMs) * 100)
      : node.exclusiveTimePercent;

  return {
    ...node,
    exclusiveTimePercent,
    children,
  };
}

/**
 * Parses PostgreSQL `EXPLAIN (FORMAT JSON)` output into a strongly typed domain tree.
 * Note: PostgreSQL buffer counters on each node are cumulative across its subtree,
 * so the root node's buffer metrics equal total execution I/O.
 */
export function parsePostgreSqlPlan(
  rawPayload: unknown,
  mode: ExplainMode,
): ExecutionPlan {
  const envelope = Array.isArray(rawPayload) ? rawPayload[0] : rawPayload;
  if (!isRecord(envelope)) {
    throw new InvalidPlanError(
      'PostgreSQL returned an unexpected EXPLAIN payload structure.',
    );
  }

  const rawRoot = envelope['Plan'];
  if (!isRecord(rawRoot)) {
    throw new InvalidPlanError(
      'PostgreSQL EXPLAIN payload does not contain a root "Plan" object.',
    );
  }

  const planningTimeMs = readOptionalNumber(envelope, 'Planning Time');
  const executionTimeMs = readOptionalNumber(envelope, 'Execution Time');
  const rawPlanning = isRecord(envelope['Planning'])
    ? parseBuffers(envelope['Planning'])
    : undefined;

  const initialRoot = parseNode(rawRoot, '0', executionTimeMs);
  const denominator =
    executionTimeMs && executionTimeMs > 0
      ? executionTimeMs
      : initialRoot.inclusiveTimeMs;
  const root = finalizeExclusivePercentages(initialRoot, denominator);

  return {
    mode,
    root,
    planningTimeMs,
    executionTimeMs,
    planningBuffers: rawPlanning,
    totalBuffers: root.buffers,
    rawJson: rawPayload,
  };
}
