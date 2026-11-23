import { InvalidPlanError } from '../../errors/domainErrors.js';
import {
  type BufferMetrics,
  EMPTY_BUFFERS,
  type ExecutionPlan,
  type PlanNode,
  type SortMetrics,
} from '../../models/executionPlan.js';
import type { ExplainMode } from '../../models/queryRequest.js';

type RawDuckDbRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawDuckDbRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(/^~/, '');
    if (/^\d+(?:\.\d+)?$/.test(cleaned)) {
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

function readStringValue(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    const parts = raw.filter((item): item is string => typeof item === 'string');
    if (parts.length > 0) {
      return parts.join(', ');
    }
  }
  return undefined;
}

function readStringArray(raw: unknown): readonly string[] | undefined {
  if (Array.isArray(raw)) {
    const parts = raw
      .filter((item): item is string => typeof item === 'string')
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parts = raw
      .split(/\r?\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

function unwrapDuckDbRoot(rawPayload: unknown): RawDuckDbRecord {
  if (typeof rawPayload === 'string') {
    const parsed: unknown = JSON.parse(rawPayload);
    return unwrapDuckDbRoot(parsed);
  }

  if (Array.isArray(rawPayload)) {
    if (rawPayload.length === 0) {
      throw new InvalidPlanError('DuckDB returned an empty EXPLAIN payload.');
    }

    // Handle `duckdb -json` output: [{ explain_key: "physical_plan", explain_value: "[{...}]" }]
    const explainEntry = rawPayload.find(
      (item): item is RawDuckDbRecord =>
        isRecord(item) &&
        typeof item['explain_key'] === 'string' &&
        (item['explain_key'] === 'physical_plan' ||
          item['explain_key'] === 'analyzed_plan' ||
          item['explain_key'] === 'logical_opt'),
    );
    if (explainEntry && explainEntry['explain_value'] !== undefined) {
      return unwrapDuckDbRoot(explainEntry['explain_value']);
    }

    const first = rawPayload[0];
    if (isRecord(first)) {
      return first;
    }
    throw new InvalidPlanError('DuckDB EXPLAIN array did not contain a plan object.');
  }

  if (!isRecord(rawPayload)) {
    throw new InvalidPlanError(
      'DuckDB returned an unexpected EXPLAIN JSON payload structure.',
    );
  }

  // Handle EXPLAIN ANALYZE top-level wrapper `{ query_name, latency, children: [...] }`
  if (
    !('name' in rawPayload) &&
    !('operator_name' in rawPayload) &&
    Array.isArray(rawPayload['children']) &&
    rawPayload['children'].length > 0 &&
    isRecord(rawPayload['children'][0])
  ) {
    return rawPayload['children'][0];
  }

  return rawPayload;
}

function extractRelationName(
  extraInfo: RawDuckDbRecord | undefined,
  nodeType: string,
): string | undefined {
  if (!extraInfo) {
    return undefined;
  }
  const direct =
    readStringValue(extraInfo['Table']) ??
    readStringValue(extraInfo['table']) ??
    readStringValue(extraInfo['File']) ??
    readStringValue(extraInfo['Path']) ??
    readStringValue(extraInfo['File(s)']);

  if (direct) {
    const parts = direct.split(/[\\/]/);
    return parts[parts.length - 1] || direct;
  }

  if (nodeType.includes('PARQUET') || nodeType.includes('CSV')) {
    const functionText = readStringValue(extraInfo['Function']);
    if (functionText) {
      return functionText;
    }
  }

  return undefined;
}

function parseDuckDbSpillFlag(extraInfo: RawDuckDbRecord | undefined): boolean {
  if (!extraInfo) {
    return false;
  }
  for (const [key, val] of Object.entries(extraInfo)) {
    const combined = `${key} ${readStringValue(val) ?? ''}`.toLowerCase();
    if (
      combined.includes('spill') ||
      combined.includes('out-of-core') ||
      combined.includes('external') ||
      combined.includes('temp_dir')
    ) {
      return true;
    }
  }
  return false;
}

function parseDuckDbNode(
  raw: RawDuckDbRecord,
  id: string,
  mode: ExplainMode,
  rootTimingMs: number | undefined,
): PlanNode {
  const rawName =
    readStringValue(raw['operator_name']) ??
    readStringValue(raw['operator_type']) ??
    readStringValue(raw['name']) ??
    readStringValue(raw['Node Type']);

  if (!rawName) {
    throw new InvalidPlanError(
      `DuckDB plan node "${id}" is missing a node name.`,
    );
  }

  const nodeType = rawName.trim().replace(/\s+/g, ' ');
  const extraInfo = isRecord(raw['extra_info']) ? raw['extra_info'] : undefined;

  const rawChildren = Array.isArray(raw['children']) ? raw['children'] : [];
  const children: PlanNode[] = rawChildren.map((child, idx) => {
    if (!isRecord(child)) {
      throw new InvalidPlanError(
        `DuckDB child node "${id}.${idx}" is not a valid object.`,
      );
    }
    return parseDuckDbNode(child, `${id}.${idx}`, mode, rootTimingMs);
  });

  const estimatedCard =
    readOptionalNumber(extraInfo?.['Estimated Cardinality']) ??
    readOptionalNumber(extraInfo?.['estimated_cardinality']) ??
    readOptionalNumber(raw['plan_rows']) ??
    readOptionalNumber(raw['operator_cardinality']) ??
    0;

  // DuckDB `operator_timing` in JSON profiling output is expressed in seconds.
  const operatorTimingSec = readOptionalNumber(raw['operator_timing']);
  const actualTotalTimeMs =
    operatorTimingSec !== undefined ? operatorTimingSec * 1000 : undefined;

  const actualRows =
    readOptionalNumber(raw['operator_cardinality']) ??
    readOptionalNumber(raw['actual_rows']);

  const scannedRows = readOptionalNumber(raw['operator_rows_scanned']);
  const rowsRemovedByFilter =
    scannedRows !== undefined && actualRows !== undefined
      ? Math.max(0, scannedRows - actualRows)
      : undefined;

  const inclusiveTimeMs =
    actualTotalTimeMs !== undefined
      ? actualTotalTimeMs +
        children.reduce((sum, child) => sum + (child.inclusiveTimeMs ?? 0), 0)
      : undefined;
  const exclusiveTimeMs = actualTotalTimeMs;
  const exclusiveTimePercent =
    exclusiveTimeMs !== undefined &&
    rootTimingMs !== undefined &&
    rootTimingMs > 0
      ? Math.min(100, (exclusiveTimeMs / rootTimingMs) * 100)
      : undefined;

  const filter =
    readStringValue(extraInfo?.['Filters']) ??
    readStringValue(extraInfo?.['Filter']) ??
    readStringValue(extraInfo?.['Expression']);

  const output =
    readStringArray(extraInfo?.['Projections']) ??
    readStringArray(extraInfo?.['Output']);

  const spilled = parseDuckDbSpillFlag(extraInfo);
  const sort: SortMetrics | undefined =
    nodeType.includes('ORDER') || nodeType.includes('TOP_N') || spilled
      ? {
          sortKey: readStringArray(extraInfo?.['Order By']),
          sortMethod: spilled ? 'external' : undefined,
          sortSpaceType: spilled ? 'Disk' : undefined,
        }
      : undefined;

  const childTempWritten = children.reduce(
    (sum, child) => sum + child.buffers.tempWrittenBlocks,
    0,
  );
  const buffers: BufferMetrics = {
    ...EMPTY_BUFFERS,
    tempWrittenBlocks: childTempWritten + (spilled ? 1 : 0),
  };

  return {
    id,
    nodeType,
    relationName: extractRelationName(extraInfo, nodeType),
    joinType: readStringValue(extraInfo?.['Join Type']),
    startupCost: 0,
    totalCost: Math.max(0, estimatedCard),
    planRows: Math.max(0, estimatedCard),
    planWidth: output ? Math.max(8, output.length * 16) : 32,
    actualTotalTimeMs,
    actualRows: mode === 'analyze' ? actualRows : undefined,
    actualLoops: mode === 'analyze' ? 1 : undefined,
    inclusiveTimeMs,
    exclusiveTimeMs,
    exclusiveTimePercent,
    filter,
    output,
    rowsRemovedByFilter,
    parallelAware: true,
    buffers,
    sort,
    children,
  };
}

function finalizeExecutionPercent(
  node: PlanNode,
  denominatorMs: number | undefined,
): PlanNode {
  const children = node.children.map((c) =>
    finalizeExecutionPercent(c, denominatorMs),
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
 * Parses DuckDB `EXPLAIN (FORMAT JSON)` and `EXPLAIN (ANALYZE, FORMAT JSON)` payloads
 * into QueryAutopsy's universal `ExecutionPlan` tree.
 */
export function parseDuckDbPlan(
  rawPayload: unknown,
  mode: ExplainMode,
): ExecutionPlan {
  const rootRecord = unwrapDuckDbRoot(rawPayload);
  const outerLatencySec =
    isRecord(rawPayload) && !Array.isArray(rawPayload)
      ? readOptionalNumber(rawPayload['latency'])
      : undefined;

  const executionTimeMs =
    mode === 'analyze' && outerLatencySec !== undefined
      ? outerLatencySec * 1000
      : undefined;

  const initialRoot = parseDuckDbNode(
    rootRecord,
    '0',
    mode,
    executionTimeMs,
  );
  const effectiveExecMs = executionTimeMs ?? initialRoot.inclusiveTimeMs;
  const root = finalizeExecutionPercent(initialRoot, effectiveExecMs);

  return {
    engine: 'duckdb',
    mode,
    root,
    executionTimeMs: effectiveExecMs,
    totalBuffers: root.buffers,
    rawJson: rawPayload,
  };
}
