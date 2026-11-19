import type { InspectionReport } from '../models/diagnostic.js';
import type { PlanNode } from '../models/executionPlan.js';

export interface PlanComparisonSummary {
  readonly previousInspectedAtIso: string;
  readonly previousMode: InspectionReport['mode'];
  readonly previousExecutionTimeMs?: number | undefined;
  readonly currentExecutionTimeMs?: number | undefined;
  readonly executionTimeDeltaMs?: number | undefined;
  readonly executionTimeDeltaPercent?: number | undefined;
  readonly previousCost: number;
  readonly currentCost: number;
  readonly costDeltaPercent: number;
  readonly previousSharedBlocks: number;
  readonly currentSharedBlocks: number;
  readonly blocksDeltaPercent?: number | undefined;
  readonly previousPlanSummary: string;
  readonly currentPlanSummary: string;
  readonly previousDiagnosticsCount: number;
  readonly currentDiagnosticsCount: number;
}

export function normalizeSqlFingerprint(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '').replace(/\s+/g, ' ');
}

export function summarizePlanChain(root: PlanNode, maxDepth = 3): string {
  const labels: string[] = [];
  let current: PlanNode | undefined = root;
  while (current && labels.length < maxDepth) {
    const suffix = current.relationName
      ? `(${current.relationName})`
      : current.indexName
        ? `(${current.indexName})`
        : '';
    labels.push(`${current.nodeType}${suffix}`);
    current = current.children[0];
  }
  return labels.join(' → ');
}

function percentDelta(prev: number, curr: number): number | undefined {
  if (prev <= 0) {
    return undefined;
  }
  return ((curr - prev) / prev) * 100;
}

export function computePlanDiff(
  previous: InspectionReport,
  current: InspectionReport,
): PlanComparisonSummary {
  const prevExec = previous.plan.executionTimeMs;
  const currExec = current.plan.executionTimeMs;
  const executionTimeDeltaMs =
    prevExec !== undefined && currExec !== undefined
      ? currExec - prevExec
      : undefined;
  const executionTimeDeltaPercent =
    prevExec !== undefined && currExec !== undefined
      ? percentDelta(prevExec, currExec)
      : undefined;

  const previousCost = previous.plan.root.totalCost;
  const currentCost = current.plan.root.totalCost;
  const costDeltaPercent = percentDelta(previousCost, currentCost) ?? 0;

  const previousSharedBlocks =
    previous.plan.totalBuffers.sharedHitBlocks +
    previous.plan.totalBuffers.sharedReadBlocks;
  const currentSharedBlocks =
    current.plan.totalBuffers.sharedHitBlocks +
    current.plan.totalBuffers.sharedReadBlocks;
  const blocksDeltaPercent = percentDelta(
    previousSharedBlocks,
    currentSharedBlocks,
  );

  return {
    previousInspectedAtIso: previous.inspectedAtIso,
    previousMode: previous.mode,
    previousExecutionTimeMs: prevExec,
    currentExecutionTimeMs: currExec,
    executionTimeDeltaMs,
    executionTimeDeltaPercent,
    previousCost,
    currentCost,
    costDeltaPercent,
    previousSharedBlocks,
    currentSharedBlocks,
    blocksDeltaPercent,
    previousPlanSummary: summarizePlanChain(previous.plan.root),
    currentPlanSummary: summarizePlanChain(current.plan.root),
    previousDiagnosticsCount: previous.diagnostics.length,
    currentDiagnosticsCount: current.diagnostics.length,
  };
}
